/**
 * MetadataQueryHandler - Handles metadata queries about available data and workflow state
 * 
 * Processes queries like:
 * - "how many templates are available"
 * - "what should I do next"
 * - "what's my progress"
 * - "what questions are available"
 */

class MetadataQueryHandler {
  constructor() {
    // Query patterns with confidence scores
    this.queryPatterns = [
      // Count queries
      {
        type: 'count',
        patterns: [
          /how many (.*?) (?:are|is) (?:available|there)/i,
          /what(?:'s| is) the (?:number|count) of (.*)/i,
          /count (?:of |the )?(.*)/i
        ],
        confidence: 0.9
      },
      // List queries
      {
        type: 'list',
        patterns: [
          /what (.*?) (?:are|is) available/i,
          /show (?:me )?(?:all |the )?(.*)/i,
          /list (?:all |the )?(.*)/i,
          /tell me (?:about |the )?(.*)/i
        ],
        confidence: 0.85
      },
      // Next action queries
      {
        type: 'next',
        patterns: [
          /what should i do next/i,
          /what(?:'s| is) next/i,
          /what do i need to do/i,
          /what(?:'s| is) the next step/i,
          /what comes next/i
        ],
        confidence: 0.9
      },
      // Status/Progress queries
      {
        type: 'status',
        patterns: [
          /what(?:'s| is) my (?:progress|status)/i,
          /how (?:far|much) (?:have i|am i)/i,
          /am i (?:done|ready|complete)/i,
          /what(?:'s| is) my completion/i,
          /show (?:me )?(?:my )?progress/i
        ],
        confidence: 0.85
      }
    ];

    // Target extraction patterns
    this.targetPatterns = {
      templates: /template/i,
      questions: /question/i,
      papers: /paper/i,
      variations: /variation/i,
      subQuestions: /sub[- ]?question/i
    };
  }

  /**
   * Detect if transcript is a metadata query
   * @param {string} transcript - User's spoken text
   * @returns {Object|null} Query detection result or null
   */
  detectQuery(transcript) {
    if (!transcript || typeof transcript !== 'string') {
      return null;
    }

    const normalizedTranscript = transcript.trim().toLowerCase();

    // Try to match against query patterns
    for (const queryDef of this.queryPatterns) {
      for (const pattern of queryDef.patterns) {
        const match = normalizedTranscript.match(pattern);
        if (match) {
          // Extract target from the match or transcript
          const target = this._extractTarget(match[1] || transcript);
          
          return {
            type: queryDef.type,
            target: target,
            confidence: queryDef.confidence,
            originalTranscript: transcript
          };
        }
      }
    }

    return null;
  }

  /**
   * Extract target entity from text
   * @private
   * @param {string} text - Text to extract target from
   * @returns {string} Target entity name
   */
  _extractTarget(text) {
    if (!text) return 'workflow';

    const normalizedText = text.toLowerCase();

    for (const [target, pattern] of Object.entries(this.targetPatterns)) {
      if (pattern.test(normalizedText)) {
        return target;
      }
    }

    return 'workflow';
  }

  /**
   * Execute metadata query
   * @param {Object} queryInfo - Query information from detectQuery
   * @param {Object} formState - Current form state
   * @param {Object} plugin - Current context plugin
   * @returns {Promise<Object>} Query result with response text
   */
  async executeQuery(queryInfo, formState, plugin) {
    try {
      const { type, target } = queryInfo;

      switch (type) {
        case 'count':
          return await this._executeCountQuery(target, formState, plugin);
        
        case 'list':
          return await this._executeListQuery(target, formState, plugin);
        
        case 'next':
          return await this._executeNextQuery(formState, plugin);
        
        case 'status':
          return await this._executeStatusQuery(formState, plugin);
        
        default:
          return {
            success: false,
            response: "I'm not sure what you're asking about. Can you rephrase that?"
          };
      }
    } catch (error) {
      console.error('Error executing metadata query:', error);
      return {
        success: false,
        response: "I encountered an error processing your query. Please try again."
      };
    }
  }

  /**
   * Execute count query
   * @private
   */
  async _executeCountQuery(target, formState, plugin) {
    let count = 0;
    let itemName = target;
    let items = [];

    switch (target) {
      case 'templates':
        items = formState.availableTemplates || [];
        count = items.length;
        itemName = count === 1 ? 'template' : 'templates';
        break;
      
      case 'questions':
        if (formState.selectedTemplate?.questions) {
          items = formState.selectedTemplate.questions;
          count = items.length;
        }
        itemName = count === 1 ? 'question' : 'questions';
        break;
      
      case 'subQuestions':
        if (formState.selectedQuestion?.sub_questions) {
          items = formState.selectedQuestion.sub_questions;
          count = items.length;
        } else if (formState.selectedQuestion?.subquestions) {
          items = formState.selectedQuestion.subquestions;
          count = items.length;
        }
        itemName = count === 1 ? 'sub-question' : 'sub-questions';
        break;
      
      case 'variations':
        items = formState.availableVariations || [];
        count = items.length;
        itemName = count === 1 ? 'variation' : 'variations';
        break;
      
      default:
        return {
          success: false,
          response: `I'm not sure how to count ${target}. Can you be more specific?`
        };
    }

    // Build response with count and brief list
    let response = `There ${count === 1 ? 'is' : 'are'} ${count} ${itemName} available`;
    
    if (count > 0 && count <= 5) {
      // List items if there are 5 or fewer
      const itemNames = this._extractItemNames(items, target);
      if (itemNames.length > 0) {
        response += `: ${this._formatList(itemNames)}`;
      }
    } else if (count > 5) {
      response += `. Would you like me to list them?`;
    }

    return {
      success: true,
      response,
      data: {
        count,
        items,
        target
      }
    };
  }

  /**
   * Execute list query
   * @private
   */
  async _executeListQuery(target, formState, plugin) {
    let items = [];
    let itemName = target;

    switch (target) {
      case 'templates':
        items = formState.availableTemplates || [];
        itemName = 'templates';
        break;
      
      case 'questions':
        if (formState.selectedTemplate?.questions) {
          items = formState.selectedTemplate.questions;
        }
        itemName = 'questions';
        break;
      
      case 'subQuestions':
        if (formState.selectedQuestion?.sub_questions) {
          items = formState.selectedQuestion.sub_questions;
        } else if (formState.selectedQuestion?.subquestions) {
          items = formState.selectedQuestion.subquestions;
        }
        itemName = 'sub-questions';
        break;
      
      default:
        return {
          success: false,
          response: `I'm not sure what ${target} you want to see. Can you be more specific?`
        };
    }

    if (items.length === 0) {
      return {
        success: true,
        response: `There are no ${itemName} available at the moment.`
      };
    }

    const itemNames = this._extractItemNames(items, target);
    const response = `Here are the available ${itemName}: ${this._formatList(itemNames)}`;

    return {
      success: true,
      response,
      data: {
        items,
        target
      }
    };
  }

  /**
   * Execute next action query
   * @private
   */
  async _executeNextQuery(formState, plugin) {
    // Get suggested next actions from plugin
    const suggestions = plugin.getSuggestedNextActions(formState, null);
    
    if (!suggestions || suggestions.length === 0) {
      return {
        success: true,
        response: "You're all set! You can now generate your variations."
      };
    }

    // Get the highest priority suggestion
    const nextAction = suggestions[0];
    
    let response = `Next, you should ${nextAction.text}`;
    
    // Add additional context if available
    if (suggestions.length > 1) {
      response += `. After that, you can ${suggestions[1].text}`;
    }

    return {
      success: true,
      response,
      data: {
        suggestions
      }
    };
  }

  /**
   * Execute status/progress query
   * @private
   */
  async _executeStatusQuery(formState, plugin) {
    // Analyze workflow state using the service's existing logic
    const contextName = plugin.getName();
    let workflowState;

    if (contextName === 'generate-questions') {
      workflowState = this._analyzeGenerateQuestionsState(formState);
    } else if (contextName === 'sme-variation-review') {
      workflowState = this._analyzeSMEReviewState(formState);
    } else {
      return {
        success: true,
        response: "I'm tracking your progress. Keep going!"
      };
    }

    const { completionPercent, missingRequiredFields, nextMilestone } = workflowState;

    let response = `You are ${completionPercent}% complete`;

    if (missingRequiredFields && missingRequiredFields.length > 0) {
      response += `. You still need to complete: ${this._formatList(missingRequiredFields)}`;
    }

    if (nextMilestone) {
      response += `. Next step: ${nextMilestone}`;
    }

    if (completionPercent === 100) {
      response = "You're all done! You can now generate your variations.";
    }

    return {
      success: true,
      response,
      data: {
        workflowState
      }
    };
  }

  /**
   * Analyze Generate Questions workflow state
   * @private
   */
  _analyzeGenerateQuestionsState(formState) {
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

    const hasSubQuestions = formState.selectedQuestion?.sub_questions?.length > 0 ||
                           formState.selectedQuestion?.subquestions?.length > 0;
    if (hasSubQuestions) {
      requiredFields.push({ 
        key: 'selectedSubQuestion', 
        name: 'sub-question',
        isComplete: (state) => Boolean(state.selectedSubQuestion)
      });
    }

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

    const completionPercent = Math.round((requiredCompletedCount / requiredFields.length) * 100);
    
    let nextMilestone;
    if (missingRequiredFields.length > 0) {
      nextMilestone = `Complete ${missingRequiredFields[0]}`;
    } else {
      nextMilestone = 'Generate variations';
    }

    return {
      completionPercent,
      missingRequiredFields,
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
        completionPercent: 0,
        missingRequiredFields: ['expanded sub-question'],
        nextMilestone: 'Expand a sub-question'
      };
    }
    
    const variations = formState.availableVariations || [];
    const selectedCount = variations.filter(v => 
      v.status === 'selected_by_sme' || v.status === 'approved'
    ).length;
    
    const completionPercent = Math.min(Math.round((selectedCount / 40) * 100), 100);
    const missingRequiredFields = [];
    
    if (selectedCount < 40) {
      missingRequiredFields.push(`${40 - selectedCount} more variations`);
    }

    return {
      completionPercent,
      missingRequiredFields,
      nextMilestone: selectedCount >= 40 ? 'Send to moderator' : `Select ${40 - selectedCount} more variations`
    };
  }

  /**
   * Extract item names from array
   * @private
   */
  _extractItemNames(items, target) {
    if (!Array.isArray(items)) return [];

    return items.map(item => {
      if (typeof item === 'string') return item;
      
      // Try common name fields
      return item.template_name || 
             item.name || 
             item.question_text || 
             item.text ||
             item.title ||
             'Unnamed item';
    }).filter(name => name && name !== 'Unnamed item');
  }

  /**
   * Format array as natural language list
   * @private
   */
  _formatList(items) {
    if (!Array.isArray(items) || items.length === 0) {
      return '';
    }

    if (items.length === 1) {
      return items[0];
    }

    if (items.length === 2) {
      return `${items[0]} and ${items[1]}`;
    }

    const allButLast = items.slice(0, -1);
    const last = items[items.length - 1];
    return `${allButLast.join(', ')}, and ${last}`;
  }
}

module.exports = MetadataQueryHandler;
