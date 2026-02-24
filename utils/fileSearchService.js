const { GoogleGenAI } = require('@google/genai'); 
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { randomBytes } = require('crypto');
/**
 * Service for managing files in Gemini File Search Store
 * Provides methods for uploading, querying, deleting, and managing PDF files
 */
class FileSearchService {
  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY;
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not set');
    }
    
    // 💡 FIX 1: Initialize the client using GoogleGenAI
    this.genAI = new GoogleGenAI(this.apiKey);

    // The files service is now accessible directly on the client, which we use for consistency
    this.filesClient = this.genAI.files;

    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  }

  /**
 * List available models for this API key (cached).
 * Returns an array of model objects from the List Models API.
 */
async listAvailableModels() {
  // simple cache to avoid calling listModels on every request
  if (!this._modelListCache) {
    this._modelListCache = { expiresAt: 0, models: null };
  }

  const now = Date.now();
  const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

  if (this._modelListCache.models && this._modelListCache.expiresAt > now) {
    return this._modelListCache.models;
  }

  try {
    const url = `${this.baseUrl}/models?key=${this.apiKey}`;
    const resp = await axios.get(url, { timeout: 10000 });
    const models = Array.isArray(resp.data?.models) ? resp.data.models : [];
    // cache
    this._modelListCache.models = models;
    this._modelListCache.expiresAt = Date.now() + CACHE_TTL_MS;
    console.log('ListModels result:', models.map(m => m.name || m.model || m.id));
    return models;
  } catch (err) {
    console.warn('listAvailableModels failed:', err?.message || err);
    // rethrow to allow caller to decide fallback behavior
    throw err;
  }
}

async pickBestModel() {
  try {
    const models = await this.listAvailableModels();
    if (!models || models.length === 0) {
      throw new Error('No models returned from ListModels');
    }

    // Normalize candidate identifiers (use model.name if present, otherwise other fields)
    const normalized = models.map(m => {
      return {
        raw: m,
        name: (m.name || m.id || m.model || '').toString(),
        baseModelId: (m.baseModelId || m.base_model_id || '').toString(),
        displayName: (m.displayName || m.display_name || '').toString(),
      };
    });

    // Preferred pattern list in order
    this.preferredPatterns = [
      'gemini-2.0-flash-exp',       // Stable 2.0 flash model (primary)
      'gemini-1.5-flash-002',       // Stable 1.5 flash (secondary)
      'gemini-1.5-flash-001',       // Stable 1.5 flash (tertiary)
      'gemini-1.5-flash',           // Generic 1.5 flash
      'gemini-exp-1121',            // Experimental but stable
      'gemini-1.5-pro-002',         // Pro models as fallback
      'gemini-1.5-pro-001',
      'gemini-1.5-pro',
      'gemini-2.0-flash-thinking-exp-1219', // Thinking model (slower but reliable)
      'gemini-exp-1206'             // Last resort experimental
  ];

    // Try to find a preferred model
    for (const pat of this.preferredPatterns) {
      const found = normalized.find(n =>
        (n.name && n.name.includes(pat)) ||
        (n.baseModelId && n.baseModelId.includes(pat)) ||
        (n.displayName && n.displayName.toLowerCase().includes(pat))
      );
      if (found && found.name) {
        console.log(`pickBestModel: selected preferred model "${found.name}" (pattern "${pat}")`);
        return found.name;
      }
    }

    // If none matched preferred patterns, return the first model.name available
    const fallback = normalized.find(n => n.name) || normalized[0];
    console.log(`pickBestModel: no preferred model found; using fallback "${fallback.name || JSON.stringify(fallback.raw)}"`);
    return fallback.name || fallback.raw.name || fallback.raw.id || null;
  } catch (err) {
    console.error('pickBestModel() failed:', err?.message || err);
    // Rethrow so callers can decide (queryFile will surface friendly error)
    throw err;
  }
}

  /**
   * Generate SHA-256 hash for file deduplication
   * @param {Buffer} buffer - File buffer
   * @returns {string} - Hex string of SHA-256 hash
   */
  generateFileHash(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  async getFileInfo(fileId) {
  try {
    const normalizedFileId = fileId.startsWith('files/') ? fileId : `files/${fileId}`;
    const url = `${this.baseUrl}/${normalizedFileId}?key=${this.apiKey}`;
    
    const response = await axios.get(url, {
      timeout: 10000
    });
    
    return {
      fileId: response.data.name,
      name: response.data.displayName,
      mimeType: response.data.mimeType,
      sizeBytes: response.data.sizeBytes,
      createTime: response.data.createTime
    };
  } catch (error) {
    if (error.response?.status === 404) {
      return null; // File not found
    }
    throw error;
  }
}

/**
 * Upload PDF to Gemini File Search Store using the official SDK.
 * @param {Buffer} pdfBuffer - PDF file buffer
 * @param {string} displayName - Display name for the file
 * @returns {Promise<Object>} - { fileId, name, mimeType, sizeBytes, uri }
 */

async uploadFile(pdfBuffer, displayName) {
  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
    const err = new Error('uploadFile expects a Buffer as first argument');
    err.code = 'INVALID_ARGUMENT';
    throw err;
  }

  // Quick validation for PDF magic header
  const header = pdfBuffer.slice(0, 5).toString('utf8');
  if (!header.startsWith('%PDF')) {
    const err = new Error('Buffer does not appear to be a PDF (missing %PDF header).');
    err.code = 'INVALID_PDF';
    throw err;
  }

  // Prepare temp file path with .pdf extension (helps SDK infer mimeType)
  const tmpName = `upload-${Date.now()}-${randomBytes(6).toString('hex')}.pdf`;
  const tmpPath = path.join(os.tmpdir(), tmpName);

  try {
    // Write buffer to temp file
    await fs.writeFile(tmpPath, pdfBuffer);

    // Prefer calling genAI.files.upload if available, else this.filesClient.upload
    // Both calls below use only SDK (no REST).
    const uploader =
      (typeof this.genAI?.files?.upload === 'function') ? this.genAI.files.upload.bind(this.genAI.files)
      : (typeof this.filesClient?.upload === 'function') ? this.filesClient.upload.bind(this.filesClient)
      : null;

    if (!uploader) {
      throw new Error('SDK files upload method not available. Check @google/genai client instantiation.');
    }

    // Call SDK with file path (Node.js supported upload source)
    // Some SDK versions accept mimeType/displayName at top level; supplying displayName is harmless.
    const params = {
      file: tmpPath,
      displayName: displayName
      // mimeType: 'application/pdf' // optional: can include, but some SDKs ignore it and derive from filename
    };

    console.log('Attempting SDK upload with file path:', tmpPath);
    const uploadedFile = await uploader(params);

    if (!uploadedFile) {
      throw new Error('SDK upload returned empty response');
    }

    console.log('✅ SDK upload succeeded:', uploadedFile);

    return {
      fileId: uploadedFile.name || uploadedFile.fileId || uploadedFile.id,
      name: uploadedFile.displayName || displayName,
      mimeType: uploadedFile.mimeType || 'application/pdf',
      sizeBytes: uploadedFile.sizeBytes || pdfBuffer.length,
      uri: uploadedFile.uri || uploadedFile.url || null
    };
  } catch (error) {
    console.error('SDK File Upload Error (SDK-only path):', error && error.message ? error.message : error);

    // Map common SDK messages into your existing API error shape
    let statusCode = error.status || error.response?.status || 500;
    let errorMessage = error.response?.data?.error?.message || error.message || 'Unknown error';

    if ((errorMessage || '').toLowerCase().includes('mime')) {
      statusCode = 400;
      errorMessage = 'Failed to upload PDF: SDK could not determine mime type. Ensure file path has .pdf extension and pass displayName if needed.';
    } else if ((errorMessage || '').toLowerCase().includes('file is too large') || statusCode === 413) {
      statusCode = 413;
      errorMessage = 'File is too large. Please upload a smaller PDF.';
    } else if (statusCode === 401 || statusCode === 403) {
      errorMessage = 'Authentication failed. Check GEMINI_API_KEY and SDK client configuration.';
    }

    const apiError = new Error(errorMessage);
    apiError.code = 'UPLOAD_FAILED';
    apiError.statusCode = statusCode;
    apiError.retryable = !!(statusCode && (statusCode >= 500 || statusCode === 429));

    throw apiError;
  } finally {
    // Always try to remove the temp file (best-effort)
    try {
      await fs.unlink(tmpPath);
    } catch (unlinkErr) {
      // ignore - log for debugging but do not fail the main flow
      console.warn('Could not delete temp file:', tmpPath, unlinkErr && unlinkErr.message ? unlinkErr.message : unlinkErr);
    }
  }
}
 
/**
 * Query File Search for relevant content with retry logic (updated to auto-pick model)
 * @param {string} fileId - File ID from upload (format: files/{id})
 * @param {string} query - Search query (topic/subject)
 * @param {number} maxRetries - Maximum number of retry attempts (default: 2)
 * @returns {Promise<Object>} - { relevanceScore, excerpts, reasoning, keyTermsFound }
 */
async queryFile(fileId, query, maxRetries = 2) {
  const normalizedFileId = fileId.startsWith('files/') ? fileId : `files/${fileId}`;
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Pick best model for this API key (cached internally)
      const modelName = await this.pickBestModel() || "gemini-2.0-flash-exp";

      if (!modelName) {
        throw new Error('No usable generation model available for this API key.');
      }

      // Build a more structured prompt that requests JSON output
      const structuredPrompt = `${query}

IMPORTANT: You MUST respond with ONLY a valid JSON object in this exact format (no markdown, no explanation):
{
  "relevanceScore": <number 0-100>,
  "keyTermsFound": ["term1", "term2"],
  "reasoning": "<brief explanation>",
  "excerpts": ["excerpt1", "excerpt2"]
}

Analyze the document and provide the JSON response.`;

      console.log(`Attempting generateContent (attempt ${attempt + 1}) with model: ${modelName}, fileSearch: ${normalizedFileId}`);

      // Remove "models/" prefix if present in modelName to avoid double prefix
      const cleanModelName = modelName.startsWith('models/') ? modelName.substring(7) : modelName;
      
      // Use v1beta API for File Search support (not v1)
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModelName}:generateContent?key=${this.apiKey}`;
      
      // Get file metadata to get the proper URI
      const fileMetadata = await this.getFileMetadata(normalizedFileId);
      if (!fileMetadata || !fileMetadata.uri) {
        throw new Error(`File ${normalizedFileId} not found or has no URI`);
      }

      console.log('📄 File metadata:', { fileId: fileMetadata.fileId, uri: fileMetadata.uri, state: fileMetadata.state });

      // For File Search, we need to reference the file directly in the content using the full URI
      const requestBody = {
        contents: [{
          parts: [
            {
              fileData: {
                mimeType: "application/pdf",
                fileUri: fileMetadata.uri
              }
            },
            {
              text: structuredPrompt
            }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048 // Increased for larger PDFs
        }
      };

      console.log('📤 Sending File Search request to:', url);

      const response = await axios.post(url, requestBody, {
        timeout: 90000, // Increased to 90 seconds for File Search queries
        headers: {
          'Content-Type': 'application/json'
        }
      });

      console.log('✅ Received response from Gemini API');

      // Extract text from REST API response
      const result = response.data;
      if (!result || !result.candidates || !result.candidates[0]) {
        console.error('❌ Invalid response structure:', JSON.stringify(result, null, 2));
        throw new Error('Invalid response structure from Gemini API');
      }

      const candidate = result.candidates[0];
      
      // Check if response was truncated due to MAX_TOKENS
      if (candidate.finishReason === 'MAX_TOKENS') {
        console.warn('⚠️ Response truncated due to MAX_TOKENS, but may still be parseable');
      }
      
      if (!candidate.content || !candidate.content.parts || !candidate.content.parts[0]) {
        console.error('❌ Invalid content structure:', JSON.stringify(candidate, null, 2));
        throw new Error('Invalid content structure in response');
      }

      const text = candidate.content.parts[0].text;
      console.log('📝 Extracted text from response (first 500 chars):', text.substring(0, 500));

      // Parse JSON object from the model output
      const jsonMatch = (text || '').match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (attempt > 0) {
          console.log(`✅ Query successful on retry attempt ${attempt + 1}`);
        }
        return {
          relevanceScore: parsed.relevanceScore || 0,
          keyTermsFound: parsed.keyTermsFound || [],
          reasoning: parsed.reasoning || 'No reasoning provided',
          excerpts: parsed.excerpts || []
        };
      }

      // If JSON not present, return defaults
      console.warn('⚠️ Failed to parse JSON response from model; returning default values. Raw text:', text);
      return {
        relevanceScore: 0,
        keyTermsFound: [],
        reasoning: 'Failed to parse response',
        excerpts: []
      };
    } catch (error) {
      lastError = error;
      const statusCode = error.response?.status || error.status;
      const errorMessage = error.response?.data?.error?.message || error.message;

      console.error(`❌ Query attempt ${attempt + 1}/${maxRetries} failed:`, {
        status: statusCode,
        message: errorMessage,
        code: error.code
      });

      // Don't retry on client errors (400, 401, 403, 404) except 429
      if (statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
        console.error('🚫 Non-retryable client error, aborting retries');
        throw this._createUserFriendlyError(error, 'query');
      }

      // If this was the last attempt, throw interpreted error
      if (attempt === maxRetries - 1) {
        console.error(`❌ All ${maxRetries} query attempts failed`);
        throw this._createUserFriendlyError(error, 'query');
      }

      // Exponential backoff before next attempt
      const delayMs = Math.pow(2, attempt) * 1000;
      console.log(`⏳ Retrying in ${delayMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  // Shouldn't reach here
  throw this._createUserFriendlyError(lastError, 'query');
}

  /**
   * Delete file from Gemini File Search Store with retry logic
   * @param {string} fileId - File ID to delete (format: files/{id})
   * @param {number} maxRetries - Maximum number of retry attempts (default: 2)
   * @returns {Promise<boolean>} - Success status
   */
  async deleteFile(fileId, maxRetries = 2) {
    const normalizedFileId = fileId.startsWith('files/') ? fileId : `files/${fileId}`;
    let lastError = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          // Exponential backoff: 2^attempt seconds (2s, 4s)
          const delayMs = Math.pow(2, attempt) * 1000;
          console.log(`⏳ Delete retry attempt ${attempt + 1}/${maxRetries} after ${delayMs}ms delay...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        
        const url = `${this.baseUrl}/${normalizedFileId}?key=${this.apiKey}`;
        await axios.delete(url, {
          timeout: 30000 // 30 seconds timeout
        });
        
        console.log(`✅ Successfully deleted file: ${normalizedFileId}`);
        return true;
      } catch (error) {
        lastError = error;
        const statusCode = error.response?.status;
        
        // 404 means the file is already deleted
        if (statusCode === 404) {
          console.log(`ℹ️ File not found (may be already deleted): ${normalizedFileId}`);
          return true;
        }
        
        const errorMessage = error.response?.data?.error?.message || error.message;
        console.error(`❌ Delete attempt ${attempt + 1}/${maxRetries} failed:`, {
          status: statusCode,
          message: errorMessage,
          code: error.code
        });
        
        // Don't retry on client errors (400, 401, 403)
        if (statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
          console.error('🚫 Non-retryable client error, aborting retries');
          throw this._createUserFriendlyError(error, 'delete');
        }
        
        // If this was the last attempt, throw error
        if (attempt === maxRetries - 1) {
          console.error(`❌ All ${maxRetries} delete attempts failed`);
          throw this._createUserFriendlyError(error, 'delete');
        }
      }
    }
    
    // This should never be reached, but just in case
    throw this._createUserFriendlyError(lastError, 'delete');
  }

  /**
   * Get file metadata from Gemini File Search Store with retry logic
   * @param {string} fileId - File ID (format: files/{id})
   * @param {number} maxRetries - Maximum number of retry attempts (default: 2)
   * @returns {Promise<Object|null>} - File metadata or null if not found
   */
  async getFileMetadata(fileId, maxRetries = 2) {
    let lastError = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          // Exponential backoff: 2^attempt seconds (2s, 4s)
          const delayMs = Math.pow(2, attempt) * 1000;
          console.log(`⏳ Metadata retry attempt ${attempt + 1}/${maxRetries} after ${delayMs}ms delay...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        
        const formattedFileId = fileId.startsWith('files/') ? fileId : `files/${fileId}`;
        const url = `${this.baseUrl}/${formattedFileId}?key=${this.apiKey}`;
        
        const response = await axios.get(url, {
          timeout: 30000
        });
        
        const fileData = response.data;
        
        if (attempt > 0) {
          console.log(`✅ Metadata retrieval successful on retry attempt ${attempt + 1}`);
        }
        
        return {
          fileId: fileData.name,
          name: fileData.displayName,
          mimeType: fileData.mimeType,
          sizeBytes: fileData.sizeBytes,
          createTime: fileData.createTime,
          updateTime: fileData.updateTime,
          expirationTime: fileData.expirationTime,
          sha256Hash: fileData.sha256Hash,
          uri: fileData.uri,
          state: fileData.state
        };
      } catch (error) {
        lastError = error;
        const statusCode = error.response?.status;
        
        // File not found - return null immediately
        if (statusCode === 404) {
          return null;
        }
        
        console.error(`❌ Metadata attempt ${attempt + 1}/${maxRetries} failed:`, {
          status: statusCode,
          message: error.response?.data?.error?.message || error.message
        });
        
        // Don't retry on client errors (except 429)
        if (statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
          console.error('🚫 Non-retryable client error, aborting retries');
          throw this._createUserFriendlyError(error, 'metadata');
        }
        
        // If this was the last attempt, throw error
        if (attempt === maxRetries - 1) {
          console.error(`❌ All ${maxRetries} metadata attempts failed`);
          throw this._createUserFriendlyError(error, 'metadata');
        }
      }
    }
    
    // This should never be reached, but just in case
    throw this._createUserFriendlyError(lastError, 'metadata');
  }

  /**
   * Check if file exists in Gemini File Search Store
   * @param {string} fileId - File ID (format: files/{id})
   * @returns {Promise<boolean>} - Existence status
   */
  async fileExists(fileId) {
    try {
      const metadata = await this.getFileMetadata(fileId);
      return metadata !== null && metadata.state === 'ACTIVE';
    } catch (error) {
      console.error('File existence check error:', error.message);
      return false;
    }
  }

  /**
   * Wait for file to be processed and active
   * @param {string} fileId - File ID (format: files/{id})
   * @param {number} maxWaitTime - Maximum wait time in milliseconds (default: 60000)
   * @returns {Promise<boolean>} - True if file is active, false if timeout
   */
  async waitForFileProcessing(fileId, maxWaitTime = 60000) {
    const startTime = Date.now();
    const pollInterval = 2000; // Check every 2 seconds
    
    while (Date.now() - startTime < maxWaitTime) {
      try {
        const metadata = await this.getFileMetadata(fileId);
        
        if (!metadata) {
          console.error('❌ File not found during processing wait');
          return false;
        }
        
        if (metadata.state === 'ACTIVE') {
          console.log(`✅ File ${fileId} is now active`);
          return true;
        }
        
        if (metadata.state === 'FAILED') {
          console.error('❌ File processing failed');
          throw new Error('File processing failed');
        }
        
        console.log(`⏳ File state: ${metadata.state}, waiting...`);
        
        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      } catch (error) {
        console.error('Error waiting for file processing:', error.message);
        return false;
      }
    }
    
    console.error('❌ File processing timeout');
    return false; // Timeout
  }

  /**
   * Create user-friendly error message based on error type
   * @param {Error} error - Original error
   * @param {string} operation - Operation type (upload, query, delete, metadata)
   * @returns {Error} - User-friendly error
   * @private
   */
  _createUserFriendlyError(error, operation) {
    const statusCode = error.response?.status || error.status;
    const errorMessage = error.response?.data?.error?.message || error.message;
    const errorCode = error.code;
    
    // Log detailed error for debugging
    console.error(`🔍 File Search ${operation} error details:`, {
      status: statusCode,
      message: errorMessage,
      code: errorCode,
      operation
    });
    
    // Rate limit error (429)
    if (statusCode === 429) {
      const err = new Error('Rate limit exceeded. Please try again in a few moments.');
      err.code = 'RATE_LIMIT';
      err.statusCode = 429;
      err.retryable = true;
      return err;
    }
    
    // Timeout errors
    if (errorCode === 'ECONNABORTED' || errorCode === 'ETIMEDOUT' || errorMessage.includes('timeout')) {
      const err = new Error(`${operation} timeout. Please try again with a smaller file or check your connection.`);
      err.code = 'TIMEOUT';
      err.statusCode = 408;
      err.retryable = true;
      return err;
    }
    
    // Authentication errors (401, 403)
    if (statusCode === 401 || statusCode === 403) {
      const err = new Error('Authentication failed. Please check API configuration.');
      err.code = 'AUTH_ERROR';
      err.statusCode = statusCode;
      err.retryable = false;
      return err;
    }
    
    // File not found (404)
    if (statusCode === 404) {
      const err = new Error('File not found in File Search Store. Please re-upload the PDF.');
      err.code = 'FILE_NOT_FOUND';
      err.statusCode = 404;
      err.retryable = false;
      return err;
    }
    
    // File too large (413)
    if (statusCode === 413) {
      const err = new Error('File is too large. Please upload a file smaller than 10MB.');
      err.code = 'FILE_TOO_LARGE';
      err.statusCode = 413;
      err.retryable = false;
      return err;
    }
    
    // Bad request (400)
    if (statusCode === 400) {
      const err = new Error(`Invalid request: ${errorMessage || 'Please check your input'}`);
      err.code = 'BAD_REQUEST';
      err.statusCode = 400;
      err.retryable = false;
      return err;
    }
    
    // Network errors
    if (errorCode === 'ENOTFOUND' || errorCode === 'ECONNREFUSED' || errorCode === 'ENETUNREACH') {
      const err = new Error('Network error. Please check your internet connection.');
      err.code = 'NETWORK_ERROR';
      err.statusCode = 503;
      err.retryable = true;
      return err;
    }
    
    // Server errors (500+)
    if (statusCode && statusCode >= 500) {
      const err = new Error('File Search service is temporarily unavailable. Please try again later.');
      err.code = 'SERVICE_UNAVAILABLE';
      err.statusCode = statusCode;
      err.retryable = true;
      return err;
    }
    
    // Generic error
    const err = new Error(`File Search ${operation} failed: ${errorMessage || 'Unknown error'}`);
    err.code = 'UNKNOWN_ERROR';
    err.statusCode = statusCode || 500;
    err.retryable = false;
    return err;
  }
}

module.exports = FileSearchService;


