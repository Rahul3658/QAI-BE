// Topic Validation Service

/**
 * Validate topic in PDF using File Search with comprehensive error handling
 * @param {string} fileId - File ID from File Search Store
 * @param {string} topic - Topic to validate
 * @param {string} subject - Subject context
 * @param {string} chapters - Optional chapters
 * @returns {Promise<Object>} - Validation result
 */
async function validateTopicWithFileSearch(fileId, topic, subject, chapters = '') {
  try {
    console.log(`🔍 Validating topic "${topic}" using File Search (fileId: ${fileId})...`);
    
    const FileSearchService = require('./fileSearchService');
    const fileSearchService = new FileSearchService();
    
    // First, verify file exists
    try {
      const fileExists = await fileSearchService.fileExists(fileId);
      if (!fileExists) {
        console.error(`❌ File ${fileId} not found in File Search Store`);
        return {
          relevanceScore: 0,
          isRelevant: false,
          reasoning: 'File not found in File Search Store. Please re-upload the PDF.',
          keyTermsFound: [],
          excerpts: [],
          error: 'FILE_NOT_FOUND'
        };
      }
    } catch (existsError) {
      console.error('Error checking file existence:', existsError);
      // Continue with validation attempt even if existence check fails
    }
    
    // Construct query for File Search
    const query = `Analyze the relevance of this document to the topic: "${topic}" in the subject: "${subject}"${chapters ? ` with focus on: ${chapters}` : ''}.

Provide:
1. A relevance score from 0-100 where:
   - 0-29: Not relevant (topic not covered or minimally mentioned)
   - 30-59: Somewhat relevant (topic mentioned but not main focus)
   - 60-89: Relevant (topic covered with some detail)
   - 90-100: Highly relevant (topic is main focus with comprehensive coverage)
2. Key terms found in the document related to the topic
3. Brief reasoning for the relevance score
4. Relevant excerpts from the document (if any)

Consider:
- Direct mentions of the topic or related keywords
- Coverage depth and detail level
- Alignment with the subject area
${chapters ? '- Coverage of specified chapters/topics' : ''}`;
    
    // Query File Search with retry logic
    const result = await fileSearchService.queryFile(fileId, query);
    
    const isRelevant = result.relevanceScore >= 30;
    
    console.log(`📊 File Search relevance: ${result.relevanceScore}/100 - ${result.reasoning}`);
    
    return {
      relevanceScore: result.relevanceScore,
      isRelevant,
      reasoning: result.reasoning,
      keyTermsFound: result.keyTermsFound || [],
      excerpts: result.excerpts || []
    };
  } catch (error) {
    console.error('Error validating topic with File Search:', {
      message: error.message,
      code: error.code,
      statusCode: error.statusCode,
      retryable: error.retryable
    });
    
    // Determine error type and provide appropriate fallback
    let errorCode = error.code || 'UNKNOWN_ERROR';
    let reasoning = 'Failed to validate with File Search';
    
    if (error.code === 'RATE_LIMIT') {
      reasoning = 'Rate limit exceeded. You can proceed without PDF validation or try again later.';
    } else if (error.code === 'TIMEOUT') {
      reasoning = 'Validation timeout. You can proceed without PDF validation.';
    } else if (error.code === 'FILE_NOT_FOUND') {
      reasoning = 'File not found. Please re-upload the PDF.';
    } else if (error.code === 'AUTH_ERROR') {
      reasoning = 'Authentication error. Please contact support.';
    } else if (error.code === 'NETWORK_ERROR') {
      reasoning = 'Network error. Please check your connection and try again.';
    } else if (error.code === 'SERVICE_UNAVAILABLE') {
      reasoning = 'File Search service temporarily unavailable. You can proceed without PDF validation.';
    } else {
      reasoning = `Validation failed: ${error.message}. You can proceed without PDF validation.`;
    }
    
    // Return low relevance on error to allow proceeding without PDF (graceful degradation)
    return {
      relevanceScore: 0,
      isRelevant: false,
      reasoning,
      keyTermsFound: [],
      excerpts: [],
      error: errorCode,
      canProceedWithoutPdf: true
    };
  }
}

module.exports = {
  validateTopicWithFileSearch
};
