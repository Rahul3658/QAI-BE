/**
 * GenerateQuestionsContext - Voice assistant context for question generation workflow
 * 
 * Provides 12 functions for controlling the Generate Questions form:
 * - Template selection
 * - Paper management (select existing or create new)
 * - Language selection
 * - Question and sub-question selection
 * - Subject and topic input
 * - Variations count
 * - Form management (clear, get state, trigger generation)
 */

const ContextPlugin = require('../ContextPlugin');

class GenerateQuestionsContext extends ContextPlugin {
  getName() {
    return 'generate-questions';
  }

  getFunctionDefinitions() {
    return [
      {
        name: 'select_template',
        description: 'Select a paper template by name. Use the template name from what the user says, supports partial matching.',
        parameters: {
          type: 'object',
          properties: {
            template_name: {
              type: 'string',
              description: 'Template name or partial name to search for (e.g., "MHTCET", "PCM exam", "exam session")'
            }
          },
          required: ['template_name']
        }
      },
      {
        name: 'select_existing_paper',
        description: 'Select an existing paper to add questions to. Use the paper name from what the user says.',
        parameters: {
          type: 'object',
          properties: {
            paper_name: {
              type: 'string',
              description: 'Paper name or partial name to search for'
            }
          },
          required: ['paper_name']
        }
      },
      {
        name: 'create_new_paper',
        description: 'Create a new paper with a given name',
        parameters: {
          type: 'object',
          properties: {
            paper_name: {
              type: 'string',
              description: 'Name for the new paper'
            }
          },
          required: ['paper_name']
        }
      },
      {
        name: 'set_language',
        description: 'Set the question paper language',
        parameters: {
          type: 'object',
          properties: {
            language: {
              type: 'string',
              enum: ['english', 'hindi', 'marathi', 'urdu'],
              description: 'Paper language'
            }
          },
          required: ['language']
        }
      },
      {
        name: 'select_question',
        description: 'Select a question from the template. User can say just the number (e.g., "1", "2", "3") or with prefix (e.g., "Q1", "question 2").',
        parameters: {
          type: 'object',
          properties: {
            question_number: {
              type: 'string',
              description: 'Question number - can be just a number like "1", "2", "3" or with prefix like "Q1", "question 2"'
            }
          },
          required: ['question_number']
        }
      },
      {
        name: 'select_sub_question',
        description: 'Select a sub-question if the question has sub-questions. User can say just the number or letter (e.g., "1", "2", "a", "b").',
        parameters: {
          type: 'object',
          properties: {
            sub_number: {
              type: 'string',
              description: 'Sub-question number or letter - can be "1", "2", "a", "b", "i", "ii", etc.'
            }
          },
          required: ['sub_number']
        }
      },
      {
        name: 'set_subject',
        description: 'Set the subject field',
        parameters: {
          type: 'object',
          properties: {
            subject: {
              type: 'string',
              description: 'Subject name'
            }
          },
          required: ['subject']
        }
      },
      {
        name: 'set_paper_name',
        description: 'Set the question paper name (the title of the paper being created)',
        parameters: {
          type: 'object',
          properties: {
            paper_name: {
              type: 'string',
              description: 'Question paper name/title'
            }
          },
          required: ['paper_name']
        }
      },
      {
        name: 'set_chapters',
        description: 'Set the topics/chapters field (the specific topics or chapters to focus on)',
        parameters: {
          type: 'object',
          properties: {
            chapters: {
              type: 'string',
              description: 'Topics or chapters (e.g., "Molecules", "Chapter 5", "Organic Chemistry")'
            }
          },
          required: ['chapters']
        }
      },
      {
        name: 'set_num_variations',
        description: 'Set number of variations to generate (minimum 40)',
        parameters: {
          type: 'object',
          properties: {
            num_variations: {
              type: 'integer',
              minimum: 40,
              description: 'Number of variations (minimum 40)'
            }
          },
          required: ['num_variations']
        }
      },
      {
        name: 'clear_form',
        description: 'Reset all form fields to default values',
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'get_current_state',
        description: 'Get current form field values',
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'trigger_generation',
        description: 'Click the generate variations button to start generation',
        parameters: {
          type: 'object',
          properties: {}
        }
      }
    ];
  }

  async executeFunction(functionName, parameters, formState) {
    switch (functionName) {
      case 'select_template':
        return this._selectTemplate(parameters, formState);
      
      case 'select_existing_paper':
        return this._selectExistingPaper(parameters, formState);
      
      case 'create_new_paper':
        return this._createNewPaper(parameters, formState);
      
      case 'set_language':
        return this._setLanguage(parameters, formState);
      
      case 'select_question':
        return this._selectQuestion(parameters, formState);
      
      case 'select_sub_question':
        return this._selectSubQuestion(parameters, formState);
      
      case 'set_subject':
        return this._setSubject(parameters, formState);
      
      case 'set_paper_name':
        return this._setPaperName(parameters, formState);
      
      case 'set_chapters':
        return this._setChapters(parameters, formState);
      
      case 'set_num_variations':
        return this._setNumVariations(parameters, formState);
      
      case 'clear_form':
        return this._clearForm(parameters, formState);
      
      case 'get_current_state':
        return this._getCurrentState(parameters, formState);
      
      case 'trigger_generation':
        return this._triggerGeneration(parameters, formState);
      
      default:
        return {
          success: false,
          error: 'Unknown function',
          message: `Function ${functionName} not found`
        };
    }
  }

  // Function implementations
  _selectTemplate(parameters, formState) {
    // Accept both template_name (new) and template_id (legacy) parameters
    const searchInput = parameters.template_name || parameters.template_id;
    const templates = formState.availableTemplates || [];
    
    console.log('🔍 Template search:', {
      searchInput,
      availableTemplates: templates.length,
      templateNames: templates.map(t => t.template_name)
    });
    
    if (!searchInput) {
      return {
        success: false,
        error: 'No template specified',
        message: 'Please specify a template name'
      };
    }
    
    if (!templates || templates.length === 0) {
      return {
        success: false,
        error: 'No templates available',
        message: 'Templates are not loaded. Please refresh the page or check if templates exist.'
      };
    }
    
    const searchTerm = String(searchInput).toLowerCase().trim();
    
    console.log('🔍 Searching for:', searchTerm);
    
    // Try exact ID match first (in case user says a number)
    let template = templates.find(t => String(t.template_id) === String(searchInput));
    if (template) {
      console.log('✅ Found by exact ID match:', template.template_name);
    }
    
    // Try exact name match (case-insensitive)
    if (!template) {
      template = templates.find(t => 
        t.template_name?.toLowerCase() === searchTerm
      );
      if (template) {
        console.log('✅ Found by exact name match:', template.template_name);
      }
    }
    
    // Try partial match - check if template name contains ALL words from search term
    if (!template) {
      const searchWords = searchTerm.split(/\s+/).filter(w => w.length > 0);
      template = templates.find(t => {
        const templateName = t.template_name?.toLowerCase() || '';
        const matches = searchWords.every(word => templateName.includes(word));
        if (matches) {
          console.log('✅ Found by all-words match:', t.template_name, 'with words:', searchWords);
        }
        return matches;
      });
    }
    
    // Try partial match - check if template name contains ANY word from search term
    if (!template) {
      const searchWords = searchTerm.split(/\s+/).filter(w => w.length > 2); // Only words > 2 chars
      template = templates.find(t => {
        const templateName = t.template_name?.toLowerCase() || '';
        const matches = searchWords.some(word => templateName.includes(word));
        if (matches) {
          console.log('✅ Found by any-word match:', t.template_name, 'with words:', searchWords);
        }
        return matches;
      });
    }
    
    // Try fuzzy match - check if search term is contained in template name
    if (!template) {
      template = templates.find(t => {
        const matches = t.template_name?.toLowerCase().includes(searchTerm);
        if (matches) {
          console.log('✅ Found by fuzzy match:', t.template_name);
        }
        return matches;
      });
    }
    
    if (!template) {
      console.log('❌ No template found for:', searchTerm);
      const availableNames = templates.map(t => `"${t.template_name}"`).join(', ');
      return {
        success: false,
        error: 'Template not found',
        message: `Template "${searchInput}" not found. Available templates: ${availableNames}`
      };
    }
    
    console.log('✅ Selected template:', template.template_name, 'ID:', template.template_id);
    
    return {
      success: true,
      result: { selectedTemplate: String(template.template_id) },
      message: `Template "${template.template_name}" selected`
    };
  }

  _selectExistingPaper(parameters, formState) {
    // Accept both paper_name (new) and paper_id (legacy) parameters
    const searchInput = parameters.paper_name || parameters.paper_id;
    const papers = formState.existingPapers || [];
    
    console.log('🔍 Paper search:', {
      searchInput,
      availablePapers: papers.length,
      paperTitles: papers.map(p => p.paper_title)
    });
    
    if (!searchInput) {
      return {
        success: false,
        error: 'No paper specified',
        message: 'Please specify a paper name'
      };
    }
    
    if (papers.length === 0) {
      return {
        success: false,
        error: 'No papers available',
        message: 'No existing papers found. You can create a new paper instead.'
      };
    }
    
    const searchTerm = String(searchInput).toLowerCase().trim();
    
    // Find paper by ID or title (case-insensitive partial match)
    const paper = papers.find(p =>
      String(p.paper_id) === String(searchInput) ||
      p.paper_title?.toLowerCase().includes(searchTerm)
    );
    
    if (!paper) {
      const availableTitles = papers.map(p => `"${p.paper_title}"`).join(', ');
      console.log('❌ No paper found for:', searchTerm);
      return {
        success: false,
        error: 'Paper not found',
        message: `Paper "${searchInput}" not found. Available papers: ${availableTitles}`
      };
    }
    
    console.log('✅ Selected paper:', paper.paper_title, 'ID:', paper.paper_id);
    
    return {
      success: true,
      result: {
        selectedExistingPaper: String(paper.paper_id),
        paperName: paper.paper_title,
        languageConfirmed: false
      },
      message: `Adding to paper "${paper.paper_title}"`
    };
  }

  _createNewPaper(parameters, formState) {
    return {
      success: true,
      result: {
        selectedExistingPaper: null,
        paperName: parameters.paper_name,
        languageConfirmed: false
      },
      message: `Creating new paper "${parameters.paper_name}"`
    };
  }

  _setLanguage(parameters, formState) {
    return {
      success: true,
      result: { 
        selectedLanguage: parameters.language,
        languageConfirmed: true  // Mark language as explicitly confirmed
      },
      message: `Language set to ${parameters.language}`
    };
  }

  _selectQuestion(parameters, formState) {
    const questionNumber = parameters.question_number;
    const questions = formState.templateQuestions || [];
    
    console.log('🔍 Question search:', {
      searchInput: questionNumber,
      searchType: typeof questionNumber,
      availableQuestions: questions.length,
      questionNumbers: questions.map(q => ({
        question_number: q.question_number,
        type: typeof q.question_number
      }))
    });
    
    if (!questions || questions.length === 0) {
      return {
        success: false,
        error: 'No questions available',
        message: 'No questions found in the selected template. Please select a template first.'
      };
    }
    
    // Normalize user input: remove "Q", "question" prefix, spaces, dots
    let normalizedInput = String(questionNumber)
      .toLowerCase()
      .replace(/^(q|question)\s*/i, '')
      .replace(/[.\s]/g, '')
      .trim();
    
    console.log('🔍 Normalized input:', normalizedInput);
    
    // Try multiple matching strategies to find the question
    let question = null;
    
    // Strategy 1: Direct match - try to find by matching normalized question_number
    question = questions.find(q => {
      const qNum = String(q.question_number).toLowerCase().replace(/[.\s]/g, '');
      return qNum === normalizedInput;
    });
    
    if (question) {
      console.log('✅ Found by direct match:', question.question_number);
    }
    
    // Strategy 2: Numeric match - if user says "1", match questions like "1", "1.", "Q1"
    if (!question && /^\d+$/.test(normalizedInput)) {
      const inputNum = parseInt(normalizedInput, 10);
      question = questions.find(q => {
        const qNumStr = String(q.question_number).replace(/[^\d]/g, '');
        if (!qNumStr) return false;
        const qNum = parseInt(qNumStr, 10);
        return qNum === inputNum;
      });
      
      if (question) {
        console.log('✅ Found by numeric match:', question.question_number);
      }
    }
    
    // Strategy 3: Index-based match - if user says "1", try index 0
    if (!question && /^\d+$/.test(normalizedInput)) {
      const index = parseInt(normalizedInput, 10) - 1;
      if (index >= 0 && index < questions.length) {
        question = questions[index];
        console.log('✅ Found by index match:', question.question_number, 'at index:', index);
      }
    }
    
    if (!question) {
      console.log('❌ No question found for:', questionNumber);
      const availableNumbers = questions.map(q => q.question_number).join(', ');
      return {
        success: false,
        error: 'Question not found',
        message: `Question "${questionNumber}" not found in template. Available: ${availableNumbers}`
      };
    }
    
    console.log('✅ Selected question:', {
      question_number: question.question_number,
      type: typeof question.question_number,
      question_type: question.question_type
    });
    
    // Check if question is disabled (same logic as frontend)
    if (formState.completedSubQuestions && Array.isArray(formState.completedSubQuestions)) {
      const subQuestions = question.sub_questions || question.subquestions || [];
      const hasSubQuestions = subQuestions.length > 0;
      
      // Check if this question is completed
      let isCompleted = false;
      if (hasSubQuestions) {
        // All sub-questions must be completed
        isCompleted = subQuestions.every(sq => {
          let cleanSubNumber = sq.sub_number;
          if (typeof cleanSubNumber === 'string') {
            cleanSubNumber = cleanSubNumber.replace(/\)$/, '');
          }
          const key = `${question.question_number}-${cleanSubNumber}`;
          return formState.completedSubQuestions.includes(key);
        });
      } else {
        // Check if question itself is completed (for questions without sub-questions)
        isCompleted = formState.completedQuestions && 
                     Array.isArray(formState.completedQuestions) &&
                     formState.completedQuestions.includes(question.question_number);
      }
      
      // Check if this is the next available question
      const isNext = formState.nextAvailable?.nextQuestion?.question_number === question.question_number;
      
      // If all completed, allow any selection
      const allCompleted = formState.allCompleted === true;
      
      console.log('🔍 Question validation check:', {
        question_number: question.question_number,
        isCompleted,
        isNext,
        allCompleted,
        hasSubQuestions
      });
      
      // Frontend logic: const isDisabled = !allCompleted && !isCompleted && !isNext;
      const isDisabled = !allCompleted && !isCompleted && !isNext;
      
      if (isDisabled) {
        return {
          success: false,
          error: 'Question is disabled',
          message: `Question ${question.question_number} is not available yet. Please complete previous questions first. The next available is question ${formState.nextAvailable?.nextQuestion?.question_number || 'unknown'}.`
        };
      }
    }
    
    // Return the EXACT question_number from the template (not normalized)
    // This ensures the frontend can match it using the same logic as the dropdown
    return {
      success: true,
      result: {
        selectedQuestionNumber: question.question_number, // Exact value from template
        selectedSubQuestion: null // Reset sub-question when question changes
      },
      message: `Question ${question.question_number} selected (${question.question_type}, ${question.marks || question.total_marks || 0} marks)`
    };
  }

  _selectSubQuestion(parameters, formState) {
    if (!formState.selectedQuestion) {
      return {
        success: false,
        error: 'No question selected',
        message: 'Please select a question first'
      };
    }
    
    const subNumber = parameters.sub_number;
    const subQuestions = formState.selectedQuestion.sub_questions ||
                        formState.selectedQuestion.subquestions || [];
    
    console.log('🔍 Sub-question search:', {
      searchInput: subNumber,
      availableSubQuestions: subQuestions.length,
      subQuestionNumbers: subQuestions.map(sq => sq.sub_number)
    });
    
    if (subQuestions.length === 0) {
      return {
        success: false,
        error: 'No sub-questions available',
        message: 'The selected question does not have sub-questions'
      };
    }
    
    // Normalize input: remove spaces, dots, parentheses, and convert to lowercase
    const normalizedInput = String(subNumber)
      .toLowerCase()
      .replace(/[.\s()]/g, '')
      .trim();
    
    console.log('🔍 Normalized sub-question input:', normalizedInput);
    
    // Try multiple matching strategies
    let subQuestion = null;
    
    // Strategy 1: Exact match with sub_number field
    subQuestion = subQuestions.find(sq => {
      const sqNum = String(sq.sub_number).toLowerCase().replace(/[.\s()]/g, '');
      const matches = sqNum === normalizedInput;
      if (matches) {
        console.log('✅ Found by exact match:', sq.sub_number);
      }
      return matches;
    });
    
    // Strategy 2: Match by numeric value (e.g., "1" matches "1", "a", "i")
    if (!subQuestion && /^\d+$/.test(normalizedInput)) {
      const inputNum = parseInt(normalizedInput, 10);
      // Try to match by index (1-based)
      const index = inputNum - 1;
      if (index >= 0 && index < subQuestions.length) {
        subQuestion = subQuestions[index];
        console.log('✅ Found by numeric index match:', subQuestion.sub_number, 'at index:', index);
      }
    }
    
    // Strategy 3: Match alphabetic sub-questions (a, b, c, etc.)
    if (!subQuestion && /^[a-z]$/i.test(normalizedInput)) {
      subQuestion = subQuestions.find(sq => {
        const sqNum = String(sq.sub_number).toLowerCase().replace(/[.\s()]/g, '');
        const matches = sqNum === normalizedInput || sqNum === `(${normalizedInput})`;
        if (matches) {
          console.log('✅ Found by alphabetic match:', sq.sub_number);
        }
        return matches;
      });
    }
    
    // Strategy 4: Match roman numerals (i, ii, iii, iv, v)
    if (!subQuestion && /^[ivxlcdm]+$/i.test(normalizedInput)) {
      subQuestion = subQuestions.find(sq => {
        const sqNum = String(sq.sub_number).toLowerCase().replace(/[.\s()]/g, '');
        const matches = sqNum === normalizedInput;
        if (matches) {
          console.log('✅ Found by roman numeral match:', sq.sub_number);
        }
        return matches;
      });
    }
    
    if (!subQuestion) {
      console.log('❌ No sub-question found for:', subNumber);
      const availableNumbers = subQuestions.map(sq => sq.sub_number).join(', ');
      return {
        success: false,
        error: 'Sub-question not found',
        message: `Sub-question "${subNumber}" not found. Available: ${availableNumbers}`
      };
    }
    
    console.log('✅ Selected sub-question:', subQuestion.sub_number);
    
    // Check if sub-question is disabled/completed by checking formState
    // The frontend passes completedSubQuestions and nextAvailable as part of formState
    const questionNumber = formState.selectedQuestion?.question_number;
    if (questionNumber) {
      // Clean sub-question number (remove trailing parenthesis)
      let cleanSubNumber = subQuestion.sub_number;
      if (typeof cleanSubNumber === 'string') {
        cleanSubNumber = cleanSubNumber.replace(/\)$/, '');
      }
      
      const key = `${questionNumber}-${cleanSubNumber}`;
      
      console.log('🔍 Checking if sub-question is allowed:', {
        key,
        subNumber: cleanSubNumber,
        hasCompletedSubQuestions: !!formState.completedSubQuestions,
        completedSubQuestions: formState.completedSubQuestions,
        nextAvailable: formState.nextAvailable,
        allCompleted: formState.allCompleted
      });
      
      // If completedSubQuestions is available in formState, check it
      if (formState.completedSubQuestions && Array.isArray(formState.completedSubQuestions)) {
        const isCompleted = formState.completedSubQuestions.includes(key);
        
        // Check if this is the next available sub-question
        // Need to clean the next sub-question number too for comparison
        let nextSubNumber = formState.nextAvailable?.nextSubQuestion?.sub_number;
        if (typeof nextSubNumber === 'string') {
          nextSubNumber = nextSubNumber.replace(/\)$/, '');
        }
        const isNext = nextSubNumber === cleanSubNumber;
        
        // If all completed, allow any selection
        const allCompleted = formState.allCompleted === true;
        
        console.log('🔍 Validation check:', {
          key,
          cleanSubNumber,
          nextSubNumber,
          isCompleted,
          isNext,
          allCompleted,
          completedList: formState.completedSubQuestions
        });
        
        // Frontend logic: const isDisabled = !allCompleted && !isCompleted && !isNext;
        // This means: Disabled if (NOT all completed) AND (NOT completed) AND (NOT next)
        // In other words: Allow if (all completed) OR (completed) OR (next)
        
        const isDisabled = !allCompleted && !isCompleted && !isNext;
        
        console.log('🔍 Disabled check:', {
          isDisabled,
          logic: `!${allCompleted} && !${isCompleted} && !${isNext} = ${isDisabled}`
        });
        
        if (isDisabled) {
          return {
            success: false,
            error: 'Sub-question is disabled',
            message: `Sub-question ${subQuestion.sub_number} is not available yet. Please complete previous sub-questions first. The next available is sub-question ${formState.nextAvailable?.nextSubQuestion?.sub_number || 'unknown'}.`
          };
        }
      }
    }
    
    // Also check the old is_completed/disabled flags as fallback
    if (subQuestion.is_completed || subQuestion.disabled) {
      return {
        success: false,
        error: 'Sub-question already completed',
        message: `Sub-question ${subQuestion.sub_number} is already completed. Please select an incomplete sub-question.`
      };
    }
    
    return {
      success: true,
      result: { selectedSubQuestion: subQuestion },
      message: `Sub-question ${subQuestion.sub_number} selected (${subQuestion.marks} marks)`
    };
  }

  _setSubject(parameters, formState) {
    return {
      success: true,
      result: { subject: parameters.subject },
      message: `Subject set to "${parameters.subject}"`
    };
  }

  _setPaperName(parameters, formState) {
    return {
      success: true,
      result: { 
        paperName: parameters.paper_name,
        languageConfirmed: false
      },
      message: `Paper name set to "${parameters.paper_name}"`
    };
  }

  _setChapters(parameters, formState) {
    return {
      success: true,
      result: { chapters: parameters.chapters },
      message: `Topics/Chapters set to "${parameters.chapters}"`
    };
  }

  _setNumVariations(parameters, formState) {
    const numVariations = parameters.num_variations;
    
    if (numVariations < 40) {
      return {
        success: false,
        error: 'Minimum 40 variations required',
        message: 'Please specify at least 40 variations'
      };
    }
    
    return {
      success: true,
      result: { num_variations: numVariations },
      message: `Will generate ${numVariations} variations`
    };
  }

  _clearForm(parameters, formState) {
    return {
      success: true,
      result: {
        selectedTemplate: null,
        selectedExistingPaper: null,
        paperName: '',
        chapters: '',
        selectedLanguage: 'english',
        languageConfirmed: false,
        selectedQuestion: null,
        selectedSubQuestion: null,
        subject: '',
        num_variations: 40
      },
      message: 'Form cleared'
    };
  }

  _getCurrentState(parameters, formState) {
    return {
      success: true,
      result: formState,
      message: 'Current state retrieved'
    };
  }

  _triggerGeneration(parameters, formState) {
    // Validate required fields
    const errors = [];
    
    if (!formState.selectedTemplate) errors.push('template');
    if (!formState.paperName) errors.push('paper name');
    if (!formState.selectedQuestion) errors.push('question');
    
    // Check if sub-question is required
    const hasSubQuestions = formState.selectedQuestion?.sub_questions?.length > 0 ||
                           formState.selectedQuestion?.subquestions?.length > 0;
    if (hasSubQuestions && !formState.selectedSubQuestion) {
      errors.push('sub-question');
    }
    
    if (!formState.subject) errors.push('subject');
    if (!formState.num_variations || formState.num_variations < 40) {
      errors.push('number of variations (minimum 40)');
    }
    
    if (errors.length > 0) {
      return {
        success: false,
        error: 'Missing required fields',
        message: `Please set: ${errors.join(', ')}`
      };
    }
    
    return {
      success: true,
      result: { shouldGenerate: true },
      message: 'Starting generation...'
    };
  }

  getSystemPrompt(formState) {
    const hasSubQuestions = formState.selectedQuestion?.sub_questions?.length > 0 ||
                           formState.selectedQuestion?.subquestions?.length > 0;
    
    // Get template name if selected
    const selectedTemplateName = formState.selectedTemplate && formState.availableTemplates
      ? formState.availableTemplates.find(t => String(t.template_id) === String(formState.selectedTemplate))?.template_name
      : null;
    
    return `You are a voice assistant helping a faculty member generate exam question variations.

Current workflow state:
1. Template: ${formState.selectedTemplate ? `✅ Selected: "${selectedTemplateName || formState.selectedTemplate}"` : '❌ Not selected'}
2. Paper Name: ${formState.selectedExistingPaper ? `✅ Adding to existing paper "${formState.paperName}"` : formState.paperName ? `✅ Creating new paper "${formState.paperName}"` : '❌ Not set'}
3. Language: ${formState.selectedLanguage || 'english'}
4. Question: ${formState.selectedQuestion ? `✅ ${formState.selectedQuestion.question_number}` : '❌ Not selected'}
5. Sub-question: ${hasSubQuestions ? (formState.selectedSubQuestion ? `✅ ${formState.selectedSubQuestion.sub_number}` : '❌ Required but not selected') : 'N/A (no sub-questions)'}
6. Subject: ${formState.subject || '❌ Not set'}
7. Topics/Chapters: ${formState.chapters || '❌ Not set (optional)'}
8. Number of variations: ${formState.num_variations || '❌ Not set (minimum 40)'}

Available templates: ${formState.availableTemplates?.map(t => t.template_name).join(', ') || 'Loading...'}
Available existing papers: ${formState.existingPapers?.map(p => p.paper_title).join(', ') || 'None'}

You can help the user by:
1. Selecting a template (select_template) - supports partial matching
2. Selecting an existing paper or creating a new one (select_existing_paper, create_new_paper)
3. Setting the language (set_language)
4. Selecting a question from the template (select_question) - user can say just "1", "2", "3"
5. Selecting a sub-question if needed (select_sub_question) - user can say just "a", "b", "1", "2"
6. Setting the subject (set_subject)
7. Setting the paper name (set_paper_name) - the title of the question paper
8. Setting topics/chapters (set_chapters) - specific topics to focus on (optional)
9. Setting number of variations (set_num_variations, minimum 40)
10. Clearing the form (clear_form)
11. Checking current values (get_current_state)
12. Starting the generation process (trigger_generation)

CRITICAL RULES:
- ONLY modify the specific field(s) the user mentions in their command
- DO NOT clear or reset other fields unless explicitly asked
- When user sets a field (like subject or topic), keep all other selections intact
- ALWAYS use template NAMES, never IDs: When user says "select template MHTCET", use template_name="MHTCET", NOT an ID number
- For partial template names, use the select_template function which supports fuzzy matching
- The select_template function will automatically find the right template and return its ID
- For question selection, user can say just the number (e.g., "1", "2", "3")
- For sub-question selection, user can say just the number or letter (e.g., "1", "a", "b")
- PDF selection is manual only - do not mention PDF upload or validation
- Model selection is automatic - do not mention model selection
- Always confirm actions after executing them
- Be conversational and helpful
- If the user's request is ambiguous, ask clarifying questions`;
  }

  getMetadata() {
    return {
      displayName: 'Generate Questions',
      description: 'Voice control for question generation workflow',
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
    const seenSuggestions = new Set();
    const addSuggestion = (suggestion) => {
      if (!suggestion || !suggestion.text) return;
      const key = suggestion.text.toLowerCase();
      if (seenSuggestions.has(key)) {
        return;
      }
      suggestions.push(suggestion);
      seenSuggestions.add(key);
    };
    
    console.log('🔍 getSuggestedNextActions called with formState:', {
      selectedTemplate: formState.selectedTemplate,
      paperName: formState.paperName,
      selectedQuestion: formState.selectedQuestion ? 'YES' : 'NO',
      selectedQuestionNumber: formState.selectedQuestion?.question_number,
      lastAction
    });
    
    // Priority 1: Critical missing fields
    if (!formState.selectedTemplate) {
      addSuggestion({
        text: "select a template",
        priority: 1,
        commandPatterns: ["select template", "choose template", "pick template"],
        requiresPrerequisite: false,
        scrollToField: "template"
      });
    }
    
    if (formState.selectedTemplate && !formState.paperName) {
      addSuggestion({
        text: "create a new paper",
        priority: 1,
        commandPatterns: ["create paper", "new paper", "create new paper"],
        requiresPrerequisite: false,
        scrollToField: "paperName"
      });
    }
    
    // Check if language needs to be explicitly confirmed (not just default)
    // Language is confirmed if user explicitly set it OR if they confirmed the default
    const languageExplicitlySet = formState.selectedLanguage && formState.selectedLanguage !== 'english';
    const languageConfirmed = formState.languageConfirmed || languageExplicitlySet;
    const needsLanguageConfirmation = !formState.selectedLanguage || !languageConfirmed;
    const hasSelectedQuestion = Boolean(formState.selectedQuestion || formState.selectedQuestionNumber);
    const hasPaperContext = Boolean(
      (formState.paperName && String(formState.paperName).trim().length > 0) ||
      formState.selectedExistingPaper
    );
    
    console.log('🔍 Language check:', {
      paperName: formState.paperName,
      selectedLanguage: formState.selectedLanguage,
      languageConfirmed: formState.languageConfirmed,
      languageExplicitlySet,
      finalLanguageConfirmed: languageConfirmed
    });
    
    // Suggest language confirmation if paper name is set but language hasn't been confirmed
    // This catches the case where language is still at default 'english' but not explicitly confirmed
    if (hasPaperContext && needsLanguageConfirmation) {
      console.log('✅ Adding language confirmation suggestion');
      addSuggestion({
        text: "confirm or change the paper language",
        priority: 0, // Highest priority so it is surfaced before question selection
        commandPatterns: ["set language", "change language", "language is", "confirm language", "keep english"],
        requiresPrerequisite: false,
        scrollToField: "language" // Add scroll target
      });
    }
    
    if (hasPaperContext && languageConfirmed && !hasSelectedQuestion) {
      console.log('📝 Suggesting: select a question (paperName and language confirmed, selectedQuestion missing)');
      addSuggestion({
        text: "select a question",
        priority: 1,
        commandPatterns: ["select question", "choose question", "pick question"],
        requiresPrerequisite: false,
        scrollToField: "question" // Add scroll target
      });
    }
    
    // Check if sub-question is required
    const hasSubQuestions = formState.selectedQuestion?.sub_questions?.length > 0 ||
                           formState.selectedQuestion?.subquestions?.length > 0;
    if (hasSubQuestions && !formState.selectedSubQuestion) {
      addSuggestion({
        text: "select a sub-question",
        priority: 1,
        commandPatterns: ["select sub-question", "choose sub-question", "pick sub-question"],
        requiresPrerequisite: false,
        scrollToField: "subQuestion"
      });
    }
    
    // Priority 2: Important required fields
    if (hasSelectedQuestion && !formState.subject) {
      addSuggestion({
        text: "set the subject",
        priority: 2,
        commandPatterns: ["set subject", "subject is", "set subject to"],
        requiresPrerequisite: false,
        scrollToField: "subject"
      });
    }
    
    // Priority 2: Topics/chapters (required)
    if (hasSelectedQuestion && !formState.chapters) {
      addSuggestion({
        text: "set the topics or chapters",
        priority: 2,
        commandPatterns: ["set topics", "set chapters", "topics are", "chapters are"],
        requiresPrerequisite: false,
        scrollToField: "chapters"
      });
    }
    
    // Priority 2: Variations count (required)
    if (hasSelectedQuestion && (!formState.num_variations || formState.num_variations < 40)) {
      addSuggestion({
        text: "set number of variations",
        priority: 2,
        commandPatterns: ["set variations", "generate variations", "set number of variations"],
        requiresPrerequisite: false,
        scrollToField: "numVariations"
      });
    }
    
    // No optional fields - language is now required and suggested earlier in the flow
    
    // Priority 1: Ready to generate
    if (this._isReadyToGenerate(formState)) {
      addSuggestion({
        text: "start generation",
        priority: 1,
        commandPatterns: ["generate", "start generation", "click generate"],
        requiresPrerequisite: false
      });
    }
    
    // Priority 3: Utility actions
    if (hasSelectedQuestion) {
      addSuggestion({
        text: "clear the form",
        priority: 3,
        commandPatterns: ["clear form", "reset form", "start over"],
        requiresPrerequisite: false
      });
    }
    
    return suggestions;
  }

  /**
   * Check if form is ready to generate variations
   * @param {Object} formState - Current form state
   * @returns {boolean} True if ready to generate
   */
  _isReadyToGenerate(formState) {
    // Check required fields
    if (!formState.selectedTemplate) return false;
    if (!formState.paperName) return false;
    if (!formState.selectedLanguage) return false; // Language is now required
    const languageExplicitlySet = formState.selectedLanguage && formState.selectedLanguage.toLowerCase() !== 'english';
    if (!formState.languageConfirmed && !languageExplicitlySet) return false;
    if (!(formState.selectedQuestion || formState.selectedQuestionNumber)) return false;
    if (!formState.subject) return false;
    if (!formState.chapters) return false; // Topics/chapters is required
    if (!formState.num_variations || formState.num_variations < 40) return false;
    
    // Check if sub-question is required
    const hasSubQuestions = formState.selectedQuestion?.sub_questions?.length > 0 ||
                           formState.selectedQuestion?.subquestions?.length > 0;
    if (hasSubQuestions && !formState.selectedSubQuestion) return false;
    
    return true;
  }
}

module.exports = GenerateQuestionsContext;
