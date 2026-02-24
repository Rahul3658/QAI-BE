/**
 * VoiceAssistantService - Core service for voice assistant functionality
 * 
 * Handles:
 * - Command processing with Gemini API
 * - Context plugin management
 * - Function execution
 * - Conversation history
 * - Response generation
 */

const { getGeminiClient } = require('./geminiClient');
const GenerateQuestionsContext = require('./voiceAssistant/contexts/GenerateQuestionsContext');
const SMEVariationReviewContext = require('./voiceAssistant/contexts/SMEVariationReviewContext');
const ModeratorCategorizationContext = require('./voiceAssistant/contexts/ModeratorCategorizationContext');
const MetadataQueryHandler = require('./voiceAssistant/MetadataQueryHandler');
const ErrorMaskingService = require('./voiceAssistant/ErrorMaskingService');

class VoiceAssistantService {
  constructor() {
    this.geminiClient = getGeminiClient();
    this.contextPlugins = new Map();
    this.metadataQueryHandler = new MetadataQueryHandler();
    this.errorMaskingService = new ErrorMaskingService();
    
    // Register default contexts
    this._registerDefaultContexts();
  }

  /**
   * Register default context plugins
   * @private
   */
  _registerDefaultContexts() {
    const generateQuestionsContext = new GenerateQuestionsContext();
    this.registerContextPlugin(generateQuestionsContext.getName(), generateQuestionsContext);
    
    const smeVariationReviewContext = new SMEVariationReviewContext();
    this.registerContextPlugin(smeVariationReviewContext.getName(), smeVariationReviewContext);

    const moderatorCategorizationContext = new ModeratorCategorizationContext();
    this.registerContextPlugin(moderatorCategorizationContext.getName(), moderatorCategorizationContext);
  }

  /**
   * Register a context plugin
   * @param {string} contextName - Unique context identifier
   * @param {ContextPlugin} plugin - Plugin instance
   */
  registerContextPlugin(contextName, plugin) {
    this.contextPlugins.set(contextName, plugin);
    console.log(`✅ Registered voice assistant context: ${contextName}`);
  }

  /**
   * Get a context plugin
   * @param {string} contextName - Context identifier
   * @returns {ContextPlugin|null} Plugin instance or null
   */
  getContextPlugin(contextName) {
    return this.contextPlugins.get(contextName) || null;
  }

  /**
   * Get all registered contexts
   * @returns {Array} Array of context metadata
   */
  getAllContexts() {
    const contexts = [];
    for (const [name, plugin] of this.contextPlugins.entries()) {
      contexts.push({
        name,
        ...plugin.getMetadata()
      });
    }
    return contexts;
  }

  /**
   * Process a voice command
   * @param {string} transcript - User's spoken text
   * @param {string} contextName - Workflow context identifier
   * @param {Object} formState - Current UI state
   * @param {Array} conversationHistory - Previous exchanges
   * @returns {Promise<Object>} Response with actions and updated state
   */
  async processCommand(transcript, contextName, formState, conversationHistory = []) {
    try {
      console.log(`🎤 Processing voice command: "${transcript}" (context: ${contextName})`);
      
      // Get context plugin
      const plugin = this.getContextPlugin(contextName);
      if (!plugin) {
        throw new Error(`Context "${contextName}" not found`);
      }

      // Check if this is a metadata query first
      const metadataQuery = this.metadataQueryHandler.detectQuery(transcript);
      if (metadataQuery && metadataQuery.confidence >= 0.8) {
        console.log(`📊 Detected metadata query:`, metadataQuery);
        
        const queryResult = await this.metadataQueryHandler.executeQuery(
          metadataQuery,
          formState,
          plugin
        );

        if (queryResult.success) {
          return {
            success: true,
            response: queryResult.response,
            actions: [{
              function: 'metadata_query',
              parameters: metadataQuery,
              result: queryResult
            }],
            updatedState: formState,
            suggestions: {
              items: [],
              text: null
            },
            conversationContext: {
              lastAction: 'metadata_query',
              lastField: null,
              workflowState: queryResult.data?.workflowState || this._analyzeWorkflowState(formState, plugin)
            },
            usage: { totalTokens: 0 }
          };
        }
      }

      // Get function definitions and system prompt
      const functions = plugin.getFunctionDefinitions();
      const systemPrompt = plugin.getSystemPrompt(formState);
      
      // Build prompt with system instructions and user command
      const prompt = `${systemPrompt}

User command: "${transcript}"

CRITICAL: You MUST call at least one function to handle this command. Analyze the user's command and call the appropriate function(s). Even if the command is vague, make your best interpretation and call a function. Do NOT respond with just text - ALWAYS call a function.`;

      // Call Gemini API with function calling
      const response = await this.geminiClient.generateWithFunctions(
        prompt,
        functions,
        conversationHistory
      );

      console.log(`🤖 Gemini response:`, {
        text: response.response,
        functionCalls: response.functionCalls?.length || 0,
        tokens: response.usage.totalTokens
      });

      // Execute function calls
      const actions = [];
      let updatedState = { ...formState };
      let hasErrors = false;

      for (const functionCall of response.functionCalls || []) {
        console.log(`⚙️  Executing function: ${functionCall.name}`, functionCall.args);
        
        const result = await plugin.executeFunction(
          functionCall.name,
          functionCall.args,
          updatedState
        );

        actions.push({
          function: functionCall.name,
          parameters: functionCall.args,
          result
        });

        // Update state if function succeeded
        if (result.success && result.result) {
          updatedState = { ...updatedState, ...result.result };
        } else {
          hasErrors = true;
        }
      }

      // Generate natural language response
      let finalResponse = response.response;
      
      // If no text response but we have function results, generate one
      if (!finalResponse && actions.length > 0) {
        const successfulActions = actions.filter(a => a.result.success);
        const failedActions = actions.filter(a => !a.result.success);
        
        if (successfulActions.length > 0) {
          finalResponse = successfulActions.map(a => a.result.message).join('. ');
        }
        
        if (failedActions.length > 0) {
          const errorMessages = failedActions.map(a => a.result.message).join('. ');
          finalResponse = finalResponse ? `${finalResponse}. However, ${errorMessages}` : errorMessages;
        }
      }

      // Generate suggestions for next actions
      const lastAction = actions[actions.length - 1]?.function || null;
      const suggestions = await this._generateSuggestions(updatedState, plugin, lastAction);
      const suggestionText = this._formatSuggestionsAsText(suggestions);

      return {
        success: !hasErrors,
        response: finalResponse || 'Command processed',
        actions,
        updatedState,
        suggestions: {
          items: suggestions,
          text: suggestionText
        },
        conversationContext: {
          lastAction,
          lastField: this._extractLastField(actions),
          workflowState: this._analyzeWorkflowState(updatedState, plugin)
        },
        usage: response.usage
      };

    } catch (error) {
      console.error('❌ Voice command processing error:', error);
      
      // Mask error with user-friendly message
      const maskedError = this.errorMaskingService.maskError(error, {
        transcript,
        contextName,
        timestamp: Date.now()
      });
      
      return {
        success: false,
        response: maskedError.userMessage,
        actions: [],
        updatedState: formState,
        error: {
          code: maskedError.technicalDetails.code,
          message: maskedError.userMessage,
          retryable: maskedError.retryable
        }
      };
    }
  }

  /**
   * Get function definitions for a context
   * @param {string} contextName - Context identifier
   * @returns {Array} Function definitions
   */
  getContextFunctions(contextName) {
    const plugin = this.getContextPlugin(contextName);
    if (!plugin) {
      throw new Error(`Context "${contextName}" not found`);
    }
    return plugin.getFunctionDefinitions();
  }

  /**
   * Extract last modified field from actions
   * @private
   */
  _extractLastField(actions) {
    if (actions.length === 0) return null;
    
    const lastAction = actions[actions.length - 1];
    const functionName = lastAction.function;
    
    // Map function names to field names
    const fieldMap = {
      'set_subject': 'subject',
      'set_topic': 'topic',
      'set_num_variations': 'num_variations',
      'set_language': 'language',
      'select_template': 'template',
      'select_question': 'question',
      'select_sub_question': 'sub_question'
    };
    
    return fieldMap[functionName] || null;
  }

  /**
   * Generate suggestions for next actions
   * @private
   * @param {Object} formState - Current form state
   * @param {ContextPlugin} plugin - Context plugin instance
   * @param {string|null} lastAction - Last executed function name
   * @returns {Promise<Array>} Array of suggestion objects
   */
  async _generateSuggestions(formState, plugin, lastAction) {
    try {
      // Call plugin's getSuggestedNextActions method
      const suggestions = plugin.getSuggestedNextActions(formState, lastAction);
      
      // Sort by priority (1=high, 2=medium, 3=low)
      suggestions.sort((a, b) => a.priority - b.priority);
      
      // Return top 3-4 suggestions
      return suggestions.slice(0, 4);
    } catch (error) {
      console.error('Error generating suggestions:', error);
      // Return empty array on error
      return [];
    }
  }

  /**
   * Format suggestions as natural language text for TTS
   * @private
   * @param {Array} suggestions - Array of suggestion objects
   * @returns {string|null} Formatted suggestion text
   */
  _formatSuggestionsAsText(suggestions) {
    if (!suggestions || suggestions.length === 0) return null;
    
    const suggestionTexts = suggestions.map(s => s.text);
    
    if (suggestionTexts.length === 1) {
      return `What would you like to do next? You can ${suggestionTexts[0]}.`;
    } else if (suggestionTexts.length === 2) {
      return `What would you like to do next? You can ${suggestionTexts[0]}, or ${suggestionTexts[1]}.`;
    } else {
      const last = suggestionTexts.pop();
      return `What would you like to do next? You can ${suggestionTexts.join(', ')}, or ${last}.`;
    }
  }

  /**
   * Analyze workflow state to determine phase and completion
   * @private
   * @param {Object} formState - Current form state
   * @param {ContextPlugin} plugin - Context plugin instance
   * @returns {Object} Workflow state analysis
   */
  _analyzeWorkflowState(formState, plugin) {
    const contextName = plugin.getName();
    
    if (contextName === 'generate-questions') {
      return this._analyzeGenerateQuestionsState(formState);
    } else if (contextName === 'sme-variation-review') {
      return this._analyzeSMEReviewState(formState);
    }
    
    return {
      phase: 'unknown',
      completionPercent: 0,
      missingFields: []
    };
  }

  /**
   * Analyze Generate Questions workflow state
   * @private
   */
  _analyzeGenerateQuestionsState(formState) {
    // Required fields that must be completed
    const requiredFields = [
      { 
        key: 'selectedTemplate', 
        name: 'template',
        isComplete: (state) => Boolean(state.selectedTemplate)
      },
      { 
        key: 'paperName', 
        name: 'paper name',
        isComplete: (state) => Boolean(state.paperName && String(state.paperName).trim().length > 0)
      },
      { 
        key: 'selectedLanguage', 
        name: 'language',
        isComplete: (state) => {
          if (!state.selectedLanguage) return false;
          const lang = String(state.selectedLanguage).toLowerCase();
          if (lang !== 'english') return true;
          return Boolean(state.languageConfirmed);
        }
      },
      { 
        key: 'selectedQuestion', 
        name: 'question',
        isComplete: (state) => Boolean(state.selectedQuestion || state.selectedQuestionNumber)
      },
      { 
        key: 'subject', 
        name: 'subject',
        isComplete: (state) => Boolean(state.subject && String(state.subject).trim().length > 0)
      },
      { 
        key: 'chapters', 
        name: 'topics/chapters',
        isComplete: (state) => Boolean(state.chapters && String(state.chapters).trim().length > 0)
      },
      { 
        key: 'num_variations', 
        name: 'number of variations', 
        isComplete: (state) => Number(state.num_variations) >= 40
      }
    ];
    
    // Optional fields that enhance the generation
    const optionalFields = [];
    
    // Check for sub-question requirement
    const hasSubQuestions = formState.selectedQuestion?.sub_questions?.length > 0 ||
                           formState.selectedQuestion?.subquestions?.length > 0;
    if (hasSubQuestions) {
      requiredFields.push({ 
        key: 'selectedSubQuestion', 
        name: 'sub-question',
        isComplete: (state) => Boolean(state.selectedSubQuestion)
      });
    }
    
    // Calculate required fields completion
    const missingRequiredFields = [];
    let requiredCompletedCount = 0;
    
    for (const field of requiredFields) {
      const isComplete = field.isComplete 
        ? field.isComplete(formState) 
        : Boolean(formState[field.key]);
      
      if (isComplete) {
        requiredCompletedCount++;
      } else {
        missingRequiredFields.push(field.name);
      }
    }
    
    // Calculate optional fields completion
    const missingOptionalFields = [];
    let optionalCompletedCount = 0;
    
    for (const field of optionalFields) {
      const value = formState[field.key];
      if (value) {
        optionalCompletedCount++;
      } else {
        missingOptionalFields.push(field.name);
      }
    }
    
    // Calculate overall completion percentage
    // All fields are now required (100%)
    const completionPercent = Math.round((requiredCompletedCount / requiredFields.length) * 100);
    
    // Determine phase
    let phase = 'template_selection';
    if (formState.selectedTemplate && !formState.paperName) {
      phase = 'paper_creation';
    } else if (formState.paperName && !(formState.selectedQuestion || formState.selectedQuestionNumber)) {
      phase = 'question_selection';
    } else if (formState.selectedQuestion && missingRequiredFields.length > 0) {
      phase = 'field_completion';
    } else if (missingRequiredFields.length === 0) {
      phase = 'ready_to_generate';
    }
    
    // Determine next milestone
    let nextMilestone;
    if (missingRequiredFields.length > 0) {
      nextMilestone = `Complete ${missingRequiredFields[0]}`;
    } else {
      nextMilestone = 'Generate variations';
    }
    
    return {
      phase,
      completionPercent,
      missingFields: [...missingRequiredFields, ...missingOptionalFields],
      missingRequiredFields,
      missingOptionalFields,
      nextMilestone
    };
  }

  /**
   * Analyze SME Review workflow state
   * @private
   */
  _analyzeSMEReviewState(formState) {
    if (!formState.expandedSubQuestionId) {
      return {
        phase: 'sub_question_selection',
        completionPercent: 0,
        missingFields: ['expanded sub-question'],
        nextMilestone: 'Expand a sub-question'
      };
    }
    
    const variations = formState.availableVariations || [];
    const selectedCount = variations.filter(v => 
      v.status === 'selected_by_sme' || v.status === 'approved'
    ).length;
    
    const completionPercent = Math.min(Math.round((selectedCount / 40) * 100), 100);
    
    let phase = 'variation_selection';
    const missingFields = [];
    
    if (selectedCount < 40) {
      missingFields.push(`${40 - selectedCount} more variations`);
    } else if (formState.sendToModeratorVisible) {
      phase = 'ready_to_submit';
    }
    
    return {
      phase,
      completionPercent,
      missingFields,
      nextMilestone: selectedCount >= 40 ? 'Send to moderator' : `Select ${40 - selectedCount} more variations`
    };
  }

  /**
   * Generate user-friendly error response
   * @private
   */
  _generateErrorResponse(error) {
    const errorMessages = {
      'ECONNABORTED': 'Request timeout. Please try again.',
      'ENOTFOUND': 'Network error. Please check your connection.',
      'RATE_LIMIT_EXCEEDED': 'Too many requests. Please wait a moment.',
      'PROCESSING_ERROR': 'Sorry, I encountered an error processing your command.'
    };
    
    return errorMessages[error.code] || 'Sorry, something went wrong. Please try again.';
  }

  /**
   * Check if error is retryable
   * @private
   */
  _isRetryableError(error) {
    const retryableCodes = ['ECONNABORTED', 'ENOTFOUND', 'ETIMEDOUT', 'RATE_LIMIT_EXCEEDED'];
    return retryableCodes.includes(error.code);
  }
}

// Singleton instance
let voiceAssistantServiceInstance = null;

/**
 * Get or create the singleton VoiceAssistantService instance
 * @returns {VoiceAssistantService} Singleton instance
 */
function getVoiceAssistantService() {
  if (!voiceAssistantServiceInstance) {
    voiceAssistantServiceInstance = new VoiceAssistantService();
  }
  return voiceAssistantServiceInstance;
}

module.exports = {
  VoiceAssistantService,
  getVoiceAssistantService
};
