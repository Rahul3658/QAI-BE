/**
 * ModeratorCategorizationContext - Voice assistant context for moderator categorization workflow
 * 
 * Provides functions for controlling the Moderator Categorization interface:
 * - Tab switching (pending/approvals)
 * - View paper details
 * - Expand sub-questions
 * - Generate 40 unique sets
 * - View specific sets
 * - AI categorization
 * - Save categorization
 */

const ContextPlugin = require('../ContextPlugin');

class ModeratorCategorizationContext extends ContextPlugin {
  getName() {
    return 'moderator-categorization';
  }

  getFunctionDefinitions() {
    return [
      {
        name: 'switch_tab',
        description: 'ALWAYS call this when user mentions switching tabs, going to a tab, or mentions "pending" or "approvals". Matches: "go to pending tab", "go to approvals tab", "switch to pending", "show approvals", "pending", "approvals".',
        parameters: {
          type: 'object',
          properties: {
            tab_name: {
              type: 'string',
              enum: ['pending', 'approvals'],
              description: 'Tab to switch to: "pending" or "approvals". If user says "pending" use "pending", if they say "approvals" or "approval" use "approvals".'
            }
          },
          required: ['tab_name']
        }
      },
      {
        name: 'view_paper_details',
        description: 'ALWAYS call this when user says "view details", "click on view details", "open paper", "show paper", or mentions a paper name. Extract the paper name or number from the command. If user just says "view details of paper" without specifying which one, use "1" as default.',
        parameters: {
          type: 'object',
          properties: {
            paper_identifier: {
              type: 'string',
              description: 'Paper name/title or index number extracted from user command. Examples: "Medium 2007", "BCA 2023", "1", "first", "2", "last". If not specified, use "1".'
            }
          },
          required: ['paper_identifier']
        }
      },
      {
        name: 'expand_sub_question',
        description: 'Expand a specific sub-question to view its variations. User can say "expand question 1" or "expand sub-question 2".',
        parameters: {
          type: 'object',
          properties: {
            question_number: {
              type: 'string',
              description: 'Question number or identifier (e.g., "1", "1a", "2b")'
            }
          },
          required: ['question_number']
        }
      },
      {
        name: 'generate_40_sets',
        description: 'ALWAYS call this when user says "generate", "generate sets", "generate 40", "create sets", "40 sets", or "click on generate". No parameters needed.',
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'click_set',
        description: 'ALWAYS call this when user says "click on set", "select set", or just mentions a set number. This opens the category selection modal.',
        parameters: {
          type: 'object',
          properties: {
            set_number: {
              type: 'integer',
              minimum: 1,
              maximum: 40,
              description: 'Set number to click (1-40)'
            }
          },
          required: ['set_number']
        }
      },
      {
        name: 'view_set_questions',
        description: 'ALWAYS call this when user specifically says "view questions", "click on view questions button", "show questions for set X".',
        parameters: {
          type: 'object',
          properties: {
            set_number: {
              type: 'integer',
              minimum: 1,
              maximum: 40,
              description: 'Set number to view questions for (1-40)'
            }
          },
          required: ['set_number']
        }
      },
      {
        name: 'select_category',
        description: 'ALWAYS call this when user says a category name: "general", "reexam", "re-exam", "special", or "special case". Selects the category in the modal.',
        parameters: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: ['general', 'reexam', 'special'],
              description: 'Category to select: "general", "reexam", or "special"'
            }
          },
          required: ['category']
        }
      },
      {
        name: 'cancel_category_modal',
        description: 'ALWAYS call this when user says "cancel" while category modal is open. Closes the category selection modal.',
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'ai_categorize',
        description: 'ALWAYS call this when user says "AI", "categorize", "AI categorization", "categorization", "AI categorize", or "click on AI". No parameters needed.',
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'save_categorization',
        description: 'ALWAYS call this when user says "save", "save categorization", "move to approval", "save and approve", or "submit". No parameters needed.',
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'view_finalized_paper',
        description: 'ALWAYS call this when user says "view categorized sets", "view finalized paper", "click on view categorized sets", or mentions viewing a paper in approvals tab. Extract paper name or number.',
        parameters: {
          type: 'object',
          properties: {
            paper_identifier: {
              type: 'string',
              description: 'Paper name/title or index number (e.g., "Medium 2007", "mid term 2031", "1", "first"). If not specified, use "1".'
            }
          },
          required: ['paper_identifier']
        }
      },
      {
        name: 'query_status',
        description: 'Query the current status of the workflow. User can say "what\'s the status?" or "where am I?".',
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'confirm_modal',
        description: 'ALWAYS call this when user says "confirm", "yes", "ok", "click on confirm", "click confirm button", or "proceed". Confirms the current modal action.',
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'cancel_modal',
        description: 'ALWAYS call this when user says "cancel", "no", "click on cancel", "click cancel button", or "close modal". Cancels the current modal action.',
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'close_viewing_set',
        description: 'ALWAYS call this when user says "close", "close questions", "click on close button" while viewing set questions.',
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'preview_paper',
        description: 'ALWAYS call this when user says "preview", "preview and edit", "preview set X", "click on preview and edit button", or "click on preview button". Extract set number if mentioned.',
        parameters: {
          type: 'object',
          properties: {
            set_number: {
              type: 'integer',
              minimum: 1,
              description: 'Set number to preview (e.g., 5 from "preview set 5"). Required if user mentions a specific set number.'
            }
          }
        }
      },
      {
        name: 'close_preview',
        description: 'ALWAYS call this when user says "close preview", "close", "click on close button" while previewing a paper.',
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'download_ai_pdf',
        description: 'ALWAYS call this when user says "download", "download PDF", "download AI PDF", "click on download button".',
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'go_back_to_approvals',
        description: 'ALWAYS call this when user says "go back", "go back to approvals", "back to approvals", "click on back button".',
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'view_categorized_sets',
        description: 'ALWAYS call this when user says "view categorized sets", "click on view categorized sets button", "show categorized sets" for a specific paper. Extract paper name or number.',
        parameters: {
          type: 'object',
          properties: {
            paper_identifier: {
              type: 'string',
              description: 'Paper name/title or index number (e.g., "mid term 2031", "1", "first")'
            }
          },
          required: ['paper_identifier']
        }
      }
    ];
  }

  async executeFunction(functionName, args, formState) {
    console.log(`🎯 Executing ${functionName} with args:`, args);
    console.log('📋 Form state:', formState);

    const updatedState = {};

    switch (functionName) {
      case 'switch_tab':
        updatedState.shouldSwitchTab = true;
        updatedState.targetTab = args.tab_name;
        return {
          success: true,
          message: `Switching to ${args.tab_name} tab.`,
          result: updatedState
        };

      case 'view_paper_details':
        const papers = formState.activeTab === 'pending' 
          ? formState.pendingPapers 
          : formState.finalizedPapers;
        
        if (!papers || papers.length === 0) {
          return {
            success: false,
            message: `No papers available in the ${formState.activeTab} tab.`,
            result: {}
          };
        }

        const identifier = args.paper_identifier.toLowerCase().trim();
        let paper = null;
        let matchType = '';

        // Try to find by paper title (fuzzy match)
        paper = papers.find(p => 
          p.paper_title && p.paper_title.toLowerCase().includes(identifier)
        );
        
        if (paper) {
          matchType = 'title';
        } else {
          // Try to find by exact title match
          paper = papers.find(p => 
            p.paper_title && p.paper_title.toLowerCase() === identifier
          );
          
          if (paper) {
            matchType = 'exact title';
          } else {
            // Try to parse as index number
            const indexMatch = identifier.match(/(\d+)/);
            if (indexMatch) {
              const paperIndex = parseInt(indexMatch[1]) - 1;
              if (paperIndex >= 0 && paperIndex < papers.length) {
                paper = papers[paperIndex];
                matchType = 'index';
              }
            } else if (identifier === 'first' || identifier === '1st') {
              paper = papers[0];
              matchType = 'first';
            } else if (identifier === 'second' || identifier === '2nd') {
              paper = papers[1];
              matchType = 'second';
            } else if (identifier === 'third' || identifier === '3rd') {
              paper = papers[2];
              matchType = 'third';
            } else if (identifier === 'last') {
              paper = papers[papers.length - 1];
              matchType = 'last';
            }
          }
        }

        if (!paper) {
          // Try partial match with any word in the title
          const words = identifier.split(/\s+/);
          for (const word of words) {
            if (word.length >= 3) { // Only match words with 3+ characters
              paper = papers.find(p => 
                p.paper_title && p.paper_title.toLowerCase().includes(word)
              );
              if (paper) {
                matchType = 'partial';
                break;
              }
            }
          }
        }

        if (!paper) {
          const availableTitles = papers.map((p, i) => `${i + 1}. ${p.paper_title}`).join(', ');
          return {
            success: false,
            message: `Paper "${args.paper_identifier}" not found. Available papers: ${availableTitles}`,
            result: {}
          };
        }

        updatedState.shouldViewPaper = true;
        updatedState.paperId = paper.paper_id;
        updatedState.paperTitle = paper.paper_title;

        return {
          success: true,
          message: `Opening details for ${paper.paper_title}.`,
          result: updatedState
        };

      case 'expand_sub_question':
        if (!formState.paperQuestions || formState.paperQuestions.length === 0) {
          return {
            success: false,
            message: 'No questions available. Please open a paper first.',
            result: {}
          };
        }

        // Find the question by number
        let foundQuestion = null;
        let questionIndex = -1;
        let subQuestionIndex = -1;

        for (let qIdx = 0; qIdx < formState.paperQuestions.length; qIdx++) {
          const question = formState.paperQuestions[qIdx];
          if (question.sub_questions) {
            for (let sqIdx = 0; sqIdx < question.sub_questions.length; sqIdx++) {
              const subQuestion = question.sub_questions[sqIdx];
              
              // Try multiple matching strategies
              const questionNum = args.question_number.toLowerCase().trim();
              const fullNum = (subQuestion.full_question_number || '').toLowerCase();
              const subNum = (subQuestion.sub_question_number || '').toLowerCase();
              const subQuestionNum = (subQuestion.sub_question_number || '').toString();
              
              // Match: 1.1, Q.1.1, question 1.1, etc.
              if (fullNum === questionNum || 
                  subNum === questionNum ||
                  fullNum.includes(questionNum) ||
                  subNum.includes(questionNum) ||
                  questionNum.includes(fullNum) ||
                  questionNum.includes(subNum) ||
                  subQuestionNum === questionNum) {
                foundQuestion = subQuestion;
                questionIndex = qIdx;
                subQuestionIndex = sqIdx;
                break;
              }
            }
          }
          if (foundQuestion) break;
        }

        if (!foundQuestion) {
          return {
            success: false,
            message: `Question ${args.question_number} not found.`,
            result: {}
          };
        }

        updatedState.shouldExpandSubQuestion = true;
        updatedState.questionIndex = questionIndex;
        updatedState.subQuestionIndex = subQuestionIndex;
        updatedState.expandedSubQuestionId = foundQuestion.sub_question_id;
        updatedState.expandedSubQuestionNumber = foundQuestion.full_question_number;

        return {
          success: true,
          message: `Expanding question ${foundQuestion.full_question_number}.`,
          result: updatedState
        };

      case 'generate_40_sets':
        if (!formState.paperId) {
          return {
            success: false,
            message: 'No paper selected. Please open a paper first.',
            result: {}
          };
        }

        if (!formState.canGenerateSets) {
          return {
            success: false,
            message: 'Cannot generate sets for this paper. It may already have sets generated.',
            result: {}
          };
        }

        updatedState.shouldGenerate40Sets = true;
        updatedState.paperId = formState.paperId;

        return {
          success: true,
          message: 'Generating 40 unique sets. This may take a few moments.',
          result: updatedState
        };

      case 'click_set':
        if (!formState.generated40Sets || formState.generated40Sets.length === 0) {
          return {
            success: false,
            message: 'No sets available. Please generate 40 sets first.',
            result: {}
          };
        }

        const setIndex = args.set_number - 1;
        if (setIndex < 0 || setIndex >= formState.generated40Sets.length) {
          return {
            success: false,
            message: `Set ${args.set_number} not found. There are ${formState.generated40Sets.length} sets available.`,
            result: {}
          };
        }

        const setData = formState.generated40Sets[setIndex];
        updatedState.shouldClickSet = true;
        updatedState.setData = setData;

        return {
          success: true,
          message: `Opening category selection for set ${args.set_number}.`,
          result: updatedState
        };

      case 'view_set_questions':
        if (!formState.generated40Sets || formState.generated40Sets.length === 0) {
          return {
            success: false,
            message: 'No sets available. Please generate 40 sets first.',
            result: {}
          };
        }

        const viewSetIndex = args.set_number - 1;
        if (viewSetIndex < 0 || viewSetIndex >= formState.generated40Sets.length) {
          return {
            success: false,
            message: `Set ${args.set_number} not found.`,
            result: {}
          };
        }

        const viewSetData = formState.generated40Sets[viewSetIndex];
        updatedState.shouldViewSetQuestions = true;
        updatedState.setData = viewSetData;

        return {
          success: true,
          message: `Opening questions for set ${args.set_number}.`,
          result: updatedState
        };

      case 'select_category':
        if (!formState.showCategorySelectModal) {
          return {
            success: false,
            message: 'No category selection modal is open.',
            result: {}
          };
        }

        updatedState.shouldSelectCategory = true;
        updatedState.category = args.category;

        const categoryNames = {
          general: 'General',
          reexam: 'Re-Exam',
          special: 'Special'
        };

        return {
          success: true,
          message: `Selected ${categoryNames[args.category]} category.`,
          result: updatedState
        };

      case 'cancel_category_modal':
        if (!formState.showCategorySelectModal) {
          return {
            success: false,
            message: 'No category selection modal is open.',
            result: {}
          };
        }

        updatedState.shouldCancelCategoryModal = true;

        return {
          success: true,
          message: 'Cancelled category selection.',
          result: updatedState
        };

      case 'ai_categorize':
        if (!formState.generated40Sets || formState.generated40Sets.length === 0) {
          return {
            success: false,
            message: 'No sets available. Please generate 40 sets first.',
            result: {}
          };
        }

        if (!formState.canAICategorize) {
          return {
            success: false,
            message: 'AI categorization is not available at this time.',
            result: {}
          };
        }

        updatedState.shouldAICategorize = true;

        return {
          success: true,
          message: 'Starting AI categorization. Sets will be distributed based on quality scores.',
          result: updatedState
        };

      case 'save_categorization':
        if (!formState.canSaveCategorization) {
          return {
            success: false,
            message: 'Cannot save categorization. Please complete AI categorization first.',
            result: {}
          };
        }

        updatedState.shouldSaveCategorization = true;

        return {
          success: true,
          message: 'Saving categorization and moving to approval.',
          result: updatedState
        };

      case 'view_finalized_paper':
        const finalizedPapers = formState.finalizedPapers || [];
        
        if (finalizedPapers.length === 0) {
          return {
            success: false,
            message: 'No finalized papers available.',
            result: {}
          };
        }

        const finalizedIdentifier = args.paper_identifier.toLowerCase().trim();
        let finalizedPaper = null;

        // Try to find by paper title (fuzzy match)
        finalizedPaper = finalizedPapers.find(p => 
          p.paper_title && p.paper_title.toLowerCase().includes(finalizedIdentifier)
        );
        
        if (!finalizedPaper) {
          // Try to find by exact title match
          finalizedPaper = finalizedPapers.find(p => 
            p.paper_title && p.paper_title.toLowerCase() === finalizedIdentifier
          );
        }
        
        if (!finalizedPaper) {
          // Try to parse as index number
          const indexMatch = finalizedIdentifier.match(/(\d+)/);
          if (indexMatch) {
            const finalizedIndex = parseInt(indexMatch[1]) - 1;
            if (finalizedIndex >= 0 && finalizedIndex < finalizedPapers.length) {
              finalizedPaper = finalizedPapers[finalizedIndex];
            }
          } else if (finalizedIdentifier === 'first' || finalizedIdentifier === '1st') {
            finalizedPaper = finalizedPapers[0];
          } else if (finalizedIdentifier === 'last') {
            finalizedPaper = finalizedPapers[finalizedPapers.length - 1];
          }
        }

        if (!finalizedPaper) {
          // Try partial match with any word in the title
          const words = finalizedIdentifier.split(/\s+/);
          for (const word of words) {
            if (word.length >= 3) {
              finalizedPaper = finalizedPapers.find(p => 
                p.paper_title && p.paper_title.toLowerCase().includes(word)
              );
              if (finalizedPaper) break;
            }
          }
        }

        if (!finalizedPaper) {
          const availableTitles = finalizedPapers.map((p, i) => `${i + 1}. ${p.paper_title}`).join(', ');
          return {
            success: false,
            message: `Finalized paper "${args.paper_identifier}" not found. Available papers: ${availableTitles}`,
            result: {}
          };
        }

        updatedState.shouldViewFinalizedPaper = true;
        updatedState.paperId = finalizedPaper.paper_id;

        return {
          success: true,
          message: `Opening categorized sets for ${finalizedPaper.paper_title}.`,
          result: updatedState
        };

      case 'query_status':
        let statusMessage = '';

        if (formState.activeTab === 'pending') {
          const pendingCount = formState.pendingPapers?.length || 0;
          statusMessage = `You are on the pending tab with ${pendingCount} paper${pendingCount !== 1 ? 's' : ''}.`;
          
          if (formState.paperId) {
            statusMessage += ` Currently viewing ${formState.paperTitle}.`;
            
            if (formState.generated40Sets && formState.generated40Sets.length > 0) {
              statusMessage += ` ${formState.generated40Sets.length} sets have been generated.`;
              
              if (formState.canAICategorize) {
                statusMessage += ' You can now use AI categorization.';
              }
              
              if (formState.canSaveCategorization) {
                statusMessage += ' Categorization is ready to be saved.';
              }
            } else if (formState.canGenerateSets) {
              statusMessage += ' You can generate 40 unique sets.';
            }
          }
        } else if (formState.activeTab === 'approvals') {
          const approvalCount = formState.finalizedPapers?.length || 0;
          statusMessage = `You are on the approvals tab with ${approvalCount} finalized paper${approvalCount !== 1 ? 's' : ''}.`;
        }

        return {
          success: true,
          message: statusMessage,
          result: {}
        };

      case 'confirm_modal':
        if (!formState.showConfirmModal) {
          return {
            success: false,
            message: 'No modal is currently open to confirm.',
            result: {}
          };
        }

        updatedState.shouldConfirmModal = true;

        return {
          success: true,
          message: `Confirming ${formState.confirmModalTitle || 'action'}.`,
          result: updatedState
        };

      case 'cancel_modal':
        if (!formState.showConfirmModal) {
          return {
            success: false,
            message: 'No modal is currently open to cancel.',
            result: {}
          };
        }

        updatedState.shouldCancelModal = true;

        return {
          success: true,
          message: 'Cancelled.',
          result: updatedState
        };

      case 'close_viewing_set':
        if (!formState.isViewingSet) {
          return {
            success: false,
            message: 'No set is currently being viewed.',
            result: {}
          };
        }

        updatedState.shouldCloseViewingSet = true;

        return {
          success: true,
          message: 'Closing set view.',
          result: updatedState
        };

      case 'preview_paper':
        // If set_number provided, find that set's paper
        if (args.set_number) {
          // First check categorized papers (approvals tab)
          if (formState.categorizedPapers && formState.categorizedPapers.length > 0) {
            // Find the set by number in categorized papers
            const categorizedSet = formState.categorizedPapers.find(p => {
              const setNumberMatch = p.paper_title.match(/Set (\d+)$/);
              return setNumberMatch && parseInt(setNumberMatch[1]) === args.set_number;
            });

            if (categorizedSet) {
              updatedState.shouldPreviewPaper = true;
              updatedState.paperId = categorizedSet.paper_id;
              updatedState.paperTitle = categorizedSet.paper_title;

              return {
                success: true,
                message: `Opening preview for set ${args.set_number}.`,
                result: updatedState
              };
            }
          }

          // Then check generated40Sets (pending tab)
          if (formState.generated40Sets && formState.generated40Sets.length > 0) {
            const previewSetIndex = args.set_number - 1;
            if (previewSetIndex >= 0 && previewSetIndex < formState.generated40Sets.length) {
              const previewSet = formState.generated40Sets[previewSetIndex];
              updatedState.shouldPreviewPaper = true;
              updatedState.paperId = previewSet.paper_id;
              updatedState.paperTitle = previewSet.paper_title || `Set ${args.set_number}`;

              return {
                success: true,
                message: `Opening preview for set ${args.set_number}.`,
                result: updatedState
              };
            }
          }

          return {
            success: false,
            message: `Set ${args.set_number} not found.`,
            result: {}
          };
        }

        // Otherwise use current viewing set or paper
        if (formState.viewingSet) {
          updatedState.shouldPreviewPaper = true;
          updatedState.paperId = formState.viewingSet.paper_id;
          updatedState.paperTitle = formState.viewingSet.paper_title || 'Current Set';

          return {
            success: true,
            message: 'Opening preview.',
            result: updatedState
          };
        }

        if (formState.paperId) {
          updatedState.shouldPreviewPaper = true;
          updatedState.paperId = formState.paperId;
          updatedState.paperTitle = formState.paperTitle;

          return {
            success: true,
            message: 'Opening preview.',
            result: updatedState
          };
        }

        return {
          success: false,
          message: 'No paper or set selected to preview.',
          result: {}
        };

      case 'close_preview':
        if (!formState.isPreviewingPaper) {
          return {
            success: false,
            message: 'No preview is currently open.',
            result: {}
          };
        }

        updatedState.shouldClosePreview = true;

        return {
          success: true,
          message: 'Closing preview.',
          result: updatedState
        };

      case 'download_ai_pdf':
        if (!formState.isPreviewingPaper && !formState.paperId) {
          return {
            success: false,
            message: 'No paper available to download.',
            result: {}
          };
        }

        updatedState.shouldDownloadPDF = true;
        updatedState.paperId = formState.paperId;
        updatedState.paperTitle = formState.paperTitle;

        return {
          success: true,
          message: 'Downloading AI-enhanced PDF.',
          result: updatedState
        };

      case 'go_back_to_approvals':
        updatedState.shouldGoBackToApprovals = true;

        return {
          success: true,
          message: 'Going back to approvals.',
          result: updatedState
        };

      case 'view_categorized_sets':
        // This is an alias for view_finalized_paper
        const categorizedPapers = formState.finalizedPapers || [];
        
        if (categorizedPapers.length === 0) {
          return {
            success: false,
            message: 'No finalized papers available.',
            result: {}
          };
        }

        const categorizedIdentifier = args.paper_identifier.toLowerCase().trim();
        let categorizedPaper = null;

        // Try to find by paper title (fuzzy match)
        categorizedPaper = categorizedPapers.find(p => 
          p.paper_title && p.paper_title.toLowerCase().includes(categorizedIdentifier)
        );
        
        if (!categorizedPaper) {
          // Try to parse as index number
          const indexMatch = categorizedIdentifier.match(/(\d+)/);
          if (indexMatch) {
            const categorizedIndex = parseInt(indexMatch[1]) - 1;
            if (categorizedIndex >= 0 && categorizedIndex < categorizedPapers.length) {
              categorizedPaper = categorizedPapers[categorizedIndex];
            }
          } else if (categorizedIdentifier === 'first' || categorizedIdentifier === '1st') {
            categorizedPaper = categorizedPapers[0];
          } else if (categorizedIdentifier === 'last') {
            categorizedPaper = categorizedPapers[categorizedPapers.length - 1];
          }
        }

        if (!categorizedPaper) {
          // Try partial match with any word in the title
          const words = categorizedIdentifier.split(/\s+/);
          for (const word of words) {
            if (word.length >= 3) {
              categorizedPaper = categorizedPapers.find(p => 
                p.paper_title && p.paper_title.toLowerCase().includes(word)
              );
              if (categorizedPaper) break;
            }
          }
        }

        if (!categorizedPaper) {
          const availableTitles = categorizedPapers.map((p, i) => `${i + 1}. ${p.paper_title}`).join(', ');
          return {
            success: false,
            message: `Paper "${args.paper_identifier}" not found. Available papers: ${availableTitles}`,
            result: {}
          };
        }

        updatedState.shouldViewFinalizedPaper = true;
        updatedState.paperId = categorizedPaper.paper_id;

        return {
          success: true,
          message: `Opening categorized sets for ${categorizedPaper.paper_title}.`,
          result: updatedState
        };

      default:
        return {
          success: false,
          message: `Unknown function: ${functionName}`,
          result: {}
        };
    }
  }

  getSystemPrompt(formState) {
    const {
      activeTab = 'pending',
      paperId,
      paperTitle,
      paperStatus,
      pendingPapers = [],
      finalizedPapers = [],
      generated40Sets = [],
      viewingSet,
      canGenerateSets = false,
      canAICategorize = false,
      canSaveCategorization = false
    } = formState;

    return `You are a voice assistant for a Moderator Categorization system. Your ONLY job is to call the appropriate function based on user commands.

CRITICAL INSTRUCTION: You MUST ALWAYS call a function. NEVER respond with just text. If the user's command matches any function, call it immediately.

Current Context:
- Active Tab: ${activeTab}
- Pending Papers: ${pendingPapers.length}
- Finalized Papers: ${finalizedPapers.length}
${paperId ? `- Current Paper: ${paperTitle} (ID: ${paperId})` : '- No paper selected'}
${paperId ? `- Paper Status: ${paperStatus || 'Unknown'}` : ''}
${generated40Sets.length > 0 ? `- Generated Sets: ${generated40Sets.length}` : ''}
${viewingSet ? `- Viewing Set: ${viewingSet.set_number}` : ''}
- Can Generate Sets: ${canGenerateSets ? 'Yes' : 'No'}
- Can AI Categorize: ${canAICategorize ? 'Yes' : 'No'}
- Can Save Categorization: ${canSaveCategorization ? 'Yes' : 'No'}

Function Calling Rules:

1. **Tab Navigation**:
   - "go to pending tab" - Switch to pending papers
   - "go to approvals tab" - Switch to finalized papers

2. **Paper Management**:
   - "view details of Medium 2007" - Open details by paper name
   - "view details of paper 1" - Open details by index
   - "click on view details of first paper" - Open first paper
   - "view finalized paper Medium 2007" - View categorized sets by name
   - "view finalized paper 2" - View categorized sets by index

3. **Question Navigation**:
   - "expand question 1" - Expand a specific question
   - "expand sub-question 2b" - Expand a specific sub-question

4. **Set Generation**:
   - "generate 40 unique sets" - Generate 40 question paper sets
   - "click on generate 40 sets button" - Same as above

5. **Set Management**:
   - "view set 5" - Open details for set 5
   - "click on set 10" - Open details for set 10
   - "view questions" - View questions in currently selected set

6. **AI Categorization**:
   - "AI categorization" - Trigger AI-based categorization
   - "click on AI categorization button" - Same as above

7. **Save & Approve**:
   - "save and move to approval" - Save categorization
   - "save categorization" - Same as above

8. **Status Queries**:
   - "what's the status?" - Get current workflow status
   - "where am I?" - Get current location and available actions

9. **Modal Actions**:
   - "confirm" or "yes" or "click on confirm button" - Confirm modal action
   - "cancel" or "no" or "click on cancel button" - Cancel modal action

CRITICAL FUNCTION CALLING RULES:
1. ALWAYS call a function - NEVER just respond with text
2. If user says "go to pending tab" or "go to approvals tab" → call switch_tab
3. If user says "view details" with a paper name/number → call view_paper_details
4. If user says "expand question" → call expand_sub_question
5. If user says "generate 40 sets" or "generate sets" → call generate_40_sets
6. If user says "view set" with a number → call view_set
7. If user says "AI categorization" or "categorize" → call ai_categorize
8. If user says "save" or "move to approval" → call save_categorization
9. If user says "status" or "where am I" → call query_status
10. If command is unclear but matches a pattern, make your best guess and call the function

NEVER say "Please tell me..." or "You can say..." - Just call the appropriate function!

WORKFLOW:
1. View paper details from pending tab
2. Generate 40 unique sets
3. Review sets (optional)
4. Use AI categorization
5. Save and move to approval
6. View finalized papers in approvals tab`;
  }

  getMetadata() {
    return {
      displayName: 'Moderator Categorization',
      description: 'Voice control for moderator paper categorization workflow',
      supportedActions: this.getFunctionDefinitions().map(f => f.name)
    };
  }

  getSuggestedNextActions(formState, lastAction) {
    const suggestions = [];
    
    const {
      activeTab = 'pending',
      paperId,
      pendingPapers = [],
      finalizedPapers = [],
      generated40Sets = [],
      canGenerateSets = false,
      canAICategorize = false,
      canSaveCategorization = false
    } = formState;

    // On pending tab without paper selected
    if (activeTab === 'pending' && !paperId && pendingPapers.length > 0) {
      suggestions.push({
        text: "view details of a paper",
        priority: 1,
        commandPatterns: ["view details", "open paper", "view paper"],
        requiresPrerequisite: false
      });
      return suggestions;
    }

    // Paper selected but no sets generated
    if (paperId && canGenerateSets && generated40Sets.length === 0) {
      suggestions.push({
        text: "generate 40 unique sets",
        priority: 1,
        commandPatterns: ["generate sets", "generate 40 sets", "create sets"],
        requiresPrerequisite: false
      });
      return suggestions;
    }

    // Sets generated but not categorized
    if (generated40Sets.length > 0 && canAICategorize && !canSaveCategorization) {
      suggestions.push({
        text: "use AI categorization",
        priority: 1,
        commandPatterns: ["AI categorize", "AI categorization", "categorize sets"],
        requiresPrerequisite: false
      });
      suggestions.push({
        text: "view a specific set",
        priority: 2,
        commandPatterns: ["view set", "show set", "open set"],
        requiresPrerequisite: false
      });
      return suggestions;
    }

    // Categorization complete, ready to save
    if (canSaveCategorization) {
      suggestions.push({
        text: "save and move to approval",
        priority: 1,
        commandPatterns: ["save categorization", "save and approve", "move to approval"],
        requiresPrerequisite: false
      });
      return suggestions;
    }

    // On approvals tab
    if (activeTab === 'approvals' && finalizedPapers.length > 0) {
      suggestions.push({
        text: "view a finalized paper",
        priority: 1,
        commandPatterns: ["view finalized paper", "view categorized sets", "open finalized paper"],
        requiresPrerequisite: false
      });
      suggestions.push({
        text: "go to pending tab",
        priority: 2,
        commandPatterns: ["go to pending", "switch to pending", "pending tab"],
        requiresPrerequisite: false
      });
      return suggestions;
    }

    // Default suggestions
    suggestions.push({
      text: "ask for status",
      priority: 3,
      commandPatterns: ["what's the status", "where am I", "current status"],
      requiresPrerequisite: false
    });

    return suggestions;
  }
}

module.exports = ModeratorCategorizationContext;
