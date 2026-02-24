/**
 * ErrorMaskingService - Converts technical errors to user-friendly messages
 * 
 * Masks technical error details while logging them for debugging
 */

class ErrorMaskingService {
  constructor() {
    // Error code to user message mapping
    this.errorMessages = {
      // Network errors
      'ECONNABORTED': 'Please check your internet connectivity and try again',
      'ETIMEDOUT': 'Please check your internet connectivity and try again',
      'ENOTFOUND': 'Please check your internet connectivity and try again',
      'ENETUNREACH': 'Please check your internet connectivity and try again',
      'ECONNREFUSED': 'Please check your internet connectivity and try again',
      'ECONNRESET': 'Please check your internet connectivity and try again',
      
      // HTTP errors
      '500': 'Something went wrong on our end. Please try again in a moment',
      '502': 'Something went wrong on our end. Please try again in a moment',
      '503': 'The service is temporarily unavailable. Please try again shortly',
      '504': 'The service is temporarily unavailable. Please try again shortly',
      
      // Application errors
      'RATE_LIMIT_EXCEEDED': 'Too many requests. Please wait a moment and try again',
      'VALIDATION_ERROR': 'Please check your input and try again',
      'PROCESSING_ERROR': 'We encountered an error processing your request',
      'AUTHENTICATION_ERROR': 'Authentication failed. Please try again',
      
      // Default
      'UNKNOWN': 'Something unexpected happened. Please try again'
    };

    // Retryable error codes
    this.retryableErrors = [
      'ECONNABORTED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'ENETUNREACH',
      'ECONNRESET',
      '503',
      '504',
      'RATE_LIMIT_EXCEEDED'
    ];
  }

  /**
   * Mask error with user-friendly message
   * @param {Error} error - Original error
   * @param {Object} context - Additional context
   * @returns {Object} Masked error with user message and logged details
   */
  maskError(error, context = {}) {
    // Extract error code
    const errorCode = this._extractErrorCode(error);
    
    // Get user-friendly message
    const userMessage = this.getUserMessage(errorCode);
    
    // Determine if retryable
    const retryable = this._isRetryable(errorCode);
    
    // Log technical details
    this.logError(error, context);
    
    // Build masked error
    const maskedError = {
      userMessage,
      retryable,
      suggestedAction: retryable ? 'Please try again' : 'Please contact support if this persists',
      technicalDetails: {
        code: errorCode,
        message: error.message || 'Unknown error',
        stack: error.stack || null,
        context
      }
    };

    return maskedError;
  }

  /**
   * Get user-friendly message for error type
   * @param {string} errorCode - Error code or type
   * @returns {string} User-friendly message
   */
  getUserMessage(errorCode) {
    // Check for exact match
    if (this.errorMessages[errorCode]) {
      return this.errorMessages[errorCode];
    }

    // Check for HTTP status code
    const statusCode = String(errorCode);
    if (statusCode.match(/^[45]\d{2}$/)) {
      if (statusCode.startsWith('5')) {
        return this.errorMessages['500'];
      }
      return this.errorMessages['UNKNOWN'];
    }

    // Default message
    return this.errorMessages['UNKNOWN'];
  }

  /**
   * Log technical error details
   * @param {Error} error - Original error
   * @param {Object} context - Additional context
   */
  logError(error, context = {}) {
    const errorLog = {
      timestamp: new Date().toISOString(),
      code: this._extractErrorCode(error),
      message: error.message || 'Unknown error',
      stack: error.stack || null,
      context,
      // Additional error properties
      name: error.name,
      response: error.response ? {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      } : null
    };

    console.error('🚨 Voice Assistant Error:', JSON.stringify(errorLog, null, 2));
  }

  /**
   * Extract error code from error object
   * @private
   * @param {Error} error - Error object
   * @returns {string} Error code
   */
  _extractErrorCode(error) {
    // Check for explicit code
    if (error.code) {
      return error.code;
    }

    // Check for HTTP status
    if (error.response && error.response.status) {
      return String(error.response.status);
    }

    // Check for status property
    if (error.status) {
      return String(error.status);
    }

    // Check error message for common patterns
    const message = error.message || '';
    
    if (message.includes('timeout') || message.includes('ETIMEDOUT')) {
      return 'ETIMEDOUT';
    }
    
    if (message.includes('network') || message.includes('ENOTFOUND')) {
      return 'ENOTFOUND';
    }
    
    if (message.includes('rate limit')) {
      return 'RATE_LIMIT_EXCEEDED';
    }
    
    if (message.includes('503')) {
      return '503';
    }
    
    if (message.includes('500')) {
      return '500';
    }

    return 'UNKNOWN';
  }

  /**
   * Check if error is retryable
   * @private
   * @param {string} errorCode - Error code
   * @returns {boolean} True if retryable
   */
  _isRetryable(errorCode) {
    return this.retryableErrors.includes(errorCode);
  }

  /**
   * Check if error message contains technical details
   * @param {string} message - Error message
   * @returns {boolean} True if contains technical details
   */
  containsTechnicalDetails(message) {
    const technicalPatterns = [
      /stack trace/i,
      /at\s+\w+\s+\(/i,  // Stack trace format
      /\.js:\d+:\d+/i,    // File:line:column
      /Error:\s+\w+Error/i,
      /ECONNABORTED/i,
      /ETIMEDOUT/i,
      /500|502|503|504/,
      /internal server error/i
    ];

    return technicalPatterns.some(pattern => pattern.test(message));
  }

  /**
   * Sanitize error message for display
   * @param {string} message - Error message
   * @returns {string} Sanitized message
   */
  sanitizeMessage(message) {
    if (!message) return this.errorMessages['UNKNOWN'];

    // If contains technical details, replace with generic message
    if (this.containsTechnicalDetails(message)) {
      return this.errorMessages['UNKNOWN'];
    }

    return message;
  }
}

module.exports = ErrorMaskingService;
