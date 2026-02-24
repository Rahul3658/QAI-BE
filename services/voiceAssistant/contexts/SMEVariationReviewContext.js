/**
 * SMEVariationReviewContext - Voice assistant context for SME variation review workflow
 * 
 * Provides 15 functions for controlling the SME Papers review interface:
 * - Variation selection/unselection
 * - AI recommendation management
 * - Navigation through variations
 * - Query variation status and counts
 * - Sub-question expansion/collapse
 * - Moderator submission
 */

const ContextPlugin = require('../ContextPlugin');

class SMEVariationReviewContext extends ContextPlugin {
  getName() {
    return 'sme-variation-review';
  }

  getFunctionDefinitions() {
    return [
      {
        name: 'select_variation',
        description: 'Select a single variation by its number. User can say "select variation 5" or just "select 5".',
        parameters: {
          type: 'object',
          properties: {
            variation_number: {
              type: 'integer',
              description: 'Variation number to select (e.g., 1, 2, 3)'
            }
          },
          required: ['variation_number']
        }
      },
      {
        name: 'unselect_variation',
        description: 'Unselect/reject a single variation by its number. User can say "unselect variation 5" or "reject 5".',
        parameters: {
          type: 'object',
          properties: {
            variation_number: {
              type: 'integer',
              description: 'Variation number to unselect (e.g., 1, 2, 3)'
            }
          },
          required: ['variation_number']
        }
      },
      {
        name: 'select_variations_batch',
        description: 'Select multiple variations at once. User can say "select variations 1, 2, and 3".',
        parameters: {
          type: 'object',
          properties: {
            variation_numbers: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Array of variation numbers to select'
            }
          },
          required: ['variation_numbers']
        }
      },
      {
        name: 'set_ai_suggestion_count',
        description: 'Set the number of AI suggestions to request. User can say "set AI suggestions to 5".',
        parameters: {
          type: 'object',
          properties: {
            count: {
              type: 'integer',
              minimum: 1,
              description: 'Number of AI suggestions to request'
            }
          },
          required: ['count']
        }
      },
      {
        name: 'trigger_ai_suggestions',
        description: 'Trigger the AI recommendation process. User can say "get AI suggestions" or "trigger AI recommendations".',
        parameters: {
          type: 'object',
          properties: {
            count: {
              type: 'integer',
              minimum: 1,
              description: 'Optional: number of suggestions to get (uses current count if not specified)'
            }
          }
        }
      },
      {
        name: 'apply_ai_recommendations',
        description: 'Apply all AI-recommended variations. User can say "apply AI recommendations" or "accept suggestions".',
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'cancel_ai_recommendations',
        description: 'Cancel/dismiss AI recommendations without applying. User can say "cancel AI recommendations" or "reject suggestions".',
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'send_to_moderator',
        description: 'Send the paper to moderator for final review. User can say "send to moderator".',
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'expand_sub_question',
        description: 'Expand a sub-question to view its variations. User can say "expand sub-question 1".',
        parameters: {
          type: 'object',
          properties: {
            sub_question_number: {
              type: 'string',
              description: 'Sub-question number or identifier'
            }
          },
          required: ['sub_question_number']
        }
      },
      {
        name: 'collapse_sub_question',
        description: 'Collapse the currently expanded sub-question. User can say "collapse sub-question" or "close".',
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'navigate_next_variation',
        description: 'Navigate to the next variation in the list. User can say "next variation" or "next".',
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'navigate_previous_variation',
        description: 'Navigate to the previous variation in the list. User can say "previous variation" or "previous".',
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'show_variation',
        description: 'Scroll to and highlight a specific variation. User can say "show variation 10".',
        parameters: {
          type: 'object',
          properties: {
            variation_number: {
              type: 'integer',
              description: 'Variation number to show'
            }
          },
          required: ['variation_number']
        }
      },
      {
        name: 'query_variation_counts',
        description: 'Get counts of variations by status. User can say "how many selected" or "how many pending".',
        parameters: {
          type: 'object',
          properties: {
            status_type: {
              type: 'string',
              enum: ['selected', 'pending', 'total', 'unselected'],
              description: 'Type of count to query'
            }
          },
          required: ['status_type']
        }
      },
      {
        name: 'query_variation_status',
        description: 'Get the status of a specific variation. User can say "what is the status of variation 5".',
        parameters: {
          type: 'object',
          properties: {
            variation_number: {
              type: 'integer',
              description: 'Variation number to query'
            }
          },
          required: ['variation_number']
        }
      }
    ];
  }

  async executeFunction(functionName, parameters, formState) {
    try {
      switch (functionName) {
        case 'select_variation':
          return await this._selectVariation(parameters, formState);
        
        case 'unselect_variation':
          return await this._unselectVariation(parameters, formState);
        
        case 'select_variations_batch':
          return await this._selectVariationsBatch(parameters, formState);
        
        case 'set_ai_suggestion_count':
          return this._setAISuggestionCount(parameters, formState);
        
        case 'trigger_ai_suggestions':
          return this._triggerAISuggestions(parameters, formState);
        
        case 'apply_ai_recommendations':
          return this._applyAIRecommendations(parameters, formState);
        
        case 'cancel_ai_recommendations':
          return this._cancelAIRecommendations(parameters, formState);
        
        case 'send_to_moderator':
          return this._sendToModerator(parameters, formState);
        
        case 'expand_sub_question':
          return this._expandSubQuestion(parameters, formState);
        
        case 'collapse_sub_question':
          return this._collapseSubQuestion(parameters, formState);
        
        case 'navigate_next_variation':
          return this._navigateNextVariation(parameters, formState);
        
        case 'navigate_previous_variation':
          return this._navigatePreviousVariation(parameters, formState);
        
        case 'show_variation':
          return this._showVariation(parameters, formState);
        
        case 'query_variation_counts':
          return this._queryVariationCounts(parameters, formState);
        
        case 'query_variation_status':
          return this._queryVariationStatus(parameters, formState);
        
        default:
          return {
            success: false,
            error: 'Unknown function',
            message: `Function ${functionName} not found`
          };
      }
    } catch (error) {
      console.error(`Error executing ${functionName}:`, error);
      return {
        success: false,
        error: error.code || 'EXECUTION_ERROR',
        message: error.message || 'An error occurred while executing the command',
        retryable: this._isRetryableError(error)
      };
    }
  }


  // Function implementations
  async _selectVariation(parameters, formState) {
    const { variation_number } = parameters;
    const { expandedSubQuestionId, availableVariations } = formState;

    console.log('🔍 Selecting variation:', { variation_number, expandedSubQuestionId, availableVariationsCount: availableVariations?.length });

    if (!expandedSubQuestionId) {
      return {
        success: false,
        error: 'No sub-question expanded',
        message: 'Please expand a sub-question first to select variations'
      };
    }

    if (!availableVariations || availableVariations.length === 0) {
      return {
        success: false,
        error: 'No variations available',
        message: 'No variations are loaded for the current sub-question'
      };
    }

    // Find variation by number
    const variation = this._findVariationByNumber(availableVariations, variation_number);

    if (!variation) {
      return {
        success: false,
        error: 'Variation not found',
        message: `Variation ${variation_number} not found in the current sub-question`
      };
    }

    // Check if already selected
    if (variation.status === 'selected_by_sme' || variation.status === 'approved') {
      return {
        success: true,
        result: {},
        message: `Variation ${variation_number} is already selected`
      };
    }

    console.log('✅ Variation found:', variation.variation_id, 'Status:', variation.status);

    return {
      success: true,
      result: {
        shouldSelectVariation: true,
        variationId: variation.variation_id,
        variationNumber: variation_number
      },
      message: `Variation ${variation_number} selected`
    };
  }

  async _unselectVariation(parameters, formState) {
    const { variation_number } = parameters;
    const { expandedSubQuestionId, availableVariations } = formState;

    console.log('🔍 Unselecting variation:', { variation_number, expandedSubQuestionId });

    if (!expandedSubQuestionId) {
      return {
        success: false,
        error: 'No sub-question expanded',
        message: 'Please expand a sub-question first to unselect variations'
      };
    }

    if (!availableVariations || availableVariations.length === 0) {
      return {
        success: false,
        error: 'No variations available',
        message: 'No variations are loaded for the current sub-question'
      };
    }

    // Find variation by number
    const variation = this._findVariationByNumber(availableVariations, variation_number);

    if (!variation) {
      return {
        success: false,
        error: 'Variation not found',
        message: `Variation ${variation_number} not found in the current sub-question`
      };
    }

    // Check if already unselected
    if (variation.status === 'unselected_by_sme' || variation.status === 'rejected') {
      return {
        success: true,
        result: {},
        message: `Variation ${variation_number} is already unselected`
      };
    }

    console.log('✅ Variation found for unselection:', variation.variation_id);

    return {
      success: true,
      result: {
        shouldUnselectVariation: true,
        variationId: variation.variation_id,
        variationNumber: variation_number
      },
      message: `Variation ${variation_number} unselected`
    };
  }

  async _selectVariationsBatch(parameters, formState) {
    const { variation_numbers } = parameters;
    const { expandedSubQuestionId, availableVariations } = formState;

    console.log('🔍 Batch selecting variations:', { variation_numbers, expandedSubQuestionId });

    if (!expandedSubQuestionId) {
      return {
        success: false,
        error: 'No sub-question expanded',
        message: 'Please expand a sub-question first to select variations'
      };
    }

    if (!availableVariations || availableVariations.length === 0) {
      return {
        success: false,
        error: 'No variations available',
        message: 'No variations are loaded for the current sub-question'
      };
    }

    const variationsToSelect = [];
    const notFound = [];

    for (const num of variation_numbers) {
      const variation = this._findVariationByNumber(availableVariations, num);
      if (variation) {
        variationsToSelect.push({
          variationId: variation.variation_id,
          variationNumber: num
        });
      } else {
        notFound.push(num);
      }
    }

    if (variationsToSelect.length === 0) {
      return {
        success: false,
        error: 'No valid variations',
        message: `None of the specified variations were found: ${variation_numbers.join(', ')}`
      };
    }

    const message = notFound.length > 0
      ? `Selected ${variationsToSelect.length} variations. Not found: ${notFound.join(', ')}`
      : `Selected ${variationsToSelect.length} variations: ${variation_numbers.join(', ')}`;

    return {
      success: true,
      result: {
        shouldSelectVariationsBatch: true,
        variationsToSelect
      },
      message
    };
  }


  _setAISuggestionCount(parameters, formState) {
    const { count } = parameters;

    if (count < 1) {
      return {
        success: false,
        error: 'Invalid count',
        message: 'AI suggestion count must be at least 1'
      };
    }

    return {
      success: true,
      result: {
        aiSuggestionCount: count
      },
      message: `AI suggestion count set to ${count}`
    };
  }

  _triggerAISuggestions(parameters, formState) {
    const { count } = parameters;
    const { expandedSubQuestionId, availableVariations, aiSuggestionCount } = formState;

    if (!expandedSubQuestionId) {
      return {
        success: false,
        error: 'No sub-question expanded',
        message: 'Please expand a sub-question first to get AI suggestions'
      };
    }

    if (!availableVariations || availableVariations.length === 0) {
      return {
        success: false,
        error: 'No variations available',
        message: 'No variations are available for AI recommendations'
      };
    }

    const finalCount = count || aiSuggestionCount || 1;

    return {
      success: true,
      result: {
        shouldTriggerAI: true,
        aiSuggestionCount: finalCount
      },
      message: `Getting ${finalCount} AI suggestion${finalCount > 1 ? 's' : ''}...`
    };
  }

  _applyAIRecommendations(parameters, formState) {
    const { hasAIRecommendations, aiRecommendedVariations } = formState;

    if (!hasAIRecommendations || !aiRecommendedVariations || aiRecommendedVariations.length === 0) {
      return {
        success: false,
        error: 'No recommendations available',
        message: 'No AI recommendations are available to apply. Please get AI suggestions first.'
      };
    }

    return {
      success: true,
      result: {
        shouldApplyAIRecommendations: true
      },
      message: `Applying ${aiRecommendedVariations.length} AI recommendation${aiRecommendedVariations.length > 1 ? 's' : ''}...`
    };
  }

  _cancelAIRecommendations(parameters, formState) {
    const { hasAIRecommendations } = formState;

    if (!hasAIRecommendations) {
      return {
        success: false,
        error: 'No recommendations available',
        message: 'No AI recommendations are available to cancel'
      };
    }

    return {
      success: true,
      result: {
        shouldCancelAIRecommendations: true
      },
      message: 'AI recommendations cancelled'
    };
  }


  _navigateNextVariation(parameters, formState) {
    const { availableVariations, currentVariationIndex } = formState;

    if (!availableVariations || availableVariations.length === 0) {
      return {
        success: false,
        error: 'No variations available',
        message: 'No variations are available to navigate'
      };
    }

    const currentIndex = currentVariationIndex || 0;
    const nextIndex = currentIndex + 1;

    if (nextIndex >= availableVariations.length) {
      return {
        success: false,
        error: 'End of list',
        message: 'You are at the last variation. There are no more variations.'
      };
    }

    const nextVariation = availableVariations[nextIndex];

    return {
      success: true,
      result: {
        currentVariationIndex: nextIndex,
        shouldShowVariation: true,
        variationNumber: nextVariation.variation_number
      },
      message: `Showing variation ${nextVariation.variation_number}`
    };
  }

  _navigatePreviousVariation(parameters, formState) {
    const { availableVariations, currentVariationIndex } = formState;

    if (!availableVariations || availableVariations.length === 0) {
      return {
        success: false,
        error: 'No variations available',
        message: 'No variations are available to navigate'
      };
    }

    const currentIndex = currentVariationIndex || 0;
    const prevIndex = currentIndex - 1;

    if (prevIndex < 0) {
      return {
        success: false,
        error: 'Start of list',
        message: 'You are at the first variation. There are no previous variations.'
      };
    }

    const prevVariation = availableVariations[prevIndex];

    return {
      success: true,
      result: {
        currentVariationIndex: prevIndex,
        shouldShowVariation: true,
        variationNumber: prevVariation.variation_number
      },
      message: `Showing variation ${prevVariation.variation_number}`
    };
  }

  _showVariation(parameters, formState) {
    const { variation_number } = parameters;
    const { availableVariations } = formState;

    if (!availableVariations || availableVariations.length === 0) {
      return {
        success: false,
        error: 'No variations available',
        message: 'No variations are available to show'
      };
    }

    const variationIndex = this._findVariationIndexByNumber(availableVariations, variation_number);

    if (variationIndex === -1) {
      return {
        success: false,
        error: 'Variation not found',
        message: `Variation ${variation_number} not found`
      };
    }

    const variation = availableVariations[variationIndex];
    const statusText = this._getStatusText(variation.status);

    return {
      success: true,
      result: {
        currentVariationIndex: variationIndex,
        shouldShowVariation: true,
        variationNumber: variation_number
      },
      message: `Showing variation ${variation_number}. Status: ${statusText}`
    };
  }


  _queryVariationCounts(parameters, formState) {
    const { status_type } = parameters;
    const { availableVariations } = formState;

    if (!availableVariations || availableVariations.length === 0) {
      return {
        success: true,
        result: {},
        message: 'No variations are available in the current sub-question'
      };
    }

    let count = 0;
    let message = '';

    switch (status_type) {
      case 'selected':
        count = availableVariations.filter(v => 
          v.status === 'selected_by_sme' || v.status === 'approved'
        ).length;
        message = `${count} variation${count !== 1 ? 's' : ''} selected`;
        break;
      
      case 'pending':
        count = availableVariations.filter(v => v.status === 'sent_to_sme').length;
        message = `${count} variation${count !== 1 ? 's' : ''} pending review`;
        break;
      
      case 'unselected':
        count = availableVariations.filter(v => 
          v.status === 'unselected_by_sme' || v.status === 'rejected'
        ).length;
        message = `${count} variation${count !== 1 ? 's' : ''} unselected`;
        break;
      
      case 'total':
        count = availableVariations.length;
        message = `${count} total variation${count !== 1 ? 's' : ''}`;
        break;
      
      default:
        return {
          success: false,
          error: 'Invalid status type',
          message: 'Please specify selected, pending, unselected, or total'
        };
    }

    return {
      success: true,
      result: { count },
      message
    };
  }

  _queryVariationStatus(parameters, formState) {
    const { variation_number } = parameters;
    const { availableVariations } = formState;

    if (!availableVariations || availableVariations.length === 0) {
      return {
        success: false,
        error: 'No variations available',
        message: 'No variations are available to query'
      };
    }

    const variation = this._findVariationByNumber(availableVariations, variation_number);

    if (!variation) {
      return {
        success: false,
        error: 'Variation not found',
        message: `Variation ${variation_number} not found`
      };
    }

    const statusText = this._getStatusText(variation.status);

    return {
      success: true,
      result: { status: variation.status },
      message: `Variation ${variation_number} is ${statusText}`
    };
  }

  _normalizeVariationNumber(value) {
    if (value === null || value === undefined) return null;
    const stringValue = String(value).trim();
    if (!stringValue) return null;

    if (/^-?\d+(\.\d+)?$/.test(stringValue)) {
      return Number(stringValue);
    }

    const numericOnly = stringValue.replace(/[^\d-]/g, '');
    if (numericOnly) {
      const parsed = Number(numericOnly);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }

    return stringValue.toLowerCase();
  }

  _findVariationByNumber(variations = [], variationNumber) {
    const normalizedTarget = this._normalizeVariationNumber(variationNumber);
    if (normalizedTarget === null) return null;

    return variations.find(variation => {
      const normalizedValue = this._normalizeVariationNumber(variation?.variation_number);
      if (normalizedValue === null) return false;
      return normalizedValue === normalizedTarget;
    }) || null;
  }

  _findVariationIndexByNumber(variations = [], variationNumber) {
    const normalizedTarget = this._normalizeVariationNumber(variationNumber);
    if (normalizedTarget === null) return -1;

    return variations.findIndex(variation => {
      const normalizedValue = this._normalizeVariationNumber(variation?.variation_number);
      if (normalizedValue === null) return false;
      return normalizedValue === normalizedTarget;
    });
  }


  _expandSubQuestion(parameters, formState) {
    const { sub_question_number } = parameters;
    const { paperQuestions } = formState;

    if (!paperQuestions || paperQuestions.length === 0) {
      return {
        success: false,
        error: 'No questions available',
        message: 'No questions are available in the current paper'
      };
    }

    // Find the sub-question across all questions
    let foundSubQuestion = null;
    let questionIndex = -1;
    let subQuestionIndex = -1;

    for (let qi = 0; qi < paperQuestions.length; qi++) {
      const question = paperQuestions[qi];
      if (question.sub_questions) {
        for (let sqi = 0; sqi < question.sub_questions.length; sqi++) {
          const subQ = question.sub_questions[sqi];
          // Match by sub_number or full_question_number
          if (subQ.sub_number === sub_question_number || 
              subQ.full_question_number === sub_question_number ||
              subQ.full_question_number?.includes(sub_question_number)) {
            foundSubQuestion = subQ;
            questionIndex = qi;
            subQuestionIndex = sqi;
            break;
          }
        }
        if (foundSubQuestion) break;
      }
    }

    if (!foundSubQuestion) {
      return {
        success: false,
        error: 'Sub-question not found',
        message: `Sub-question ${sub_question_number} not found in the current paper`
      };
    }

    return {
      success: true,
      result: {
        shouldExpandSubQuestion: true,
        questionIndex,
        subQuestionIndex,
        subQuestionId: foundSubQuestion.sub_question_id
      },
      message: `Expanding sub-question ${foundSubQuestion.full_question_number}...`
    };
  }

  _collapseSubQuestion(parameters, formState) {
    const { expandedSubQuestionId } = formState;

    if (!expandedSubQuestionId) {
      return {
        success: false,
        error: 'No sub-question expanded',
        message: 'No sub-question is currently expanded'
      };
    }

    return {
      success: true,
      result: {
        shouldCollapseSubQuestion: true
      },
      message: 'Sub-question collapsed'
    };
  }


  _sendToModerator(parameters, formState) {
    const { canSendToModerator, sendToModeratorVisible, paperQuestions, paperId, paperTitle } = formState;

    if (!sendToModeratorVisible) {
      return {
        success: false,
        error: 'Action not available',
        message: 'Send to moderator is not available for this paper. The paper may not be ready or already sent.'
      };
    }

    // Validate that all sub-questions have at least 40 selected variations
    if (paperQuestions && paperQuestions.length > 0) {
      const insufficientSubQuestions = [];

      for (const question of paperQuestions) {
        if (question.sub_questions) {
          for (const subQuestion of question.sub_questions) {
            const selectedCount = subQuestion.variations?.filter(v =>
              v.status === 'selected_by_sme' || v.status === 'approved'
            ).length || 0;
            
            if (selectedCount < 40) {
              insufficientSubQuestions.push({
                number: subQuestion.full_question_number,
                selected: selectedCount
              });
            }
          }
        }
      }

      if (insufficientSubQuestions.length > 0) {
        const details = insufficientSubQuestions
          .map(sq => `${sq.number} has ${sq.selected} selected`)
          .join(', ');
        
        return {
          success: false,
          error: 'Insufficient selections',
          message: `Cannot send to moderator. Each sub-question needs at least 40 selected variations. ${details}`
        };
      }
    }

    return {
      success: true,
      result: {
        shouldSendToModerator: true,
        paperId,
        paperTitle
      },
      message: `Sending paper "${paperTitle}" to moderator...`
    };
  }


  // Helper methods
  _getStatusText(status) {
    const statusMap = {
      'sent_to_sme': 'pending review',
      'selected_by_sme': 'selected',
      'approved': 'selected',
      'unselected_by_sme': 'unselected',
      'rejected': 'unselected'
    };
    return statusMap[status] || status;
  }

  _isRetryableError(error) {
    const retryableCodes = ['ECONNABORTED', 'ENOTFOUND', 'ETIMEDOUT', 'RATE_LIMIT_EXCEEDED', '503'];
    return retryableCodes.includes(error.code) || error.status === 503;
  }

  getSystemPrompt(formState) {
    const {
      paperId,
      paperTitle,
      paperStatus,
      expandedSubQuestionId,
      expandedSubQuestionNumber,
      availableVariations = [],
      aiSuggestionCount = 1,
      hasAIRecommendations = false,
      aiRecommendedVariations = [],
      canSendToModerator = false,
      sendToModeratorVisible = false
    } = formState;

    const selectedCount = availableVariations.filter(v => 
      v.status === 'selected_by_sme' || v.status === 'approved'
    ).length;
    const pendingCount = availableVariations.filter(v => v.status === 'sent_to_sme').length;
    const totalCount = availableVariations.length;

    return `You are a voice assistant helping an SME (Subject Matter Expert) review question variations.

Current Context:
- Paper: ${paperTitle || 'Not loaded'} ${paperId ? `(ID: ${paperId})` : ''}
- Paper Status: ${paperStatus || 'Unknown'}
- Expanded Sub-Question: ${expandedSubQuestionNumber || 'None'}
- Variations: ${totalCount} total, ${selectedCount} selected, ${pendingCount} pending
- AI Suggestions: ${hasAIRecommendations ? `${aiRecommendedVariations.length} recommendations available` : 'None available'}
- AI Suggestion Count: ${aiSuggestionCount}
- Ready to Send to Moderator: ${sendToModeratorVisible ? (canSendToModerator ? 'Yes' : 'No (need more selections)') : 'Not available'}

Available Commands:

1. **Variation Selection**:
   - "select variation 5" - Select a single variation
   - "unselect variation 3" or "reject variation 3" - Unselect a variation
   - "select variations 1, 2, and 3" - Select multiple variations at once

2. **AI Recommendations**:
   - "set AI suggestions to 5" - Set the number of AI suggestions
   - "get AI suggestions" or "get 3 AI suggestions" - Trigger AI recommendations
   - "apply AI recommendations" or "accept suggestions" - Apply recommended variations
   - "cancel AI recommendations" - Dismiss recommendations

3. **Navigation**:
   - "show variation 10" - Scroll to and highlight a specific variation
   - "next variation" or "next" - Navigate to next variation
   - "previous variation" or "previous" - Navigate to previous variation

4. **Queries**:
   - "how many selected" - Count selected variations
   - "how many pending" - Count pending variations
   - "how many total" - Count total variations
   - "what is the status of variation 5" - Get status of specific variation

5. **Sub-Question Management**:
   - "expand sub-question 1.1" - Expand a sub-question to view variations
   - "collapse sub-question" or "close" - Collapse current sub-question

6. **Submission**:
   - "send to moderator" - Submit paper to moderator (requires 40+ selected per sub-question)

CRITICAL RULES:
- ONLY execute commands for the currently expanded sub-question
- If no sub-question is expanded, inform the user to expand one first
- Always provide clear feedback after each action
- For batch operations, report both successes and failures
- Be conversational and helpful
- If a command is unclear, ask for clarification`;
  }

  getMetadata() {
    return {
      displayName: 'SME Variation Review',
      description: 'Voice control for SME paper variation review workflow',
      supportedActions: this.getFunctionDefinitions().map(f => f.name)
    };
  }

  /**
   * Get suggested next actions based on current workflow state
   * @param {Object} formState - Current UI state
   * @param {string|null} lastAction - Last executed function name
   * @returns {Array<Object>} Array of suggestion objects
   */
  getSuggestedNextActions(formState, lastAction) {
    const suggestions = [];
    
    // No sub-question expanded
    if (!formState.expandedSubQuestionId) {
      suggestions.push({
        text: "expand a sub-question to review variations",
        priority: 1,
        commandPatterns: ["expand sub-question", "show sub-question", "open sub-question"],
        requiresPrerequisite: false
      });
      return suggestions;
    }
    
    // Calculate variation counts
    const variations = formState.availableVariations || [];
    const selectedCount = variations.filter(v => 
      v.status === 'selected_by_sme' || v.status === 'approved'
    ).length;
    const pendingCount = variations.filter(v => v.status === 'sent_to_sme').length;
    
    // Priority 1: Need more selections
    if (selectedCount < 40) {
      suggestions.push({
        text: `select more variations (${selectedCount}/40 selected)`,
        priority: 1,
        commandPatterns: ["select variation", "choose variation", "pick variation"],
        requiresPrerequisite: false
      });
      
      if (pendingCount > 0) {
        suggestions.push({
          text: "get AI suggestions",
          priority: 1,
          commandPatterns: ["AI suggest", "get AI suggestion", "AI recommend"],
          requiresPrerequisite: false
        });
      }
    }
    
    // Priority 1: Ready to send to moderator
    if (selectedCount >= 40 && formState.sendToModeratorVisible) {
      suggestions.push({
        text: "send to moderator",
        priority: 1,
        commandPatterns: ["send to moderator", "submit to moderator", "send for approval"],
        requiresPrerequisite: false
      });
    }
    
    // Priority 2: Review actions
    if (pendingCount > 0) {
      suggestions.push({
        text: "unselect a variation",
        priority: 2,
        commandPatterns: ["unselect variation", "deselect variation", "remove variation"],
        requiresPrerequisite: false
      });
    }
    
    // Priority 3: Navigation
    suggestions.push({
      text: "collapse this sub-question",
      priority: 3,
      commandPatterns: ["collapse", "close sub-question", "collapse sub-question"],
      requiresPrerequisite: false
    });
    
    return suggestions;
  }
}

module.exports = SMEVariationReviewContext;
