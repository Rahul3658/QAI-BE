/**
 * ContextPlugin - Base class for voice assistant context plugins
 * 
 * Each workflow context (Generate Questions, PDF Library, etc.) extends this class
 * to define available functions and execution logic.
 */

class ContextPlugin {
  /**
   * Get the unique name of this context
   * @returns {string} Context name
   */
  getName() {
    throw new Error('ContextPlugin.getName() must be implemented');
  }

  /**
   * Get function definitions for Gemini API
   * @returns {Array} Array of function definition objects
   */
  getFunctionDefinitions() {
    throw new Error('ContextPlugin.getFunctionDefinitions() must be implemented');
  }

  /**
   * Execute a function call
   * @param {string} functionName - Name of function to execute
   * @param {Object} parameters - Function parameters
   * @param {Object} formState - Current UI form state
   * @returns {Promise<Object>} Execution result { success, result, error, message }
   */
  async executeFunction(functionName, parameters, formState) {
    throw new Error('ContextPlugin.executeFunction() must be implemented');
  }

  /**
   * Get system prompt for this context
   * @param {Object} formState - Current UI form state
   * @returns {string} System prompt text
   */
  getSystemPrompt(formState) {
    throw new Error('ContextPlugin.getSystemPrompt() must be implemented');
  }

  /**
   * Validate form state for this context
   * @param {Object} formState - Form state to validate
   * @returns {Object} Validation result { valid, errors }
   */
  validateFormState(formState) {
    // Default implementation - can be overridden
    return { valid: true, errors: [] };
  }

  /**
   * Get context metadata
   * @returns {Object} Metadata { displayName, description, supportedActions }
   */
  getMetadata() {
    return {
      displayName: this.getName(),
      description: 'No description provided',
      supportedActions: this.getFunctionDefinitions().map(f => f.name)
    };
  }

  /**
   * Get suggested next actions based on current workflow state
   * @param {Object} formState - Current UI state
   * @param {string|null} lastAction - Last executed function name
   * @returns {Array<Object>} Array of suggestion objects
   * 
   * Each suggestion object should have:
   * {
   *   text: string,              // Natural language description: "select a template"
   *   priority: number,          // 1=high, 2=medium, 3=low
   *   commandPatterns: string[], // Recognized command variations
   *   requiresPrerequisite: boolean // Whether action needs prior steps
   * }
   */
  getSuggestedNextActions(formState, lastAction) {
    // Default implementation - can be overridden by subclasses
    return [];
  }
}

module.exports = ContextPlugin;
