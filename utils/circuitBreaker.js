/**
 * CircuitBreaker - Prevents cascading failures by temporarily blocking requests
 * 
 * Implements the circuit breaker pattern with three states:
 * - CLOSED: Normal operation, requests allowed
 * - OPEN: Too many failures, requests blocked for cooldown period
 * - HALF_OPEN: Testing with single request after cooldown
 */

class CircuitBreaker {
  constructor(config = {}) {
    this.failureThreshold = config.failureThreshold || 5;
    this.cooldownMs = config.cooldownMs || 300000; // 5 minutes
    this.halfOpenTestDelay = config.halfOpenTestDelay || 10000; // 10 seconds
    
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.consecutiveFailures = 0;
    this.lastFailureTime = null;
    this.openedAt = null;
  }
  
  /**
   * Check if request can proceed
   * @returns {Object} Result with allowed flag and state info
   */
  canProceed() {
    if (this.state === 'CLOSED') {
      return { allowed: true, state: 'CLOSED' };
    }
    
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.openedAt;
      
      if (elapsed >= this.cooldownMs) {
        // Transition to HALF_OPEN for test request
        this.state = 'HALF_OPEN';
        console.log('🔄 Circuit breaker: OPEN → HALF_OPEN (testing)');
        return { allowed: true, state: 'HALF_OPEN', testing: true };
      }
      
      const remainingMs = this.cooldownMs - elapsed;
      return { 
        allowed: false, 
        state: 'OPEN',
        remainingMs,
        message: `Circuit breaker open. System will retry in ${(remainingMs/1000).toFixed(0)}s`
      };
    }
    
    if (this.state === 'HALF_OPEN') {
      // Only allow one test request at a time
      return { allowed: true, state: 'HALF_OPEN', testing: true };
    }
  }
  
  /**
   * Record successful request
   */
  recordSuccess() {
    if (this.state === 'HALF_OPEN') {
      // Test succeeded - close circuit
      this.state = 'CLOSED';
      this.consecutiveFailures = 0;
      console.log('✅ Circuit breaker: HALF_OPEN → CLOSED (recovered)');
    } else if (this.state === 'CLOSED') {
      // Reset failure counter on success
      this.consecutiveFailures = 0;
    }
  }

  
  /**
   * Record failed request
   * @param {Error} error - The error that occurred
   */
  recordFailure(error) {
    this.lastFailureTime = Date.now();
    
    if (this.state === 'HALF_OPEN') {
      // Test failed - reopen circuit
      this.state = 'OPEN';
      this.openedAt = Date.now();
      console.log('❌ Circuit breaker: HALF_OPEN → OPEN (test failed)');
      return;
    }
    
    if (this.state === 'CLOSED') {
      this.consecutiveFailures++;
      
      if (this.consecutiveFailures >= this.failureThreshold) {
        // Open circuit
        this.state = 'OPEN';
        this.openedAt = Date.now();
        console.log(`🚨 Circuit breaker: CLOSED → OPEN (${this.consecutiveFailures} consecutive failures)`);
      }
    }
  }
  
  /**
   * Get current state
   * @returns {Object} Current circuit breaker state
   */
  getState() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
      lastFailureTime: this.lastFailureTime
    };
  }
  
  /**
   * Reset circuit breaker to initial state
   */
  reset() {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.lastFailureTime = null;
    this.openedAt = null;
    console.log('🔄 Circuit breaker reset');
  }
}

// Singleton instance
let circuitBreakerInstance = null;

/**
 * Get or create the singleton CircuitBreaker instance
 * @returns {CircuitBreaker} Singleton instance
 */
function getCircuitBreaker() {
  if (!circuitBreakerInstance) {
    circuitBreakerInstance = new CircuitBreaker({
      failureThreshold: 5,
      cooldownMs: 300000, // 5 minutes
      halfOpenTestDelay: 10000
    });
  }
  return circuitBreakerInstance;
}

module.exports = {
  CircuitBreaker,
  getCircuitBreaker
};
