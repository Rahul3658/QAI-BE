/**
 * RateLimiter - Tracks and enforces RPM and TPM limits for Gemini API
 * 
 * Implements rolling 60-second windows to track:
 * - RPM (Requests Per Minute): Max 2,000 requests/minute
 * - TPM (Tokens Per Minute): Max 3,000,000 tokens/minute
 * 
 * Operates at 80% safety margin to prevent edge cases
 */

class RateLimiter {
  constructor(config = {}) {
    this.rpmLimit = config.rpmLimit || 2000;
    this.tpmLimit = config.tpmLimit || 3000000;
    this.safetyMargin = config.safetyMargin || 0.8; // Use 80% of quota
    
    // Rolling windows (60 seconds)
    this.requestTimestamps = []; // Array of timestamps
    this.tokenUsage = []; // Array of {timestamp, tokens}
  }
  
  /**
   * Check if we can make a request with estimated tokens
   * @param {number} estimatedTokens - Estimated token consumption
   * @returns {Object} Budget check result
   */
  canMakeRequest(estimatedTokens) {
    this.cleanOldEntries();
    
    const currentRPM = this.requestTimestamps.length;
    const currentTPM = this.tokenUsage.reduce((sum, entry) => sum + entry.tokens, 0);
    
    const rpmAvailable = currentRPM < (this.rpmLimit * this.safetyMargin);
    const tpmAvailable = (currentTPM + estimatedTokens) < (this.tpmLimit * this.safetyMargin);
    
    return {
      canProceed: rpmAvailable && tpmAvailable,
      currentRPM,
      currentTPM,
      estimatedTPM: currentTPM + estimatedTokens,
      rpmLimit: Math.floor(this.rpmLimit * this.safetyMargin),
      tpmLimit: Math.floor(this.tpmLimit * this.safetyMargin),
      waitReason: !rpmAvailable ? 'RPM' : !tpmAvailable ? 'TPM' : null
    };
  }
  
  /**
   * Wait until budget is available for the request
   * @param {number} estimatedTokens - Estimated token consumption
   * @param {number} maxWaitMs - Maximum wait time in milliseconds
   * @returns {Promise<Object>} Budget check result when available
   */
  async waitForBudget(estimatedTokens, maxWaitMs = 120000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitMs) {
      const check = this.canMakeRequest(estimatedTokens);
      
      if (check.canProceed) {
        return check;
      }
      
      // Calculate wait time until oldest entry expires
      const oldestTimestamp = Math.min(
        this.requestTimestamps[0] || Date.now(),
        this.tokenUsage[0]?.timestamp || Date.now()
      );
      const waitMs = Math.max(1000, 60000 - (Date.now() - oldestTimestamp));
      
      console.log(`⏳ Rate limit: waiting ${(waitMs/1000).toFixed(1)}s (${check.waitReason} budget)`);
      await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, 5000)));
    }
    
    throw new Error('Rate limit wait timeout exceeded');
  }

  
  /**
   * Record a completed request with actual token consumption
   * @param {number} actualTokens - Actual tokens consumed
   */
  recordRequest(actualTokens) {
    const now = Date.now();
    this.requestTimestamps.push(now);
    this.tokenUsage.push({ timestamp: now, tokens: actualTokens });
    this.cleanOldEntries();
  }
  
  /**
   * Remove entries older than 60 seconds from rolling windows
   */
  cleanOldEntries() {
    const cutoff = Date.now() - 60000; // 60 seconds ago
    this.requestTimestamps = this.requestTimestamps.filter(ts => ts > cutoff);
    this.tokenUsage = this.tokenUsage.filter(entry => entry.timestamp > cutoff);
  }
  
  /**
   * Get current usage statistics
   * @returns {Object} Usage stats with utilization percentages
   */
  getUsageStats() {
    this.cleanOldEntries();
    
    const currentRPM = this.requestTimestamps.length;
    const currentTPM = this.tokenUsage.reduce((sum, entry) => sum + entry.tokens, 0);
    const rpmLimit = Math.floor(this.rpmLimit * this.safetyMargin);
    const tpmLimit = Math.floor(this.tpmLimit * this.safetyMargin);
    
    return {
      currentRPM,
      currentTPM,
      rpmLimit,
      tpmLimit,
      rpmUtilization: (currentRPM / rpmLimit * 100).toFixed(1),
      tpmUtilization: (currentTPM / tpmLimit * 100).toFixed(1)
    };
  }
}

// Singleton instance
let rateLimiterInstance = null;

/**
 * Get or create the singleton RateLimiter instance
 * @returns {RateLimiter} Singleton instance
 */
function getRateLimiter() {
  if (!rateLimiterInstance) {
    rateLimiterInstance = new RateLimiter({
      rpmLimit: 2000,
      tpmLimit: 3000000,
      safetyMargin: 0.8
    });
  }
  return rateLimiterInstance;
}

module.exports = {
  RateLimiter,
  getRateLimiter
};
