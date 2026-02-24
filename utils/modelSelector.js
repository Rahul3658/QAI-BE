/**
 * ModelSelector - Manages Gemini model selection with fallback for overload scenarios
 * 
 * Handles automatic model switching when encountering 503 errors due to server overload.
 * Maintains a list of available models and tracks which ones are currently overloaded.
 */

const axios = require('axios');

class ModelSelector {
  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY;
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
    
    // Preferred models in speed-priority order for optimal performance
    // Optimized for fastest response times with large context support
    this.preferredModels = [
      'gemini-2.0-flash-exp',       // Primary: Fastest & Large Context
      'gemini-1.5-flash-8b',        // Secondary: Ultra-fast fallback
      'gemini-1.5-flash-002',       // Tertiary: Stable production
      'gemini-1.5-flash-001',       // Stable 1.5 flash
      'gemini-1.5-flash',           // Generic 1.5 flash
      'gemini-exp-1121',            // Experimental but stable
      'gemini-1.5-pro-002',         // Pro models as fallback
      'gemini-1.5-pro-001',
      'gemini-1.5-pro',
      'gemini-2.0-flash-thinking-exp-1219', // Thinking model (slower but reliable)
      'gemini-exp-1206'             // Last resort experimental
  ];
    
    // Track overloaded models with timestamps
    this.overloadedModels = new Map(); // modelName -> timestamp
    this.overloadCooldownMs = 300000; // 5 minutes cooldown
    
    // Cache for available models
    this._modelListCache = null;
    this._cacheExpiresAt = 0;
    this._cacheTTL = 3600000; // 1 hour
    
    // Current model being used
    this.currentModel = null;
    this.consecutiveOverloadErrors = 0;
  }
  
  /**
   * List all available models from Gemini API
   * @returns {Promise<Array>} List of model objects
   */
  async listAvailableModels() {
    const now = Date.now();
    
    // Return cached models if still valid
    if (this._modelListCache && this._cacheExpiresAt > now) {
      return this._modelListCache;
    }
    
    try {
      const url = `${this.baseUrl}/models?key=${this.apiKey}`;
      const response = await axios.get(url, { timeout: 10000 });
      const models = Array.isArray(response.data?.models) ? response.data.models : [];
      
      // Cache the results
      this._modelListCache = models;
      this._cacheExpiresAt = now + this._cacheTTL;
      
      console.log(`📋 Available models: ${models.map(m => m.name).join(', ')}`);
      return models;
    } catch (error) {
      console.warn('⚠️ Failed to list models:', error.message);
      // Return cached models if available, even if expired
      if (this._modelListCache) {
        return this._modelListCache;
      }
      throw error;
    }
  }
  
  /**
   * Clean up overloaded models that have passed cooldown period
   */
  cleanupOverloadedModels() {
    const now = Date.now();
    const cutoff = now - this.overloadCooldownMs;
    
    for (const [modelName, timestamp] of this.overloadedModels.entries()) {
      if (timestamp < cutoff) {
        this.overloadedModels.delete(modelName);
        console.log(`✅ Model ${modelName} cooldown complete, back in rotation`);
      }
    }
  }
  
  /**
   * Check if a model is currently marked as overloaded
   * @param {string} modelName - Model name to check
   * @returns {boolean} True if model is overloaded
   */
  isModelOverloaded(modelName) {
    this.cleanupOverloadedModels();
    return this.overloadedModels.has(modelName);
  }
  
  /**
   * Mark a model as overloaded
   * @param {string} modelName - Model name to mark
   */
  markModelOverloaded(modelName) {
    this.overloadedModels.set(modelName, Date.now());
    this.consecutiveOverloadErrors++;
    console.log(`🚨 Model ${modelName} marked as overloaded (consecutive errors: ${this.consecutiveOverloadErrors})`);
  }
  
  /**
   * Select the best available model for question generation
   * @param {boolean} excludeOverloaded - Whether to exclude overloaded models
   * @returns {Promise<string>} Selected model name (without 'models/' prefix)
   */
  async selectBestModel(excludeOverloaded = true) {
    try {
      const availableModels = await this.listAvailableModels();
      const availableModelNames = availableModels.map(m => m.name);
      
      // Find first preferred model that is available and not overloaded
      for (const preferredModel of this.preferredModels) {
        const matchingModel = availableModelNames.find(name => name.includes(preferredModel));
        
        if (matchingModel) {
          // Extract model name without 'models/' prefix
          const cleanModelName = matchingModel.replace(/^models\//, '');
          
          if (excludeOverloaded && this.isModelOverloaded(cleanModelName)) {
            console.log(`⏭️  Skipping overloaded model: ${cleanModelName}`);
            continue;
          }
          
          this.currentModel = cleanModelName;
          console.log(`✅ Selected model: ${cleanModelName}`);
          return cleanModelName;
        }
      }
      
      // If no preferred model found, use first available non-overloaded model
      const fallbackModel = availableModelNames.find(name => 
        !excludeOverloaded || !this.isModelOverloaded(name.replace(/^models\//, ''))
      );
      
      if (fallbackModel) {
        const cleanModelName = fallbackModel.replace(/^models\//, '');
        this.currentModel = cleanModelName;
        console.log(`⚠️  Using fallback model: ${cleanModelName}`);
        return cleanModelName;
      }
      
      // If all models are overloaded, use the first available one anyway
      if (excludeOverloaded && availableModelNames.length > 0) {
        const cleanModelName = availableModelNames[0].replace(/^models\//, '');
        this.currentModel = cleanModelName;
        console.log(`🆘 All models overloaded, forcing use of: ${this.currentModel}`);
        return this.currentModel;
      }
      
      throw new Error('No available models found');
    } catch (error) {
      console.error('❌ Model selection failed:', error.message);
      throw error;
    }
  }
  
  /**
   * Handle overload error and switch to alternative model
   * @returns {Promise<Object>} Result with new model and batch size adjustment
   */
  async handleOverloadAndSwitch() {
    if (this.currentModel) {
      this.markModelOverloaded(this.currentModel);
    }
    
    // Try to select a different model
    const newModel = await this.selectBestModel(true);
    
    // Fail-Fast: Reduce batch size immediately after first overload error
    // This allows faster adaptation when server is busy
    const shouldReduceBatchSize = this.consecutiveOverloadErrors >= 1;
    
    return {
      newModel,
      shouldReduceBatchSize,
      consecutiveErrors: this.consecutiveOverloadErrors
    };
  }
  
  /**
   * Reset consecutive error counter (call after successful request)
   */
  resetErrorCounter() {
    if (this.consecutiveOverloadErrors > 0) {
      console.log(`✅ Resetting error counter (was ${this.consecutiveOverloadErrors})`);
      this.consecutiveOverloadErrors = 0;
    }
  }
  
  /**
   * Get current model being used
   * @returns {string|null} Current model name
   */
  getCurrentModel() {
    return this.currentModel;
  }
  
  /**
   * Get statistics about model usage
   * @returns {Object} Statistics object
   */
  getStats() {
    return {
      currentModel: this.currentModel,
      consecutiveOverloadErrors: this.consecutiveOverloadErrors,
      overloadedModelsCount: this.overloadedModels.size,
      overloadedModels: Array.from(this.overloadedModels.keys())
    };
  }
}

// Singleton instance
let modelSelectorInstance = null;

/**
 * Get or create the singleton ModelSelector instance
 * @returns {ModelSelector} Singleton instance
 */
function getModelSelector() {
  if (!modelSelectorInstance) {
    modelSelectorInstance = new ModelSelector();
  }
  return modelSelectorInstance;
}

module.exports = {
  ModelSelector,
  getModelSelector
};
