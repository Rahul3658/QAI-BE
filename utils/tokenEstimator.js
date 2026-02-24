/**
 * TokenEstimator - Estimates token consumption for Gemini API requests
 * 
 * Provides accurate token estimates before making API calls to enable
 * proper TPM budget tracking and rate limiting.
 */

class TokenEstimator {
  /**
   * Estimate tokens for a text string based on language
   * @param {string} text - Text to estimate tokens for
   * @param {string} language - Language of the text (english, hindi, marathi, urdu)
   * @returns {number} Estimated token count
   */
  static estimateTokens(text, language = 'english') {
    if (!text) return 0;
    
    // Character-to-token ratios by language
    const ratios = {
      english: 4,    // ~4 chars per token
      hindi: 3,      // Devanagari script is denser
      marathi: 3,
      urdu: 3
    };
    
    const ratio = ratios[language.toLowerCase()] || 4;
    return Math.ceil(text.length / ratio);
  }
  
  /**
   * Estimate output tokens based on question type and batch size
   * @param {string} questionType - Type of question (mcq, short_answer, etc.)
   * @param {number} batchSize - Number of variations in batch
   * @returns {number} Estimated output token count
   */
  static estimateOutputTokens(questionType, batchSize) {
    const tokensPerVariation = {
      'mcq': 350,
      'short_answer': 500,
      'long_answer': 500,
      'true_false': 300,
      'fill_in_blanks': 350,
      'numerical': 350,
      'diagram': 450,
      'case_study': 600,
      'practical': 500,
      'coding': 550
    };
    
    const baseTokens = tokensPerVariation[questionType] || 400;
    return batchSize * baseTokens;
  }
  
  /**
   * Estimate total token budget for a request
   * @param {string} prompt - The prompt text
   * @param {string} questionType - Type of question
   * @param {number} batchSize - Number of variations
   * @param {boolean} useFileSearch - Whether File Search is enabled
   * @param {string} language - Language of the content
   * @returns {Object} Token estimate breakdown
   */
  static estimateTotalTokens(prompt, questionType, batchSize, useFileSearch, language = 'english') {
    // Input tokens
    const promptTokens = this.estimateTokens(prompt, language);
    const fileSearchOverhead = useFileSearch ? 2000 : 0;
    const inputTokens = promptTokens + fileSearchOverhead;
    
    // Output tokens
    const outputTokens = this.estimateOutputTokens(questionType, batchSize);
    
    // Total with 10% safety buffer
    const total = Math.ceil((inputTokens + outputTokens) * 1.1);
    
    return {
      inputTokens,
      outputTokens,
      total,
      breakdown: {
        prompt: promptTokens,
        fileSearch: fileSearchOverhead,
        output: outputTokens,
        buffer: Math.ceil((inputTokens + outputTokens) * 0.1)
      }
    };
  }
}

module.exports = TokenEstimator;
