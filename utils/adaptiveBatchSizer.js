/**
 * AdaptiveBatchSizer - Dynamically adjusts batch size based on API success/failure patterns
 * 
 * Reduces batch size on 503 errors and gradually restores it after consecutive successes.
 * Ensures minimum batch size of 5 variations.
 */

class AdaptiveBatchSizer {
  constructor(initialBatchSize) {
    this.originalBatchSize = initialBatchSize;
    this.currentBatchSize = initialBatchSize;
    this.consecutive503Errors = 0;
    this.consecutiveSuccesses = 0;
    this.minBatchSize = 5;
  }
  
  /**
   * Get current batch size
   * @returns {number} Current batch size
   */
  getCurrentBatchSize() {
    return this.currentBatchSize;
  }
  
  /**
   * Record 503 error and adjust batch size
   * @returns {number} New batch size after adjustment
   */
  record503Error() {
    this.consecutive503Errors++;
    this.consecutiveSuccesses = 0;
    
    // Reduce batch size by 50% on 503 error
    const oldSize = this.currentBatchSize;
    this.currentBatchSize = Math.max(
      this.minBatchSize,
      Math.floor(this.currentBatchSize * 0.5)
    );
    
    if (oldSize !== this.currentBatchSize) {
      console.log(`📉 Batch size reduced: ${oldSize} → ${this.currentBatchSize} (503 error #${this.consecutive503Errors})`);
    }
    
    return this.currentBatchSize;
  }
  
  /**
   * Record successful batch
   * @returns {number} Current batch size (may be adjusted)
   */
  recordSuccess() {
    this.consecutive503Errors = 0;
    this.consecutiveSuccesses++;
    
    // Gradually restore batch size after consecutive successes
    if (this.consecutiveSuccesses === 3 && this.currentBatchSize < this.originalBatchSize) {
      // Restore to 75% after 3 successes
      const oldSize = this.currentBatchSize;
      this.currentBatchSize = Math.min(
        this.originalBatchSize,
        Math.floor(this.originalBatchSize * 0.75)
      );
      console.log(`📈 Batch size increased: ${oldSize} → ${this.currentBatchSize} (3 consecutive successes)`);
    } else if (this.consecutiveSuccesses === 5 && this.currentBatchSize < this.originalBatchSize) {
      // Restore to 100% after 5 successes
      const oldSize = this.currentBatchSize;
      this.currentBatchSize = this.originalBatchSize;
      console.log(`📈 Batch size restored: ${oldSize} → ${this.currentBatchSize} (5 consecutive successes)`);
    }
    
    return this.currentBatchSize;
  }
  
  /**
   * Get adjustment statistics
   * @returns {Object} Current statistics
   */
  getStats() {
    return {
      originalBatchSize: this.originalBatchSize,
      currentBatchSize: this.currentBatchSize,
      consecutive503Errors: this.consecutive503Errors,
      consecutiveSuccesses: this.consecutiveSuccesses,
      reductionPercentage: ((1 - this.currentBatchSize / this.originalBatchSize) * 100).toFixed(1)
    };
  }
  
  /**
   * Reset to original batch size
   */
  reset() {
    this.currentBatchSize = this.originalBatchSize;
    this.consecutive503Errors = 0;
    this.consecutiveSuccesses = 0;
  }
}

module.exports = AdaptiveBatchSizer;
