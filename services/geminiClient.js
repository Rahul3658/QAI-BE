/**
 * GeminiClient - Wrapper for Gemini API with function calling support
 * 
 * Handles:
 * - Function calling for voice assistant
 * - Conversation history management
 * - Token usage tracking
 * - Error handling and retries
 * - Integration with rate limiter and model selector
 */

const axios = require('axios');
const { getRateLimiter } = require('../utils/rateLimiter');
const { getModelSelector } = require('../utils/modelSelector');

class GeminiClient {
  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY;
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
    this.rateLimiter = getRateLimiter();
    this.modelSelector = getModelSelector();
  }

  /**
   * Generate response with function calling support
   * @param {string} prompt - User prompt
   * @param {Array} functions - Function definitions
   * @param {Array} conversationHistory - Previous messages
   * @param {Object} options - Additional options (model override, temperature, etc.)
   * @returns {Promise<Object>} Response with function calls and usage stats
   */
  async generateWithFunctions(prompt, functions = [], conversationHistory = [], options = {}) {
    // Use model selector to get best available model
    const model = options.model || await this.modelSelector.selectBestModel();
    
    // Estimate tokens for rate limiting
    const estimatedTokens = this._estimateTokens(prompt, functions, conversationHistory);
    
    // Wait for rate limit budget
    await this.rateLimiter.waitForBudget(estimatedTokens);
    
    // Build request payload
    const payload = {
      contents: this._buildContents(prompt, conversationHistory),
      generationConfig: {
        temperature: options.temperature || 0.7,
        topK: options.topK || 40,
        topP: options.topP || 0.95,
        maxOutputTokens: options.maxOutputTokens || 2048,
      }
    };

    // Add function declarations if provided
    if (functions && functions.length > 0) {
      payload.tools = [{
        functionDeclarations: functions
      }];
    }

    // Make API request with retry logic
    const response = await this._makeRequestWithRetry(model, payload);
    
    // Record actual token usage
    const actualTokens = response.usageMetadata?.totalTokenCount || estimatedTokens;
    this.rateLimiter.recordRequest(actualTokens);
    this.modelSelector.resetErrorCounter();
    
    // Parse response
    return this._parseResponse(response);
  }

  /**
   * Generate simple text response without function calling
   * @param {string} prompt - User prompt
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Response with text and usage stats
   */
  async generateResponse(prompt, options = {}) {
    // Use model selector to get best available model
    const model = options.model || await this.modelSelector.selectBestModel();
    const estimatedTokens = this._estimateTokens(prompt);
    
    await this.rateLimiter.waitForBudget(estimatedTokens);
    
    const payload = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: options.temperature || 0.7,
        maxOutputTokens: options.maxOutputTokens || 1024,
      }
    };

    const response = await this._makeRequestWithRetry(model, payload);
    
    const actualTokens = response.usageMetadata?.totalTokenCount || estimatedTokens;
    this.rateLimiter.recordRequest(actualTokens);
    this.modelSelector.resetErrorCounter();
    
    return this._parseResponse(response);
  }

  /**
   * Make API request with exponential backoff retry
   * @private
   */
  async _makeRequestWithRetry(model, payload, retryCount = 0) {
    const maxRetries = 3;
    const backoffDelays = [1000, 2000, 4000]; // 1s, 2s, 4s
    
    try {
      const url = `${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`;
      
      console.log(`🤖 Gemini API request (model: ${model}, attempt: ${retryCount + 1})`);
      
      const response = await axios.post(url, payload, {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' }
      });
      
      return response.data;
      
    } catch (error) {
      const status = error.response?.status;
      const errorMessage = error.response?.data?.error?.message || error.message;
      
      console.error(`❌ Gemini API error (attempt ${retryCount + 1}):`, status, errorMessage);
      
      // Handle 503 overload - switch model
      if (status === 503 && retryCount < maxRetries) {
        console.log('🔄 Model overloaded, switching to alternative...');
        const { newModel } = await this.modelSelector.handleOverloadAndSwitch();
        
        // Wait before retry
        await this._sleep(backoffDelays[retryCount] || 4000);
        
        return this._makeRequestWithRetry(newModel, payload, retryCount + 1);
      }
      
      // Handle other retryable errors
      if (this._isRetryableError(status) && retryCount < maxRetries) {
        console.log(`⏳ Retrying in ${backoffDelays[retryCount]}ms...`);
        await this._sleep(backoffDelays[retryCount]);
        return this._makeRequestWithRetry(model, payload, retryCount + 1);
      }
      
      // Non-retryable error or max retries exceeded
      throw new Error(`Gemini API error: ${errorMessage} (status: ${status})`);
    }
  }

  /**
   * Build contents array from prompt and conversation history
   * @private
   */
  _buildContents(prompt, conversationHistory) {
    const contents = [];
    
    // Add conversation history
    for (const message of conversationHistory) {
      contents.push({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }]
      });
    }
    
    // Add current prompt
    contents.push({
      role: 'user',
      parts: [{ text: prompt }]
    });
    
    return contents;
  }

  /**
   * Parse Gemini API response
   * @private
   */
  _parseResponse(response) {
    const candidate = response.candidates?.[0];
    if (!candidate) {
      throw new Error('No response candidate from Gemini API');
    }

    const content = candidate.content;
    const parts = content?.parts || [];
    
    // Extract text response
    const textParts = parts.filter(p => p.text);
    const responseText = textParts.map(p => p.text).join('');
    
    // Extract function calls
    const functionCalls = parts
      .filter(p => p.functionCall)
      .map(p => ({
        name: p.functionCall.name,
        args: p.functionCall.args || {}
      }));
    
    return {
      response: responseText,
      functionCalls,
      usage: {
        promptTokens: response.usageMetadata?.promptTokenCount || 0,
        candidatesTokens: response.usageMetadata?.candidatesTokenCount || 0,
        totalTokens: response.usageMetadata?.totalTokenCount || 0
      }
    };
  }

  /**
   * Estimate token count for rate limiting
   * @private
   */
  _estimateTokens(prompt, functions = [], conversationHistory = []) {
    // Rough estimation: 1 token ≈ 4 characters
    let totalChars = prompt.length;
    
    // Add conversation history
    for (const message of conversationHistory) {
      totalChars += message.content.length;
    }
    
    // Add function definitions (rough estimate)
    totalChars += JSON.stringify(functions).length;
    
    // Add buffer for response
    const estimatedTokens = Math.ceil(totalChars / 4) + 500;
    
    return estimatedTokens;
  }

  /**
   * Check if error is retryable
   * @private
   */
  _isRetryableError(status) {
    return [408, 429, 500, 502, 503, 504].includes(status);
  }

  /**
   * Sleep utility
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton instance
let geminiClientInstance = null;

/**
 * Get or create the singleton GeminiClient instance
 * @returns {GeminiClient} Singleton instance
 */
function getGeminiClient() {
  if (!geminiClientInstance) {
    geminiClientInstance = new GeminiClient();
  }
  return geminiClientInstance;
}

module.exports = {
  GeminiClient,
  getGeminiClient
};
