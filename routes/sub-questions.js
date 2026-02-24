const express = require('express');
const db = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const axios = require('axios');

const router = express.Router();
const multer = require('multer');
const FileSearchService = require('../utils/fileSearchService');
const fileSearchService = new FileSearchService();

// Rate limiting utilities
const { getRateLimiter } = require('../utils/rateLimiter');
const TokenEstimator = require('../utils/tokenEstimator');
const { getCircuitBreaker } = require('../utils/circuitBreaker');
const AdaptiveBatchSizer = require('../utils/adaptiveBatchSizer');
const { getModelSelector } = require('../utils/modelSelector');

// Configure multer for PDF uploads for Validate Topic with respect to uploaded pdf (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024 // 15MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});


// Helper function to calculate optimal batch size based on question type and File Search usage
// UPDATED: Reduced to 10 for PDF context to improve stability and reduce processing overhead
function calculateOptimalBatchSize(questionType, useFileSearch) {
  // When using PDF context (File Search), use smaller batch size for better stability
  if (useFileSearch) {
    return 10; // Fixed batch size of 10 for PDF context
  }
  
  // Regular batch sizes (without PDF context)
  const baseBatchSizes = {
    'mcq': 20,           // Increased from 10 - server overload resolved with model switching
    'short_answer': 20,  // Increased from 10 - server overload resolved with model switching
    'long_answer': 15,   // Increased from 8 - server overload resolved with model switching
    'true_false': 20,    // Increased from 10
    'fill_in_blanks': 20, // Increased from 10
    'numerical': 20,     // Increased from 10
    'diagram': 15,       // Increased from 8
    'case_study': 12,    // Increased from 6
    'practical': 15,     // Increased from 8
    'coding': 15         // Increased from 8
  };
  
  let batchSize = baseBatchSizes[questionType] || 20;
  
  // Ensure minimum batch size of 10
  return Math.max(10, batchSize);
}

// Helper function to calculate dynamic token limit based on batch size and question type
function calculateTokenLimit(batchSize, questionType) {
  const baseTokensPerVariation = {
    'mcq': 350,           // Question + 4 options + metadata
    'short_answer': 500,  // Increased from 400 - longer answers (4+ lines)
    'long_answer': 500,   // Question + detailed answer + metadata
    'true_false': 300,
    'fill_in_blanks': 350,
    'numerical': 350,
    'diagram': 450,
    'case_study': 600,
    'practical': 500,
    'coding': 550
  };
  
  const tokensPerVariation = baseTokensPerVariation[questionType] || 400;
  const buffer = 500; // Safety buffer
  
  return (batchSize * tokensPerVariation) + buffer;
}

// Helper function to call Gemini API with optional File Search and model selection
// UPDATED: Now accepts fileMetadata instead of fileId for proper PDF context enforcement
async function callGeminiAPI(prompt, fileMetadata = null, batchSize = 35, questionType = 'short_answer', modelName = null) {
  try {
    // Enhanced system instruction when using PDF context
    const systemInstruction = fileMetadata 
      ? `You are an expert educational question paper generator. 
         CRITICAL INSTRUCTIONS:
         - You MUST generate questions ONLY from the provided PDF document
         - DO NOT use any external knowledge or information not in the PDF
         - Every question must be directly based on content from the PDF
         - Include page numbers or section references when possible
         - If the PDF doesn't contain enough information, state this clearly
         Generate high-quality, well-structured questions in valid JSON format only.`
      : 'You are an expert educational question paper generator. Generate high-quality, well-structured questions in valid JSON format only. Do not include any markdown formatting or extra text.';

    const requestBody = {
      contents: [{
        parts: [
          // Add file reference FIRST when using PDF context
          ...(fileMetadata ? [{
            fileData: {
              mimeType: "application/pdf",
              fileUri: fileMetadata.uri
            }
          }] : []),
          // Then add the text prompt
          {
            text: prompt
          }
        ]
      }],
      systemInstruction: {
        parts: [{ text: systemInstruction }]
      },
      generationConfig: {
        temperature: 0.4, // Optimized for faster, more consistent output
        // When using File Search, increase token limit significantly to account for PDF context
        maxOutputTokens: fileMetadata 
          ? Math.max(calculateTokenLimit(batchSize, questionType), 8000) // Minimum 8000 tokens for File Search
          : calculateTokenLimit(batchSize, questionType),
        responseMimeType: "text/plain" // Request plain text response for better compatibility
      }
    };

    // Log PDF context usage
    if (fileMetadata) {
      console.log(`🔍 Using PDF context with file: ${fileMetadata.fileId} (URI: ${fileMetadata.uri})`);
    }

    // Dynamic timeout based on File Search usage and batch size
    const baseTimeout = fileMetadata ? 240000 : 180000; // 4min with File Search, 3min without
    const timeoutMs = baseTimeout;
    
    // Use model selector to get best available model
    const modelSelector = getModelSelector();
    const model = modelName || await modelSelector.selectBestModel();
    console.log(`🤖 Using model: ${model}`);
    
    // Always use v1beta endpoint for File Search support (v1 does NOT support File Search)
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      requestBody,
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: timeoutMs,
        // Improved connection keep-alive and socket options for better reliability
        httpAgent: new (require('http').Agent)({ 
          keepAlive: true,
          keepAliveMsecs: 60000, // Increased to 60s for better connection stability
          maxSockets: 50,
          timeout: timeoutMs
        }),
        httpsAgent: new (require('https').Agent)({ 
          keepAlive: true,
          keepAliveMsecs: 60000, // Increased to 60s for better connection stability
          maxSockets: 50,
          timeout: timeoutMs,
          rejectUnauthorized: true
        }),
        // Retry on network errors
        validateStatus: (status) => status < 500, // Don't throw on 4xx errors
      }
    );

     if (!response.data || !response.data.candidates || !response.data.candidates[0]) {
      console.error('❌ Invalid response structure:', JSON.stringify(response.data, null, 2));
      throw new Error('Invalid response structure from Gemini API');
    }

     const candidate = response.data.candidates[0];
    
    // Log the candidate structure for debugging
    console.log('📋 Candidate structure:', JSON.stringify({
      hasContent: !!candidate.content,
      hasParts: !!candidate.content?.parts,
      partsLength: candidate.content?.parts?.length,
      finishReason: candidate.finishReason,
      safetyRatings: candidate.safetyRatings
    }, null, 2));
    
    // Check for safety blocks or other finish reasons
    if (candidate.finishReason && candidate.finishReason !== 'STOP') {
      console.warn(`⚠️ Generation finished with reason: ${candidate.finishReason}`);
      
      // SAFETY blocks are fatal - cannot proceed
      if (candidate.finishReason === 'SAFETY') {
        console.error('❌ Content blocked by safety filters:', JSON.stringify(candidate.safetyRatings, null, 2));
        throw new Error(`Content generation blocked by safety filters. Reason: ${candidate.finishReason}`);
      }
      
      // MAX_TOKENS is a warning - try to parse what we got
      if (candidate.finishReason === 'MAX_TOKENS') {
        console.warn('⚠️ Response truncated due to MAX_TOKENS, attempting to parse partial response...');
        // Don't throw - continue to try parsing the partial response
      } else {
        // Other finish reasons are errors
        throw new Error(`Content generation stopped. Reason: ${candidate.finishReason}`);
      }
    }
    
    if (!candidate.content || !candidate.content.parts || !candidate.content.parts[0]) {
      console.error('❌ Invalid content structure:', JSON.stringify(candidate, null, 2));
      throw new Error('Invalid content structure in Gemini API response');
    }

    return candidate.content.parts[0].text;
  } catch (error) {
    // Enhanced error logging
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
      console.error(`Gemini API Error: ${error.code} - ${error.message}`);
    } else if (error.response) {
      console.error('Gemini API Error:', error.response?.data || error.message);
    } else {
      console.error('Gemini API Error:', error.message);
    }
    throw error;
  }
}

// Helper function to check if an error is non-retryable
function isNonRetryable(error) {
  const status = error.response?.status;
  return status === 400 || status === 401 || status === 403 || status === 404;
}

// Retry wrapper with exponential backoff and adaptive delays
// UPDATED: Now accepts fileMetadata instead of fileId
async function callGeminiAPIWithRetry(prompt, maxRetries = 2, fileMetadata = null, batchSize = 35, questionType = 'short_answer', modelName = null) {
  const baseDelay = 3000; // 3s base for better stability
  const maxDelay = 10000; // 10s max for rate limit recovery
  let lastError = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        // Special handling for different error types
        let delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
        
        // Longer delay for ECONNRESET to allow connection recovery
        if (lastError?.code === 'ECONNRESET') {
          delay = 5000;
          console.log(`⏳ Connection reset detected, waiting ${delay}ms for recovery...`);
        } else if (lastError?.response?.status === 429) {
          delay = 10000;
          console.log(`⏳ Rate limit detected, waiting ${delay}ms...`);
        } else {
          console.log(`⏳ Waiting ${delay}ms before retry...`);
        }
        
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      return await callGeminiAPI(prompt, fileMetadata, batchSize, questionType, modelName);
      
    } catch (error) {
      lastError = error;
      
      // Fast-fail on non-retryable errors
      if (isNonRetryable(error)) {
        console.error(`❌ Non-retryable error: ${error.message}`);
        throw error;
      }
      
      // Check for network/timeout errors that should be retried
      const isNetworkError = error.code === 'ECONNRESET' || 
                            error.code === 'ETIMEDOUT' || 
                            error.code === 'ECONNABORTED' ||
                            error.code === 'ENOTFOUND' ||
                            error.code === 'EAI_AGAIN' ||
                            error.message?.includes('socket hang up') ||
                            error.message?.includes('timeout') ||
                            error.message?.includes('Invalid content structure');
      
      // Last attempt - throw error
      if (attempt === maxRetries) {
        console.error(`❌ All ${maxRetries + 1} attempts failed`);
        throw error;
      }
      
      // Log retry with error details
      if (isNetworkError) {
        console.log(`⚠️ Retry ${attempt + 1}/${maxRetries} - Network error: ${error.code || error.message}`);
      } else {
        console.log(`⚠️ Retry ${attempt + 1}/${maxRetries} - Error: ${error.message}`);
      }
    }
  }
  
  // This should never be reached, but just in case
  throw lastError || new Error('API call failed after all retries');
}

// Construct prompt that requests JSONL (one JSON per line) with enhanced metadata
// OPTIMIZED: Reduced token consumption by 30-40% while maintaining clarity
// UPDATED: Added PDF context enforcement instructions
function constructBatchPrompt_JSONL(params) {
  const { subQuestion, startNumber, batchSize, subject, topic, chapters, language, fileId, isEduLabPdf, class_level } = params;
  const selectedLanguage = (language || 'english').toLowerCase();
  
  // Use chapters as the primary topic if provided, otherwise fall back to topic
  const effectiveTopic = chapters || topic;
  
  // Concise language mapping
  const langMap = {
    english: 'English',
    hindi: 'Hindi (Devanagari)',
    marathi: 'Marathi (Devanagari)',
    urdu: 'Urdu'
  };
  const lang = langMap[selectedLanguage] || 'English';

  // PDF-specific instructions when using File Search
  let pdfInstructions = '';
  if (fileId) {
    if (isEduLabPdf) {
      // EduLab PDF instructions (Maharashtra Board reference)
      pdfInstructions = `
CRITICAL - MAHARASHTRA BOARD REFERENCE CONTEXT:
- You have access to curated Maharashtra Board textbook/reference materials for this subject
- The PDF contains the complete subject textbook (multiple chapters/topics)
- SEARCH WITHIN THE PDF for content specifically related to the topic: "${effectiveTopic}"
- Generate ALL variations ONLY from the sections of the PDF that discuss "${effectiveTopic}"
- Use File Search to find relevant pages, chapters, and sections about "${effectiveTopic}"
- Maintain academic quality and accuracy aligned with Maharashtra Board standards
- DO NOT use any external knowledge or general information
- Every question MUST be directly based on specific content from the PDF related to "${effectiveTopic}"
- Reference specific chapters, sections, or pages from the PDF when possible
- If the PDF lacks sufficient information about "${effectiveTopic}", skip variations rather than inventing content
- Focus on the specific topic even if the PDF covers the entire subject

CRITICAL - QUESTION TEXT FORMATTING:
- NEVER include phrases like "According to the Maharashtra Board textbook" or "According to the textbook" in the question_text
- NEVER mention the source/textbook/PDF name in the question_text itself
- Write questions DIRECTLY without any prefixes or source references
- Source information belongs ONLY in the reference_source metadata field, NOT in question_text
- Example WRONG: "According to the Maharashtra Board Physics textbook, what is..."
- Example CORRECT: "What is the effect on the potential difference..."

`;
    } else {
      // User PDF instructions
      pdfInstructions = `
CRITICAL - PDF CONTEXT ENFORCEMENT:
- You MUST generate ALL variations ONLY from the provided PDF document
- DO NOT use any external knowledge, textbooks, or general information
- Every question MUST be directly based on specific content from the PDF
- DO NOT mention generic textbooks like "NCERT" or "Campbell Biology" in reference_source
- Reference specific sections or pages from the PDF when possible
- If the PDF lacks information for a variation, skip it rather than inventing content

CRITICAL - QUESTION TEXT FORMATTING:
- NEVER include phrases like "According to the PDF" or "According to the document" in the question_text
- NEVER mention the source/PDF name in the question_text itself
- Write questions DIRECTLY without any prefixes or source references
- Source information belongs ONLY in the reference_source metadata field, NOT in question_text
- Example WRONG: "According to the PDF document, what is..."
- Example CORRECT: "What is the effect on the potential difference..."

`;
    }
  }

  // Reference source format guidance (different for PDF vs non-PDF)
  // For EduLab PDFs, use subject name and class level instead of "PDF Document"
  let referenceGuidance;
  let exampleReference;
  
  if (fileId) {
    if (isEduLabPdf && subject && class_level) {
      // Format: "Biology Class 11 - Maharashtra Board Textbook, Chapter: X, Section: Y, Page: Z"
      const classLevelFormatted = class_level.replace(/class\s*/i, 'Class ');
      referenceGuidance = `reference_source: "${subject} ${classLevelFormatted} - Maharashtra Board Textbook, Chapter: [Chapter Name], Section: [Section Name], Page: [X-Y]" - MUST include chapter, section, and page numbers when available`;
      exampleReference = `"${subject} ${classLevelFormatted} - Maharashtra Board Textbook, Chapter: 2 - Kinematics, Section: 2.3 - Equations of Motion, Page: 45-47"`;
    } else {
      // Generic PDF reference for user-uploaded PDFs
      referenceGuidance = 'reference_source: "PDF Document, Chapter: [Chapter Name], Section: [Section Name], Page: [X-Y]" - MUST include chapter, section, and page numbers when available';
      exampleReference = '"PDF Document, Chapter: 2 - Kinematics, Section: 2.3 - Equations of Motion, Page: 45-47"';
    }
  } else {
    // Non-PDF reference
    referenceGuidance = 'reference_source: "Book: [Title], Chapter: [Chapter Number/Name], Section: [Section Name], Page: [X-Y]" - IMPORTANT: Use DIFFERENT educational sources for each variation from school/college textbooks and educational books. MUST include chapter, section, and page numbers';
    exampleReference = '"Book: NCERT Class 12 Physics, Chapter: 5 - Magnetism, Section: 5.2 - Magnetic Field Lines, Page: 156-158"';
  }

  // Add diversity instruction for non-PDF generation
  const diversityInstruction = !fileId ? `
CRITICAL - SOURCE DIVERSITY:
- Each variation MUST come from a DIFFERENT educational source
- Use diverse SCHOOL/COLLEGE TEXTBOOKS and EDUCATIONAL BOOKS including:
  
  SCHOOL TEXTBOOKS (Classes 6-12):
  - NCERT (all classes and subjects)
  - State Board books (Maharashtra, Karnataka, Tamil Nadu, etc.)
  - CBSE prescribed books
  - ICSE/ISC textbooks
  
  COLLEGE/UNIVERSITY TEXTBOOKS:
  - Standard university textbooks for undergraduate/postgraduate
  - Subject-specific college books
  - Professional course books (Engineering, Medical, Commerce, Arts)
  
  REFERENCE & COMPETITIVE EXAM BOOKS:
  - HC Verma (Physics)
  - RD Sharma, RS Aggarwal (Mathematics)
  - Pradeep, Lakhmir Singh (Science)
  - Campbell Biology, Solomon Biology
  - Arihant, MTG, Oswaal publications
  - S Chand, Pearson, McGraw Hill publications
  
  EDUCATIONAL BOOKS:
  - Subject encyclopedias
  - Educational reference guides
  - Academic journals and publications
  - Standard educational series books

DIVERSITY RULES:
- Vary the chapters and sections across different books
- DO NOT repeat the same book for consecutive variations
- Mix school textbooks, college books, and reference materials
- Include books from different publishers and educational boards
- Ensure educational diversity to provide comprehensive coverage from multiple perspectives
- Example sequence: NCERT Class 11 → HC Verma → State Board Class 12 → Campbell Biology → RD Sharma → University textbook

` : '';

  // Optimized prompt with reduced whitespace and concise instructions
  const prompt = `${pdfInstructions}${diversityInstruction}Generate ${batchSize} ${subQuestion.question_type} variations.
Subject: ${subject || 'General'} | Topic: ${effectiveTopic || 'General'}${class_level ? ` | Class Level: ${class_level}` : ''}
Language: ${lang} (metadata in English)
Type: ${subQuestion.question_type} | Marks: ${subQuestion.marks}${subQuestion.question_type === 'mcq' ? ' | 4 options' : ''}${subQuestion.question_type === 'short_answer' ? ' | 4-5 line answer' : ''}

${class_level ? `IMPORTANT: Generate questions appropriate for ${class_level} students. Ensure difficulty, vocabulary, and concepts match this educational level.\n\n` : ''}Metadata (English):
1. ${referenceGuidance}
   CRITICAL: Always provide complete reference with:
   - Book/Document name
   - Chapter number AND name
   - Section number AND name (if applicable)
   - Specific page numbers or page range
   Example: "Book: NCERT Class 11 Chemistry, Chapter: 4 - Chemical Bonding, Section: 4.3 - Lewis Structures, Page: 112-115"

2. difficulty_level: Easy|Medium|Hard
   Easy: Recall/Recognition | Medium: Application/Understanding | Hard: Analysis/Synthesis
   
3. difficulty_reason: 2-3 sentences explaining WHY this difficulty level
   - For Easy: Explain what makes it straightforward (direct recall, simple concept)
   - For Medium: Explain what application/understanding is needed
   - For Hard: Explain what analysis/synthesis/critical thinking is required

Distribution: 30% Easy, 40% Medium, 30% Hard

JSONL output (one JSON per line):
{"variation_number":${startNumber},"question_text":"...","correct_answer":"...","quality_score":0.85,"marks":${subQuestion.marks}${subQuestion.question_type === 'mcq' ? ',"options":["A) ...","B) ...","C) ...","D) ..."]' : ''},"reference_source":${exampleReference},"difficulty_level":"Medium","difficulty_reason":"..."}

Generate ${batchSize} lines starting at ${startNumber}.`;

  return prompt;
}

// Helper function: Try JSONL parsing (line-by-line with prefix removal)
function tryJSONLParse(text, startNumber, forcedDifficulty) {
  const lines = text.split(/\r?\n/);
  const parsed = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    
    try {
      // Remove common prefixes: "1. ", "Variation 1: ", etc.
      const cleaned = trimmed.replace(/^\d+[\.\:\)]\s*/, '').replace(/^Variation\s+\d+[\.\:\)]\s*/i, '');
      const obj = JSON.parse(cleaned);
      
      if (obj.question_text && obj.correct_answer) {
        parsed.push(obj);
      }
    } catch (e) {
      // Skip invalid lines silently
    }
  }
  
  return parsed.length > 0 ? normalizeArray(parsed, startNumber, forcedDifficulty) : null;
}

// Helper function: Try JSON array parsing
function tryJSONArrayParse(text, startNumber, forcedDifficulty) {
  try {
    const arr = JSON.parse(text);
    if (Array.isArray(arr) && arr.length > 0) {
      return normalizeArray(arr, startNumber, forcedDifficulty);
    }
  } catch (e) {
    // Not a valid JSON array
  }
  return null;
}

// Helper function: Try brace-balanced extraction with 50KB limit
function tryBraceBalancedParse(text, startNumber, forcedDifficulty, maxLength = 50000) {
  const objects = [];
  let braceCount = 0;
  let startIdx = -1;
  let inString = false;
  let escapeNext = false;
  
  // Limit search to first 50KB to prevent excessive processing
  const searchText = text.substring(0, maxLength);
  
  for (let i = 0; i < searchText.length; i++) {
    const ch = searchText[i];
    
    // Handle string escaping
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\') {
      escapeNext = true;
      continue;
    }
    
    // Track if we're inside a string
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    
    // Only count braces outside of strings
    if (!inString) {
      if (ch === '{') {
        if (braceCount === 0) startIdx = i;
        braceCount++;
      } else if (ch === '}') {
        braceCount--;
        if (braceCount === 0 && startIdx !== -1) {
          const candidate = searchText.substring(startIdx, i + 1);
          try {
            const obj = JSON.parse(candidate);
            objects.push(obj);
          } catch (e) {
            // Skip invalid JSON silently
          }
          startIdx = -1;
        }
      }
    }
  }
  
  return objects.length > 0 ? normalizeArray(objects, startNumber, forcedDifficulty) : null;
}

// Robust parser: try JSONL first -> array -> brace-balanced objects
function parseBatchResponse_Robust(responseText, startNumber, forcedDifficulty, performanceTracker = null) {
  if (performanceTracker) {
    performanceTracker.markParseStart();
  }
  
  try {
    if (!responseText || typeof responseText !== 'string') {
      if (performanceTracker) {
        performanceTracker.markParseEnd();
      }
      return [];
    }

    // Clean markdown code fences if any
    const text = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    // Try parsing strategies in order of speed
    const result = 
      tryJSONLParse(text, startNumber, forcedDifficulty) ||
      tryJSONArrayParse(text, startNumber, forcedDifficulty) ||
      tryBraceBalancedParse(text, startNumber, forcedDifficulty, 50000);
    
    if (performanceTracker) {
      performanceTracker.markParseEnd();
    }
    
    if (result && result.length > 0) {
      return result;
    }

    // If nothing parsed
    console.error(`❌ Parsing failed - no valid JSON found`);
    return [];
  } catch (error) {
    console.error('parseBatchResponse_Robust unexpected error:', error);
    if (performanceTracker) {
      performanceTracker.markParseEnd();
    }
    return [];
  }
}

function normalizeArray(arr, startNumber, forcedDifficulty) {
  // Capitalize the forced difficulty (e.g., 'medium' -> 'Medium')
  const capitalizedDifficulty = forcedDifficulty 
    ? forcedDifficulty.charAt(0).toUpperCase() + forcedDifficulty.slice(1).toLowerCase()
    : 'Medium';
  
  // Track statistics for summary logging (single pass)
  let missingReference = 0;
  let missingReason = 0;
  let invalidCount = 0;
  
  // Pre-allocate array for better performance
  const valid = [];
  valid.length = 0; // Ensure clean start
  
  // Single-pass validation and normalization
  for (let idx = 0; idx < arr.length; idx++) {
    const v = arr[idx];
    
    // Validate required fields
    if (!v || typeof v !== 'object' || !v.question_text || !v.correct_answer) {
      invalidCount++;
      continue;
    }
    
    // Track missing metadata
    if (!v.reference_source) missingReference++;
    if (!v.difficulty_reason) missingReason++;
    
    // Optimized quality_score validation (streamlined logic)
    const rawQuality = v.quality_score;
    let parsedQuality = 0.5; // default
    
    if (rawQuality !== undefined && rawQuality !== null && rawQuality !== '') {
      const numQuality = Number(rawQuality);
      if (!Number.isNaN(numQuality)) {
        parsedQuality = Math.max(0.1, Math.min(1.0, numQuality));
      }
    }
    parsedQuality = Math.round(parsedQuality * 100) / 100;
    
    // Build normalized object
    valid.push({
      variation_number: v.variation_number || (startNumber + idx),
      question_text: v.question_text.trim(),
      correct_answer: v.correct_answer.trim(),
      quality_score: parsedQuality,
      options: Array.isArray(v.options) ? v.options : null,
      marks: v.marks || null,
      reference_source: v.reference_source || null,
      difficulty_level: capitalizedDifficulty,
      difficulty_reason: v.difficulty_reason || null
    });
  }
  
  // Summary statistics logging only
  if (invalidCount > 0) {
    console.log(`⚠️  Filtered ${invalidCount} invalid objects`);
  }
  console.log(`✅ Normalized ${valid.length} variations - Missing: ${missingReference} refs, ${missingReason} reasons`);
  
  return valid;
}

// Helper function: Update file usage count asynchronously (non-blocking)
async function updateFileUsageAsync(fileId) {
  try {
    await db.query(
      'UPDATE file_search_uploads SET usage_count = usage_count + 1, last_used_timestamp = NOW() WHERE file_id = ?',
      [fileId]
    );
  } catch (error) {
    console.error('File usage update failed:', error.message);
  }
}

// Batch generation helper: Save variations in bulk with enhanced metadata
async function saveVariationsBatch(variations, context, performanceTracker = null) {
  const { subQuestion, userId, subjectId, fileId, pdfFilename } = context;
  
  if (!variations || variations.length === 0) {
    throw new Error('No variations to save');
  }

  try {
    if (performanceTracker) {
      performanceTracker.markDBStart();
    }
    
    // Pre-allocate values array with exact size (avoid dynamic resizing)
    const values = new Array(variations.length);
    
    // Keep the AI-generated detailed reference_source, store PDF filename separately
    // The AI provides detailed references like: "PDF Document, Chapter: X, Section: Y, Page: Z"
    // We store this in reference_source and the filename in pdf_filename column
    
    for (let i = 0; i < variations.length; i++) {
      const v = variations[i];
      values[i] = [
        subQuestion.parent_question_id,
        subQuestion.sub_question_id,
        subQuestion.paper_id,
        v.variation_number,
        v.question_text,
        subQuestion.question_type,
        v.options ? JSON.stringify(v.options) : null,
        v.correct_answer,
        v.quality_score,
        v.marks || subQuestion.marks,
        subQuestion.difficulty || 'medium',
        subQuestion.section_name,
        userId,
        subjectId,
        'draft',
        v.reference_source, // Keep AI-generated detailed reference (e.g., "PDF Document, Chapter: 1, Section: 1.2, Page: 10")
        v.difficulty_level, // NEW: Easy/Medium/Hard classification
        v.difficulty_reason, // NEW: explanation of difficulty
        pdfFilename // Store PDF filename separately for tracking
      ];
    }

    // Single bulk insert query with new metadata columns including pdf_filename (subject-based system)
    const query = `
      INSERT INTO question_variations 
      (parent_question_id, sub_question_id, paper_id, variation_number, 
       question_text, question_type, options, correct_answer, quality_score, marks, 
       difficulty, section_name, created_by, subject_id, status,
       reference_source, difficulty_level, difficulty_reason, pdf_filename) 
      VALUES ?
    `;

    const [result] = await db.query(query, [values]);

    if (performanceTracker) {
      performanceTracker.markDBEnd();
    }
    
    // Return saved variations with IDs and metadata
    const savedVariations = variations.map((v, index) => ({
      variation_id: result.insertId + index,
      variation_number: v.variation_number,
      full_number: `${subQuestion.full_question_number}.${v.variation_number}`,
      question_text: v.question_text,
      correct_answer: v.correct_answer,
      quality_score : v.quality_score,
      options: v.options,
      marks: v.marks || subQuestion.marks,
      status: 'draft',
      reference_source: v.reference_source, // Keep AI-generated detailed reference
      difficulty_level: v.difficulty_level,
      difficulty_reason: v.difficulty_reason,
      pdf_filename: pdfFilename
    }));

    // Summary logging only
    const withReference = savedVariations.filter(v => v.reference_source).length;
    const difficultyDistribution = {
      Easy: savedVariations.filter(v => v.difficulty_level === 'Easy').length,
      Medium: savedVariations.filter(v => v.difficulty_level === 'Medium').length,
      Hard: savedVariations.filter(v => v.difficulty_level === 'Hard').length
    };
    console.log(`💾 Saved ${savedVariations.length} variations (IDs: ${result.insertId}-${result.insertId + savedVariations.length - 1}) - ${withReference} refs, Difficulty: E=${difficultyDistribution.Easy} M=${difficultyDistribution.Medium} H=${difficultyDistribution.Hard}`);
    
    // Update file usage count asynchronously (non-blocking)
    if (fileId) {
      updateFileUsageAsync(fileId).catch(err => 
        console.error('Async file usage update error:', err.message)
      );
    }
    
    return savedVariations;
    
  } catch (error) {
    console.error('Database bulk insert error:', error);
    if (performanceTracker) {
      performanceTracker.markDBEnd();
    }
    throw new Error(`Failed to save variations: ${error.message}`);
  }
}

// Create a main question (e.g., Q1, Q2)
router.post('/create-main-question', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { paper_id, question_number, subject, topic, question_type } = req.body;
    const userId = req.user.user_id;
    const subjectId = req.user.subject_id;
    
    if (!paper_id || !question_number) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Normalize question_type to match database ENUM values
    const normalizeQuestionType = (type) => {
      if (!type) return 'short_answer';

      // Convert to lowercase and replace spaces with underscores
      const normalized = type.toLowerCase().replace(/\s+/g, '_');

      // Map common variations to standard values
      const typeMap = {
        'mcq': 'mcq',
        'multiple_choice': 'mcq',
        'short_answer': 'short_answer',
        'short': 'short_answer',
        'long_answer': 'long_answer',
        'long': 'long_answer',
        'true_false': 'true_false',
        'true/false': 'true_false',
        'fill_in_blanks': 'fill_in_blanks',
        'fill_in_the_blanks': 'fill_in_blanks',
        'matching': 'matching',
        'match_the_following': 'matching',
        'numerical': 'numerical',
        'diagram': 'diagram',
        'case_study': 'case_study',
        'practical': 'practical',
        'coding': 'coding'
      };

      return typeMap[normalized] || 'short_answer';
    };

    // Use provided question_type or default to 'short_answer' for parent questions
    const validQuestionType = normalizeQuestionType(question_type);

    // Create parent question (subject-based system)
    const [result] = await db.query(
      `INSERT INTO questions (question_text, question_type, marks, difficulty, created_by, subject_id, status, has_variations) 
       VALUES (?, ?, ?, ?, ?, ?, 'draft', TRUE)`,
      [
        `${question_number} - ${subject || 'General'} - ${topic || 'General'}`,
        validQuestionType,
        0, // Total marks will be sum of sub-questions
        'medium',
        userId,
        subjectId
      ]
    );

    const parentQuestionId = result.insertId;

    // Link to paper
    const [countResult] = await db.query(
      'SELECT COUNT(*) as count FROM paper_questions WHERE paper_id = ?',
      [paper_id]
    );
    const questionOrder = countResult[0].count + 1;

    await db.query(
      'INSERT INTO paper_questions (paper_id, question_id, question_order) VALUES (?, ?, ?)',
      [paper_id, parentQuestionId, questionOrder]
    );

    // Update paper to use variations mode
    await db.query(
      'UPDATE question_papers SET uses_variations = TRUE WHERE paper_id = ?',
      [paper_id]
    );

    res.status(201).json({
      success: true,
      message: `Created main question ${question_number}`,
      parent_question_id: parentQuestionId,
      question_number
    });

  } catch (err) {
    console.error('Create main question error:', err);
    res.status(500).json({ success: false, message: 'Failed to create main question', error: err.message });
  }
});

// Create a sub-question (e.g., Q1.a, Q1.b)
router.post('/create-sub-question', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { parent_question_id, paper_id, sub_question_number, question_type, marks, section_name, difficulty } = req.body;
    const userId = req.user.user_id;
    const subjectId = req.user.subject_id;
    
    if (!parent_question_id || !paper_id || !sub_question_number) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Get parent question details
    const [parentQuestions] = await db.query(
      'SELECT question_text FROM questions WHERE question_id = ?',
      [parent_question_id]
    );

    if (parentQuestions.length === 0) {
      return res.status(404).json({ success: false, message: 'Parent question not found' });
    }

    // Extract question number (e.g., "Q1" from "Q1 - Subject - Topic")
    const questionNumber = parentQuestions[0].question_text.split(' - ')[0];
    const fullQuestionNumber = `${questionNumber}.${sub_question_number}`;

    // Create sub-question with difficulty
    const [result] = await db.query(
      `INSERT INTO sub_questions 
       (parent_question_id, paper_id, sub_question_number, full_question_number, question_type, marks, difficulty, section_name, created_by) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        parent_question_id,
        paper_id,
        sub_question_number,
        fullQuestionNumber,
        question_type || 'short_answer',
        marks || 5,
        difficulty || 'medium',
        section_name || null,
        userId
      ]
    );

    res.status(201).json({
      success: true,
      message: `Created sub-question ${fullQuestionNumber}`,
      sub_question_id: result.insertId,
      full_question_number: fullQuestionNumber
    });

  } catch (err) {
    console.error('Create sub-question error:', err);
    res.status(500).json({ success: false, message: 'Failed to create sub-question', error: err.message });
  }
});

// Generate variations for a sub-question
router.post('/generate-variations', authMiddleware, requireRole('examiner'), async (req, res) => {
  
   try {
    const { 
      sub_question_id, 
      num_variations, 
      subject, 
      topic, 
      chapters, 
      language, 
      fileId, 
      usePdfContext,
      starting_variation, // optional starting index
      class_level // NEW: Class level from template
    } = req.body;
    const userId = req.user.user_id;
    
    // Get subject_id from subjects table using subject name from frontend
    let subjectId = null;
    let effectiveSubjectName = subject;
    
    if (subject) {
      try {
        const [subjectInfo] = await db.query(
          'SELECT subject_id, subject_name FROM subjects WHERE LOWER(subject_name) LIKE LOWER(?) OR LOWER(subject_code) LIKE LOWER(?)',
          [`%${subject}%`, `%${subject}%`]
        );
        
        if (subjectInfo.length > 0) {
          subjectId = subjectInfo[0].subject_id;
          effectiveSubjectName = subjectInfo[0].subject_name;
          console.log(`📚 Subject lookup: "${subject}" -> subject_id: ${subjectId}, subject_name: "${effectiveSubjectName}"`);
        } else {
          console.warn(`⚠️ Subject "${subject}" not found in database, falling back to user's subject_id`);
          subjectId = req.user.subject_id;
        }
      } catch (subjectError) {
        console.error(`❌ Error looking up subject: ${subjectError.message}`);
        subjectId = req.user.subject_id;
      }
    } else {
      // If no subject provided, use user's subject_id
      subjectId = req.user.subject_id;
    }
    
    if (!sub_question_id || !num_variations) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Validate minimum variations
    if (num_variations <= 3) {
      return res.status(400).json({ success: false, message: 'More than 3 variations required (minimum 4)' });
    }
   
    // Maximum limit: 1000 variations per request
    if (num_variations > 1000) {
      return res.status(400).json({ 
        success: false, 
        message: 'Maximum 1000 variations allowed per request. Please request fewer variations.' 
      });
    }

    // Get sub-question details
    const [subQuestions] = await db.query(
      `SELECT sq.*, q.question_id as parent_question_id 
       FROM sub_questions sq
       JOIN questions q ON sq.parent_question_id = q.question_id
       WHERE sq.sub_question_id = ?`,
      [sub_question_id]
    );

    if (subQuestions.length === 0) {
      return res.status(404).json({ success: false, message: 'Sub-question not found' });
    }

    const subQuestion = subQuestions[0];
    const selectedLanguage = language || 'english';
    
    // Log received PDF parameters for debugging
    console.log(`📋 Request PDF parameters: fileId=${fileId}, usePdfContext=${usePdfContext}`);
    
    // Use PDF fileId from request (validated by frontend)
    // IMPORTANT: Only use the fileId that was explicitly provided and validated by the frontend
    // Do NOT auto-retrieve PDFs to avoid using the wrong PDF
    let effectiveFileId = fileId;
    let effectiveUsePdfContext = usePdfContext;
    
    if (effectiveFileId) {
      console.log(`📄 Using validated PDF from request: ${effectiveFileId}`);
      effectiveUsePdfContext = true;
    } else if (usePdfContext) {
      // If usePdfContext is true but no fileId provided, log warning and disable PDF context
      console.warn(`⚠️ usePdfContext=true but no fileId provided. Disabling PDF context to avoid using wrong PDF.`);
      effectiveUsePdfContext = false;
    }
    
    // Auto-calculate starting_variation if not provided
    let effectiveStartingVariation = starting_variation;
    if (!effectiveStartingVariation) {
      // Get the highest variation number for this sub-question
      const [maxVariation] = await db.query(
        'SELECT MAX(variation_number) as max_num FROM question_variations WHERE sub_question_id = ?',
        [sub_question_id]
      );
      
      const maxNum = maxVariation[0]?.max_num || 0;
      effectiveStartingVariation = maxNum + 1;
      console.log(`📊 Auto-calculated starting variation: ${effectiveStartingVariation} (existing: ${maxNum})`);
    }
    
    // Retrieve file metadata for PDF context enforcement
    let usedPdfReference = false;
    let fileMetadata = null;
    let pdfFilename = null;
    let fileSearchWarning = null;
    
    if (effectiveUsePdfContext && effectiveFileId) {
      try {
        console.log(`📄 Retrieving file metadata for PDF context: ${effectiveFileId}`);
        const fileSearchService = new FileSearchService();
        
        // Retrieve file metadata (includes URI needed for File Search)
        fileMetadata = await fileSearchService.getFileMetadata(effectiveFileId);
        
        // Also get the original filename from our database
        const [fileRecords] = await db.query(
          'SELECT original_filename FROM file_search_uploads WHERE file_id = ? LIMIT 1',
          [effectiveFileId]
        );
        
        if (fileRecords && fileRecords.length > 0) {
          pdfFilename = fileRecords[0].original_filename;
          console.log(`📄 PDF filename from database: ${pdfFilename}`);
        }
        
        if (fileMetadata && fileMetadata.state === 'ACTIVE') {
          usedPdfReference = true;
          console.log(`✅ File metadata retrieved: ${fileMetadata.fileId}, state: ${fileMetadata.state}`);
          console.log(`📄 File URI: ${fileMetadata.uri}`);
          
          // Increment usage count for this file
          try {
            await db.query(
              'UPDATE file_search_uploads SET usage_count = usage_count + 1, last_used_timestamp = CURRENT_TIMESTAMP WHERE file_id = ?',
              [effectiveFileId]
            );
            console.log(`📊 Incremented usage count for file ${effectiveFileId}`);
          } catch (usageError) {
            console.error('Error incrementing usage count:', usageError);
            // Don't fail generation if usage count update fails
          }
        } else if (fileMetadata && fileMetadata.state !== 'ACTIVE') {
          console.warn(`⚠️ File ${effectiveFileId} is not active (state: ${fileMetadata.state}), proceeding without PDF context`);
          fileSearchWarning = `File is not ready (state: ${fileMetadata.state}). Generating questions without PDF context.`;
          fileMetadata = null;
          pdfFilename = null;
        } else {
          console.warn(`⚠️ File ${effectiveFileId} not found, proceeding without PDF context`);
          fileSearchWarning = 'File not found in File Search Store. Generating questions without PDF context.';
          fileMetadata = null;
          pdfFilename = null;
        }
      } catch (fileError) {
        console.error('Error retrieving file metadata:', {
          message: fileError.message,
          code: fileError.code,
          statusCode: fileError.statusCode
        });
        
        // Determine appropriate warning message based on error type
        if (fileError.code === 'RATE_LIMIT') {
          fileSearchWarning = 'Rate limit exceeded. Generating questions without PDF context.';
        } else if (fileError.code === 'TIMEOUT') {
          fileSearchWarning = 'File Search timeout. Generating questions without PDF context.';
        } else if (fileError.code === 'NETWORK_ERROR') {
          fileSearchWarning = 'Network error accessing File Search. Generating questions without PDF context.';
        } else if (fileError.code === 'SERVICE_UNAVAILABLE') {
          fileSearchWarning = 'File Search service temporarily unavailable. Generating questions without PDF context.';
        } else {
          fileSearchWarning = `File Search error: ${fileError.message}. Generating questions without PDF context.`;
        }
        
        console.log(`⚠️ ${fileSearchWarning}`);
        fileMetadata = null;
        pdfFilename = null;
        // Continue without PDF context - graceful degradation, don't fail the generation
      }
    }
    
    // Update effectiveFileId with actual file ID from metadata if retrieved
    if (fileMetadata) {
      effectiveFileId = fileMetadata.fileId;
    }
    
    // PRIORITY 2: If no user PDF, check for EduLab department PDFs
    let edulabPdfMetadata = [];
    let edulabPdfFilenames = [];
    let detectedClassLevel = class_level || null; // Store detected class level for later use
    
    if (!fileMetadata && !effectiveFileId) {
      try {
        // Use chapters if provided, otherwise fall back to topic
        const searchTopic = chapters || topic;
        console.log(`🔍 No user PDF provided, checking for EduLab PDFs (subject: ${subjectId}, topic: ${searchTopic})`);
        
        // NEW: Use class_level from request (template) if provided, otherwise detect from subject
        let classLevel = detectedClassLevel;
        
        if (!classLevel) {
          // Get subject details to extract class level (e.g., "Class 11" from subject name or level field)
          const [subjectInfo] = await db.query(
            'SELECT subject_name, level FROM subjects WHERE subject_id = ?',
            [subjectId]
          );
          
          if (subjectInfo.length > 0) {
            // Try to extract class from subject name (e.g., "Physics - Class 11" or "Class 11 Physics")
            const subjectName = subjectInfo[0].subject_name || '';
            const levelField = subjectInfo[0].level || '';
            
            // Check level field first
            if (levelField && levelField.match(/class\s*\d+/i)) {
              classLevel = levelField.match(/class\s*\d+/i)[0];
            }
            // Then check subject name
            else if (subjectName.match(/class\s*\d+/i)) {
              classLevel = subjectName.match(/class\s*\d+/i)[0];
            }
          }
        }
        
        // Update the outer variable so it's accessible later
        detectedClassLevel = classLevel;
        
        console.log(`📚 Class level: ${classLevel || 'not specified'} (source: ${class_level ? 'template' : 'auto-detected'})`);

        
        // Query for EduLab PDFs matching subject (and optionally class_level)
        // Note: topic is typically NULL for full subject PDFs, so we rely on Gemini File Search
        // to semantically find the topic within the PDF content
        // IMPORTANT: Use fuzzy matching for subject names to handle variations
        const { getSubjectMatcher } = require('../utils/subjectMatcher');
        const subjectMatcher = getSubjectMatcher();
        
        // Generate fuzzy match SQL
        const subjectMatch = subjectMatcher.generateSQLMatch(effectiveSubjectName, 'subject_name');
        
        let query = `SELECT pdf_id, file_id, original_filename, display_name, topic, class_level, subject_name
           FROM subject_level_pdfs
           WHERE ${subjectMatch.sql}
             AND status = 'active'`;
        const params = [...subjectMatch.params];
        
        // Add class_level filter if detected
        if (classLevel) {
          query += ` AND (class_level = ? OR class_level IS NULL)`;
          params.push(classLevel);
        }
        
        query += ` ORDER BY 
             CASE WHEN class_level = ? THEN 0 ELSE 1 END,
             usage_count DESC, 
             upload_timestamp DESC
           LIMIT 5`;
        params.push(classLevel || '');
        
        console.log(`🔍 Fuzzy matching PDFs for subject: "${effectiveSubjectName}" (normalized: "${subjectMatcher.normalize(effectiveSubjectName)}")`);
        
        const [edulabPdfs] = await db.query(query, params);
        
        if (edulabPdfs.length > 0) {
          console.log(`✅ Found ${edulabPdfs.length} EduLab PDFs for subject "${effectiveSubjectName}"`);
          edulabPdfs.forEach(pdf => {
            const similarity = subjectMatcher.calculateSimilarity(effectiveSubjectName, pdf.subject_name);
            console.log(`   - ${pdf.subject_name} (similarity: ${(similarity * 100).toFixed(1)}%)`);
          });
          
          // Retrieve file metadata for each EduLab PDF
          const fileSearchService = new FileSearchService();
          
          for (const pdf of edulabPdfs) {
            try {
              const metadata = await fileSearchService.getFileMetadata(pdf.file_id);
              
              if (metadata && metadata.state === 'ACTIVE') {
                edulabPdfMetadata.push(metadata);
                edulabPdfFilenames.push(pdf.original_filename);
                console.log(`✅ EduLab PDF active: ${pdf.original_filename} (${pdf.file_id})`);
                
                // Increment usage count
                await db.query(
                  'UPDATE subject_level_pdfs SET usage_count = usage_count + 1, last_used_timestamp = CURRENT_TIMESTAMP WHERE pdf_id = ?',
                  [pdf.pdf_id]
                );
              } else {
                console.warn(`⚠️ EduLab PDF not active: ${pdf.original_filename} (state: ${metadata?.state})`);
              }
            } catch (pdfError) {
              console.error(`Error retrieving EduLab PDF ${pdf.file_id}:`, pdfError.message);
              // Continue with other PDFs
            }
          }
          
          if (edulabPdfMetadata.length > 0) {
            usedPdfReference = true;
            fileMetadata = edulabPdfMetadata[0]; // Use first PDF as primary
            effectiveFileId = fileMetadata.fileId;
            
            // Set pdfFilename based on user department
            if (req.user.department?.toLowerCase() === 'edulab') {
              pdfFilename = `EduLab PDF: ${edulabPdfFilenames.join(', ')}`;
            } else {
              // For non-EduLab users: hide PDF source, show only subject + class level + Maharashtra Board
              // This prevents users from knowing that admin-uploaded PDFs are being used
              const classLevelFormatted = classLevel ? classLevel.replace(/class\s*/i, 'Class ') : '';
              pdfFilename = classLevelFormatted 
                ? `${effectiveSubjectName} ${classLevelFormatted} - Maharashtra Board Textbook`
                : `${effectiveSubjectName} - Maharashtra Board Textbook`;
            }
            
            console.log(`📄 Using EduLab PDFs as context: ${pdfFilename}`);
          } else {
            console.log(`⚠️ No active EduLab PDFs found, proceeding without PDF context`);
          }
        } else {
          console.log(`ℹ️ No EduLab PDFs found for subject "${effectiveSubjectName}" and topic ${topic}`);
        }
      } catch (edulabError) {
        console.error('Error querying EduLab PDFs:', edulabError.message);
        // Continue without EduLab PDFs - graceful degradation
      }
    }
    
    // Legacy code compatibility - this section can be removed later
    if (usePdfContext && fileId && !fileMetadata) {
      try {
        console.log(`📄 Using File Search with file ID: ${fileId}`);
        const fileSearchService = new FileSearchService();
        
        // Verify file exists in File Search Store
        const fileExists = await fileSearchService.fileExists(fileId);
        
        if (fileExists) {
          usedPdfReference = true;
          console.log(`✅ File Search enabled for question generation`);
          
          // Increment usage count for this file
          try {
            await db.query(
              'UPDATE file_search_uploads SET usage_count = usage_count + 1, last_used_timestamp = CURRENT_TIMESTAMP WHERE file_id = ?',
              [fileId]
            );
            console.log(`📊 Incremented usage count for file ${fileId}`);
          } catch (usageError) {
            console.error('Error incrementing usage count:', usageError);
            // Don't fail generation if usage count update fails
          }
        } else {
          console.warn(`⚠️ File ${fileId} not found in File Search Store, proceeding without PDF context`);
          fileSearchWarning = 'File not found in File Search Store. Generating questions without PDF context.';
        }
      } catch (fileError) {
        console.error('Error verifying File Search file:', {
          message: fileError.message,
          code: fileError.code,
          statusCode: fileError.statusCode
        });
        
        // Determine appropriate warning message based on error type
        if (fileError.code === 'RATE_LIMIT') {
          fileSearchWarning = 'Rate limit exceeded. Generating questions without PDF context.';
        } else if (fileError.code === 'TIMEOUT') {
          fileSearchWarning = 'File Search timeout. Generating questions without PDF context.';
        } else if (fileError.code === 'NETWORK_ERROR') {
          fileSearchWarning = 'Network error accessing File Search. Generating questions without PDF context.';
        } else if (fileError.code === 'SERVICE_UNAVAILABLE') {
          fileSearchWarning = 'File Search service temporarily unavailable. Generating questions without PDF context.';
        } else {
          fileSearchWarning = `File Search error: ${fileError.message}. Generating questions without PDF context.`;
        }
        
        console.log(`⚠️ ${fileSearchWarning}`);
        // Continue without PDF context - graceful degradation, don't fail the generation
      }
    }

    // Use the difficulty from the sub-question (from template or database)
    const subQuestionDifficulty = subQuestion.difficulty || 'medium';
    console.log(`🎯 Using difficulty level: ${subQuestionDifficulty} for all variations`);

    // Calculate optimal batch size based on question type and File Search usage
    const optimalBatchSize = calculateOptimalBatchSize(subQuestion.question_type, usedPdfReference);
    console.log(`📊 Calculated optimal batch size: ${optimalBatchSize} (type: ${subQuestion.question_type}, fileSearch: ${usedPdfReference})`);

    // Initialize rate limiting components
    const rateLimiter = getRateLimiter();
    const circuitBreaker = getCircuitBreaker();
    const modelSelector = getModelSelector();
    
    // Select best available model
    let currentModel = null;
    try {
      currentModel = await modelSelector.selectBestModel();
      console.log(`🤖 Selected model for generation: ${currentModel}`);
    } catch (modelError) {
      console.error('❌ Failed to select model:', modelError.message);
      return res.status(500).json({
        success: false,
        message: 'Failed to select AI model for generation',
        error: modelError.message
      });
    }
    
    // Check circuit breaker state before starting
    const circuitCheck = circuitBreaker.canProceed();
    if (!circuitCheck.allowed) {
      return res.status(503).json({
        success: false,
        message: circuitCheck.message,
        error: 'circuit_breaker_open',
        retryAfter: Math.ceil(circuitCheck.remainingMs / 1000),
        circuitState: circuitBreaker.getState()
      });
    }

    // Starting indices & counters
    let currentStart = effectiveStartingVariation;
    
    // Generate ALL requested variations in a loop (up to 1000 max)
    // The backend will handle multiple batches automatically
    let remaining = num_variations;
    const allSavedVariations = []; // accumulate saved DB rows
    let generationError = null;
    
    // Initialize adaptive batch sizer
    const batchSizer = new AdaptiveBatchSizer(optimalBatchSize);

    // Track generation statistics
    const generationStartTime = Date.now();
    let batchesProcessed = 0;
    const WARMUP_TIME_MS = 10000;

    console.log(`🚀 Starting generation: ${num_variations} variations, starting at ${currentStart}, language=${selectedLanguage}`);
    console.log(`📊 Initial batch size: ${optimalBatchSize}`);
    
    // Model warmup: wait 10 seconds before first batch to prevent overload
    console.log('🔥 Model warmup: waiting 10 seconds before first batch...');
    await new Promise(resolve => setTimeout(resolve, WARMUP_TIME_MS));
    console.log('✅ Warmup complete, starting generation');
    
    // Loop until we've generated requested variations or an error happens
    while (remaining > 0) {
      const thisBatchSize = Math.min(remaining, batchSizer.getCurrentBatchSize());
      const batchNumber = Math.ceil((currentStart - effectiveStartingVariation) / optimalBatchSize) + 1;
      const totalBatches = Math.ceil(num_variations / optimalBatchSize);

      console.log(`🧩 Batch ${batchNumber}/${totalBatches}: ${thisBatchSize} variations (start ${currentStart})`);

      // Build prompt for this batch (JSONL output requested)
      const batchPrompt = constructBatchPrompt_JSONL({
        subQuestion,
        startNumber: currentStart,
        batchSize: thisBatchSize,
        subject: effectiveSubjectName,  // Use subject name from database
        topic,
        chapters,
        language: selectedLanguage,
        fileId: effectiveFileId,
        isEduLabPdf: edulabPdfMetadata.length > 0,  // Flag to indicate EduLab PDF usage
        class_level: detectedClassLevel  // Pass detected or provided class level to prompt
      });

      // Estimate tokens for this request
      const tokenEstimate = TokenEstimator.estimateTotalTokens(
        batchPrompt,
        subQuestion.question_type,
        thisBatchSize,
        usedPdfReference,
        selectedLanguage
      );
      
      console.log(`📊 Token estimate: ${tokenEstimate.total} (input: ${tokenEstimate.inputTokens}, output: ${tokenEstimate.outputTokens})`);

      // Check and wait for rate limit budget
      try {
        await rateLimiter.waitForBudget(tokenEstimate.total, 120000);
        const stats = rateLimiter.getUsageStats();
        console.log(`📊 Rate limits: RPM ${stats.currentRPM}/${stats.rpmLimit} (${stats.rpmUtilization}%), TPM ${stats.currentTPM}/${stats.tpmLimit} (${stats.tpmUtilization}%)`);
      } catch (budgetError) {
        console.error('❌ Rate limit budget timeout:', budgetError.message);
        generationError = budgetError;
        
        // Return partial results if we have any
        if (allSavedVariations.length > 0) {
          const finalStats = rateLimiter.getUsageStats();
          return res.status(206).json({
            success: true,
            partial: true,
            message: `Generated ${allSavedVariations.length} of ${num_variations} requested variations (rate limit budget timeout)`,
            variations: allSavedVariations,
            warning: 'Rate limit budget unavailable. Please reduce the number of variations or try again later.',
            error_details: budgetError.message,
            stats: finalStats
          });
        } else {
          const finalStats = rateLimiter.getUsageStats();
          return res.status(429).json({
            success: false,
            message: 'Rate limit budget unavailable. System is at capacity.',
            error: 'rate_limit_budget_timeout',
            suggestion: 'Please reduce the number of variations requested or try again later.',
            stats: finalStats
          });
        }
      }

      let responseText;
      try {
        // Pass fileMetadata (not fileId) for proper PDF context enforcement
        responseText = await callGeminiAPIWithRetry(batchPrompt, 2, fileMetadata, thisBatchSize, subQuestion.question_type, currentModel);
        
        // Record successful request with actual token usage
        rateLimiter.recordRequest(tokenEstimate.total);
        circuitBreaker.recordSuccess();
        batchSizer.recordSuccess();
        modelSelector.resetErrorCounter();
        console.log('🔎 Raw model response length:', responseText?.length || 0);
        console.log('🔎 Raw model response preview (first 2000 chars):', responseText ? responseText.slice(0, 2000) : '');

        // Check if the AI response indicates the topic is not present in the PDF
        const responseTextLower = (responseText || '').toLowerCase();
        const topicNotFoundPatterns = [
          'does not contain any information about',
          'does not contain information about',
          'doesn\'t contain any information about',
          'doesn\'t contain information about',
          'no information about',
          'not found in the document',
          'not present in the document',
          'document does not cover',
          'pdf does not contain',
          'pdf doesn\'t contain',
          'lacks sufficient information',
          'insufficient information about',
          'cannot find information about',
          'unable to find information about'
        ];
        
        const topicNotFound = topicNotFoundPatterns.some(pattern => responseTextLower.includes(pattern));
        
        if (topicNotFound && usedPdfReference) {
          // Extract the topic/chapter name from the response if possible
          const topicName = chapters || topic || 'the specified topic/chapters';
          
          console.error(`❌ Topic not found in PDF: ${topicName}`);
          
          // Return error immediately - don't try to parse or continue
          return res.status(400).json({
            success: false,
            message: `The selected PDF does not contain sufficient information about "${topicName}" for ${subQuestion.question_type === 'mcq' ? 'this class level' : 'the specified class level'}. Please either:\n1. Upload a different PDF that covers this topic\n2. Select a different topic/chapter that exists in the current PDF\n3. Generate questions without PDF context`,
            error: 'topic_not_in_pdf',
            topicRequested: topicName,
            pdfUsed: pdfFilename || 'Unknown PDF',
            aiResponse: responseText.substring(0, 500), // Include first 500 chars for debugging
            canProceedWithoutPdf: true
          });
        }

        // Parse the response robustly - pass sub-question difficulty to force same difficulty for all variations
        let parsedVariations = parseBatchResponse_Robust(responseText, currentStart, subQuestionDifficulty);

        if (!Array.isArray(parsedVariations) || parsedVariations.length === 0) {
          // If parsing failed and we're using PDF context, check if it's a topic mismatch
          if (usedPdfReference) {
            const topicName = chapters || topic || 'the specified topic/chapters';
            return res.status(400).json({
              success: false,
              message: `Unable to generate questions about "${topicName}" from the selected PDF. The PDF may not contain relevant content for this topic. Please:\n1. Upload a different PDF that covers this topic\n2. Select a different topic/chapter\n3. Generate questions without PDF context`,
              error: 'parsing_failed_pdf_mismatch',
              topicRequested: topicName,
              pdfUsed: pdfFilename || 'Unknown PDF',
              canProceedWithoutPdf: true
            });
          }
          throw new Error('No valid variations parsed from response');
        }

        // Save parsed variations in bulk
        const savedVariations = await saveVariationsBatch(parsedVariations, {
          subQuestion,
          userId,
          subjectId,
          fileId: effectiveFileId,
          pdfFilename
        });

        // Push saved results to accumulator
        allSavedVariations.push(...savedVariations);

        // Adjust counters
        const generatedCount = parsedVariations.length;
        remaining -= generatedCount;
        currentStart += generatedCount;
        batchesProcessed++;

        console.log(`✅ Batch ${batchNumber}/${totalBatches} saved: ${generatedCount} variations. Total: ${allSavedVariations.length}/${num_variations}. Remaining: ${remaining}`);

        console.log(`✅ Batch ${batchNumber} complete: ${generatedCount} variations. Total: ${allSavedVariations.length}/${num_variations}`);
        
        // Inter-batch delay to prevent rate limiting (skip on last batch)
        if (remaining > 0) {
          // Adaptive delays: 25s for PDF context (File Search overhead), 10s for regular generation
          const interBatchDelay = usedPdfReference ? 15000 : 10000;
          console.log(`⏸️  Inter-batch delay: ${(interBatchDelay/1000).toFixed(1)}s ${usedPdfReference ? '(PDF context)' : '(regular)'}`);
          await new Promise(resolve => setTimeout(resolve, interBatchDelay));
        }

      } catch (err) {
        // Capture error and handle based on type
        generationError = err;
        
        console.error('❌ Batch error:', err.message);
        console.error('Error details:', { message: err.message, status: err.response?.status, statusText: err.response?.statusText, code: err.code });

        // Handle 503 errors specially - switch models
        if (err.response?.status === 503 || err.message?.includes('503') || err.message?.includes('overload')) {
          console.log('🔄 Detected model overload (503), attempting to switch models...');
          
          try {
            const switchResult = await modelSelector.handleOverloadAndSwitch();
            currentModel = switchResult.newModel;
            
            console.log(`✅ Switched to model: ${currentModel}`);
            
            // Reduce batch size by 50% if we've had 2+ consecutive overload errors
            if (switchResult.shouldReduceBatchSize) {
              const oldSize = batchSizer.getCurrentBatchSize();
              const newSize = Math.max(10, Math.floor(oldSize * 0.5));
              batchSizer.currentBatchSize = newSize;
              console.log(`📉 Reduced batch size: ${oldSize} → ${newSize} (${switchResult.consecutiveErrors} consecutive overload errors)`);
            }
            
            // Wait before retry with new model
            console.log('⏳ Waiting 10s before retry with new model...');
            await new Promise(resolve => setTimeout(resolve, 10000));
            
            // Continue to next iteration to retry with new model
            continue;
          } catch (switchError) {
            console.error('❌ Failed to switch models:', switchError.message);
            circuitBreaker.recordFailure(err);
          }
        } else if (err.response?.status === 429) {
          // Rate limit error - wait longer
          circuitBreaker.recordFailure(err);
          console.log('⏳ Waiting 30s after 429 rate limit error...');
          await new Promise(resolve => setTimeout(resolve, 30000));
        } else {
          circuitBreaker.recordFailure(err);
        }

        // If we have some saved variations, return partial result
        if (allSavedVariations.length > 0) {
          console.log(`⚠️ Returning partial results: ${allSavedVariations.length} variations saved before error.`);
          break;
        } else {
          // No partial work; propagate error
          throw err;
        }
      }
    } // end while

    // Compute final metadata
    const totalGenerated = allSavedVariations.length;
    
    // Calculate total variations generated so far (including previous batches)
    const totalGeneratedSoFar = effectiveStartingVariation - 1 + totalGenerated;
    
    // has_more is always false now since we generate all in one request
    // (unless there was an error and we have partial results)
    const hasMore = totalGeneratedSoFar < num_variations;
    
    // Next starting number (only relevant if there was an error)
    const nextStartingNumber = effectiveStartingVariation + totalGenerated;

    const isPartialSuccess = Boolean(generationError && allSavedVariations.length > 0);

    const responseMessage = isPartialSuccess
      ? `Partial success: Generated ${totalGenerated} of ${num_variations} requested variations${usedPdfReference ? ' using PDF reference' : ''}`
      : `Generated ${totalGenerated} variations${usedPdfReference ? ' using PDF reference' : ''}`;

    // Get final rate limit and model statistics
    const finalStats = rateLimiter.getUsageStats();
    const modelStats = modelSelector.getStats();
    
    // Calculate total generation time
    const totalTimeMs = Date.now() - generationStartTime;

    res.status(isPartialSuccess ? 206 : 201).json({
      success: true,
      partial: isPartialSuccess,
      message: responseMessage,
      sub_question_id,
      full_question_number: subQuestion.full_question_number,
      variations: allSavedVariations,
      usedPdfReference,
      has_more: hasMore,
      next_starting_number: nextStartingNumber,
      generation_stats: {
        total_requested: num_variations,
        total_generated: totalGenerated,
        batches_processed: batchesProcessed,
        warmup_time_ms: WARMUP_TIME_MS,
        total_time_ms: totalTimeMs
      },
      stats: finalStats,
      modelInfo: {
        model: modelStats.currentModel,
        overloadedModels: modelStats.overloadedModels
      },
      ...(fileSearchWarning && { fileSearchWarning }),
      ...(isPartialSuccess && {
        warning: 'Some variations could not be generated due to errors',
        error_details: generationError.message || String(generationError)
      })
    });

  } catch (err) {
    console.error('Generate variations error (fatal):', err);
    res.status(500).json({ success: false, message: 'Failed to generate variations', error: err.message || String(err) });
  }
});
    

// Validate PDF topic relevance
router.post('/validate-pdf-topic', authMiddleware, requireRole('examiner'), upload.single('pdf'), async (req, res) => {
  try {
    const { topic, subject, chapters } = req.body;
    const userId = req.user.user_id;
    
    console.log(`🔍 PDF validation request from user ${userId} for topic: "${topic}"`);
    
    // Validate required fields
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        message: 'No PDF file uploaded',
        canProceed: false
      });
    }
    
    if (!topic || !topic.trim()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Topic is required',
        canProceed: false
      });
    }
    
    if (!subject || !subject.trim()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Subject is required',
        canProceed: false
      });
    }
    
    // Validate file size (already handled by multer, but double-check)
    if (req.file.size > 50 * 1024 * 1024) {
      return res.status(400).json({ 
        success: false, 
        message: 'File exceeds 10MB limit',
        canProceed: false
      });
    }
    
    try {
      // Validate topic in PDF with timeout
      const validationPromise = validateTopicInPDF(
        req.file.buffer, 
        topic, 
        subject, 
        chapters || ''
      );
      
      // Add timeout wrapper
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Validation timeout')), 30000);
      });
      
      const validationResult = await Promise.race([validationPromise, timeoutPromise]);
      
      // Store PDF temporarily if validation succeeded
      let tempFileId = null;
      if (validationResult.isRelevant) {
        tempFileId = await storeTempPDF(req.file.buffer, {
          fileName: req.file.originalname,
          fileSize: req.file.size,
          pages: validationResult.pages,
          uploadedBy: userId,
          topic,
          subject
        });
      }
      
      console.log(`✅ Validation complete: score=${validationResult.relevanceScore}, isRelevant=${validationResult.isRelevant}`);
      
      // Build response
      const response = {
        success: true,
        relevanceScore: validationResult.relevanceScore,
        isRelevant: validationResult.isRelevant,
        message: validationResult.isRelevant 
          ? `PDF content is relevant to "${topic}" (score: ${validationResult.relevanceScore}/100)`
          : `PDF content has low relevance to "${topic}" (score: ${validationResult.relevanceScore}/100). Questions will be generated without PDF reference.`,
        pdfContext: {
          fileName: req.file.originalname,
          fileSize: req.file.size,
          pages: validationResult.pages,
          tempFileId
        },
        relevantExcerpts: validationResult.excerpts || [],
        reasoning: validationResult.reasoning,
        keyTermsFound: validationResult.keyTermsFound || []
      };
      
      res.json(response);
      
    } catch (validationError) {
      console.error('PDF validation error:', validationError);
      
      // Handle specific error types
      if (validationError.message === 'Validation timeout') {
        return res.status(500).json({
          success: false,
          message: 'Validation timeout. You can proceed without PDF reference.',
          canProceed: true,
          error: 'timeout'
        });
      }
      
      if (validationError.message.includes('No text content')) {
        return res.status(500).json({
          success: false,
          message: 'Failed to extract text from PDF. You can proceed without PDF reference.',
          canProceed: true,
          error: 'extraction_failed'
        });
      }
      
      // Generic error
      return res.status(500).json({
        success: false,
        message: 'Failed to process PDF. You can proceed without PDF reference.',
        canProceed: true,
        error: validationError.message
      });
    }
    
  } catch (error) {
    console.error('PDF validation endpoint error:', error);
    
    // Handle multer errors
    if (error.message === 'Only PDF files are allowed') {
      return res.status(400).json({
        success: false,
        message: 'Only PDF files are allowed',
        canProceed: false
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Server error during PDF validation',
      canProceed: true,
      error: error.message
    });
  }
});

// Upload PDF to File Search Store with deduplication
router.post('/upload-pdf', authMiddleware, requireRole('examiner'), upload.single('pdf'), async (req, res) => {
  try {
    const { subject, topic } = req.body;
    const userId = req.user.user_id;
    const subjectId = req.user.subject_id;
    console.log(`📤 PDF upload request from user ${userId} for subject: "${subject}", topic: "${topic}"`);
    
    // Validate required fields
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        message: 'No PDF file uploaded'
      });
    }
    
    if (!subject || !subject.trim()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Subject is required'
      });
    }
    
    if (!topic || !topic.trim()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Topic is required'
      });
    }
    
    // Validate file size (already handled by multer, but double-check)
    if (req.file.size > 50 * 1024 * 1024) {
      return res.status(400).json({ 
        success: false, 
        message: 'File exceeds 10MB limit'
      });
    }
    
    try {
      const fileSearchService = new FileSearchService();
      
      // Generate SHA-256 hash for deduplication
      const fileHash = fileSearchService.generateFileHash(req.file.buffer);
      console.log(`🔐 Generated file hash: ${fileHash}`);
      
      // Check if file already exists in database by hash
      const [existingFiles] = await db.query(
        `SELECT upload_id, file_id, display_name, file_size_bytes, upload_timestamp, status
         FROM file_search_uploads 
         WHERE file_hash = ? AND status = 'active'
         LIMIT 1`,
        [fileHash]
      );
      
      let fileId, uploadId, displayName, fileSizeBytes, uploadTimestamp;
      let isNewUpload = true;
      let needsReupload = false;
      
      if (existingFiles.length > 0) {
        // File already exists - reuse it
        const existingFile = existingFiles[0];
        fileId = existingFile.file_id;
        uploadId = existingFile.upload_id;
        displayName = existingFile.display_name;
        fileSizeBytes = existingFile.file_size_bytes;
        uploadTimestamp = existingFile.upload_timestamp;
        isNewUpload = false;
        
        console.log(`♻️  File already exists in database (upload_id: ${uploadId}), reusing file_id: ${fileId}`);
        
        // Verify file still exists in Gemini File Search Store
        try {
          const fileExists = await fileSearchService.fileExists(fileId);
          
          if (!fileExists) {
            console.warn(`⚠️  File ${fileId} not found in File Search Store, re-uploading...`);
            // File was deleted from Gemini but still in our DB - need to re-upload and update DB
            needsReupload = true;
          } else {
            // Update last_used_timestamp and usage_count
            await db.query(
              `UPDATE file_search_uploads 
               SET last_used_timestamp = NOW(), usage_count = usage_count + 1
               WHERE upload_id = ?`,
              [uploadId]
            );
            
            console.log(`✅ Reusing existing file, updated usage count`);
          }
        } catch (existsError) {
          console.error('Error checking file existence:', existsError);
          // If we can't verify, assume we need to re-upload
          needsReupload = true;
        }
      }
      
      if (isNewUpload || needsReupload) {
        // Upload new file to Gemini File Search Store
        displayName = `${subject}_${topic}_${req.file.originalname}`.substring(0, 255);
        console.log(`📤 Uploading new file to File Search Store: ${displayName}`);
        
        const uploadResult = await fileSearchService.uploadFile(req.file.buffer, displayName);
        fileId = uploadResult.fileId;
        fileSizeBytes = uploadResult.sizeBytes;
        
        console.log(`✅ File uploaded to File Search Store: ${fileId}`);
        
        // Wait for file to be processed
        console.log(`⏳ Waiting for file to be processed...`);
        const isActive = await fileSearchService.waitForFileProcessing(fileId, 60000);
        
        if (!isActive) {
          console.error(`❌ File processing timeout or failed`);
          return res.status(500).json({
            success: false,
            message: 'File upload succeeded but processing timeout. Please try again.',
            error: 'processing_timeout'
          });
        }
        
        console.log(`✅ File is active and ready to use`);
        
        if (needsReupload) {
          // Update existing database record with new file_id
          await db.query(
            `UPDATE file_search_uploads 
             SET file_id = ?, display_name = ?, file_size_bytes = ?, 
                 last_used_timestamp = NOW(), usage_count = usage_count + 1, status = 'active'
             WHERE upload_id = ?`,
            [fileId, displayName, fileSizeBytes, uploadId]
          );
          
          console.log(`✅ Updated existing database record (upload_id: ${uploadId}) with new file_id: ${fileId}`);
        } else {
          // Store metadata in database as new record
          const [insertResult] = await db.query(
            `INSERT INTO file_search_uploads 
             (file_id, file_hash, display_name, original_filename, file_size_bytes, mime_type, 
              uploaded_by, subject, topic, usage_count, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              fileId,
              fileHash,
              displayName,
              req.file.originalname,
              fileSizeBytes,
              req.file.mimetype,
              userId,
              subject,
              topic,
              1,
              'active'
            ]
          );
          
          uploadId = insertResult.insertId;
          uploadTimestamp = new Date();
          
          console.log(`✅ File metadata stored in database (upload_id: ${uploadId})`);
        }
      }
      
      // Return file ID and metadata to client
      res.json({
        success: true,
        message: isNewUpload ? 'PDF uploaded successfully' : 'PDF already exists, reusing existing file',
        isNewUpload,
        fileMetadata: {
          uploadId,
          fileId,
          displayName,
          originalFilename: req.file.originalname,
          fileSizeBytes,
          subject,
          topic,
          uploadTimestamp
        }
      });
      
    } catch (uploadError) {
      console.error('PDF upload error:', {
        message: uploadError.message,
        code: uploadError.code,
        statusCode: uploadError.statusCode,
        retryable: uploadError.retryable
      });
      
      // Handle specific error types with user-friendly messages
      if (uploadError.code === 'RATE_LIMIT') {
        return res.status(429).json({
          success: false,
          message: 'Rate limit exceeded. Please try again in a few moments.',
          error: 'rate_limit',
          retryable: true
        });
      }
      
      if (uploadError.code === 'TIMEOUT') {
        return res.status(408).json({
          success: false,
          message: 'Upload timeout. Please try again with a smaller file or check your connection.',
          error: 'timeout',
          retryable: true
        });
      }
      
      if (uploadError.code === 'FILE_TOO_LARGE') {
        return res.status(413).json({
          success: false,
          message: 'File is too large. Please upload a file smaller than 10MB.',
          error: 'file_too_large',
          retryable: false
        });
      }
      
      if (uploadError.code === 'AUTH_ERROR') {
        return res.status(401).json({
          success: false,
          message: 'Authentication error. Please contact support.',
          error: 'auth_error',
          retryable: false
        });
      }
      
      if (uploadError.code === 'NETWORK_ERROR') {
        return res.status(503).json({
          success: false,
          message: 'Network error. Please check your internet connection and try again.',
          error: 'network_error',
          retryable: true
        });
      }
      
      if (uploadError.code === 'SERVICE_UNAVAILABLE') {
        return res.status(503).json({
          success: false,
          message: 'File Search service is temporarily unavailable. Please try again later.',
          error: 'service_unavailable',
          retryable: true
        });
      }
      
      // Generic error
      return res.status(500).json({
        success: false,
        message: uploadError.message || 'Failed to upload PDF to File Search Store',
        error: uploadError.code || 'upload_failed',
        retryable: uploadError.retryable !== false
      });
    }
    
  } catch (error) {
    console.error('PDF upload endpoint error:', error);
    
    // Handle multer errors
    if (error.message === 'Only PDF files are allowed') {
      return res.status(400).json({
        success: false,
        message: 'Only PDF files are allowed'
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Server error during PDF upload',
      error: error.message
    });
  }
});

// Retrieve PDF content from File Search Store
router.post('/retrieve-pdf-content', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { fileId, topic, subject, chapters } = req.body;
    
    console.log(`📄 PDF content retrieval request for fileId: ${fileId}`);
    
    // Validate required fields
    if (!fileId) {
      return res.status(400).json({ 
        success: false, 
        message: 'fileId is required'
      });
    }
    
    if (!topic || !topic.trim()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Topic is required'
      });
    }
    
    if (!subject || !subject.trim()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Subject is required'
      });
    }
    
    try {
      const fileSearchService = new FileSearchService();
      
      // Verify file exists in File Search Store
      const fileMetadata = await fileSearchService.getFileMetadata(fileId);
      
      if (!fileMetadata) {
        console.error(`❌ File ${fileId} not found in File Search Store`);
        return res.status(404).json({
          success: false,
          message: 'PDF file not found. Please re-upload the PDF.',
          error: 'file_not_found'
        });
      }
      
      if (fileMetadata.state !== 'ACTIVE') {
        console.error(`❌ File ${fileId} is not active (state: ${fileMetadata.state})`);
        return res.status(400).json({
          success: false,
          message: 'PDF file is not ready. Please wait or re-upload.',
          error: 'file_not_active'
        });
      }
      
      console.log(`✅ File metadata retrieved: ${fileMetadata.name}`);
      
      // Build query to extract relevant content from PDF
      const chaptersText = chapters && chapters.trim() ? ` focusing on chapters: ${chapters}` : '';
      const query = `Extract all relevant content from this PDF document about "${topic}" in the subject "${subject}"${chaptersText}. 
      
      Provide a comprehensive summary of the key concepts, definitions, formulas, examples, and important information that would be useful for generating educational questions.
      
      Format your response as plain text with clear sections and bullet points where appropriate.`;
      
      console.log(`🔍 Querying PDF content with topic: "${topic}", subject: "${subject}"`);
      
      // Query the file to get relevant content
      const queryResult = await fileSearchService.queryFile(fileId, query);
      
      if (!queryResult || !queryResult.excerpts || queryResult.excerpts.length === 0) {
        console.warn(`⚠️ No content extracted from PDF`);
        return res.status(200).json({
          success: true,
          pdfContext: '',
          message: 'No relevant content found in PDF',
          relevanceScore: queryResult?.relevanceScore || 0
        });
      }
      
      // Combine excerpts into a single context string
      const pdfContext = queryResult.excerpts.join('\n\n');
      
      console.log(`✅ PDF content retrieved successfully (${pdfContext.length} characters)`);
      console.log(`📊 Relevance score: ${queryResult.relevanceScore}`);
      
      // Return the PDF context
      res.json({
        success: true,
        pdfContext,
        relevanceScore: queryResult.relevanceScore,
        keyTermsFound: queryResult.keyTermsFound,
        excerptCount: queryResult.excerpts.length
      });
      
    } catch (retrievalError) {
      console.error('PDF content retrieval error:', {
        message: retrievalError.message,
        code: retrievalError.code,
        statusCode: retrievalError.statusCode
      });
      
      // Handle specific error types
      if (retrievalError.code === 'RATE_LIMIT') {
        return res.status(429).json({
          success: false,
          message: 'Rate limit exceeded. Please try again in a few moments.',
          error: 'rate_limit'
        });
      }
      
      if (retrievalError.code === 'TIMEOUT') {
        return res.status(408).json({
          success: false,
          message: 'Content retrieval timeout. Please try again.',
          error: 'timeout'
        });
      }
      
      if (retrievalError.code === 'FILE_NOT_FOUND') {
        return res.status(404).json({
          success: false,
          message: 'PDF file not found. Please re-upload the PDF.',
          error: 'file_not_found'
        });
      }
      
      // Generic error
      return res.status(500).json({
        success: false,
        message: retrievalError.message || 'Failed to retrieve PDF content',
        error: retrievalError.code || 'retrieval_failed'
      });
    }
    
  } catch (error) {
    console.error('PDF content retrieval endpoint error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during PDF content retrieval',
      error: error.message
    });
  }
});

// Validate PDF topic relevance using File Search
router.post('/validate-pdf-topic-v2', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { fileId, subject, chapters } = req.body;
    
    if (!fileId || !chapters || !subject) {
      return res.status(400).json({
        success: false,
        message: 'fileId, chapters and subject are required'
      });
    }

    const fileSearchService = new FileSearchService();
    const modelSelector = getModelSelector();
    
    // Select best available model for validation
    let currentModel = null;
    try {
      currentModel = await modelSelector.selectBestModel();
      console.log(`🤖 Selected model for PDF validation: ${currentModel}`);
    } catch (modelError) {
      console.error('❌ Failed to select model:', modelError.message);
      // Default to gemini-2.0-flash-exp if selection fails
      currentModel = 'gemini-2.0-flash-exp';
      console.log(`🤖 Using default model: ${currentModel}`);
    }

    // Verify file exists first and get basic info
    const fileInfo = await fileSearchService.getFileInfo(fileId);
    if (!fileInfo) {
      return res.status(404).json({
        success: false,
        message: 'The referenced PDF file was not found in File Search Store',
        canProceedWithoutPdf: true
      });
    }

    console.log(`✅ File found in File Search Store: ${fileInfo.fileId}`);

    // Query with more specific prompt
    const query = `Subject: ${subject}
Topic: ${chapters}
Chapters: ${chapters || 'Not specified'}

Analyze the relevance of this document to the educational topic above. Consider:
1. Coverage of key concepts
2. Depth of information
3. Educational level
4. Alignment with subject matter

Provide a relevance score from 0-100 and explain your reasoning.`;

    let searchResults = null;
    let validationError = null;
    const maxRetries = 2;
    
    // Retry loop with model switching on failure
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔍 PDF validation attempt ${attempt + 1}/${maxRetries + 1} with model: ${currentModel}`);
        
        // Call queryFile with just fileId and query (it has its own timeout handling)
        // Note: queryFile doesn't accept options parameter, it uses internal retry logic
        searchResults = await fileSearchService.queryFile(fileId, query, 2);
        
        // Validate response structure
        if (!searchResults || typeof searchResults !== 'object') {
          throw new Error('Invalid response from queryFile: expected object, got ' + typeof searchResults);
        }
        
        // Success - break out of retry loop
        modelSelector.resetErrorCounter();
        console.log(`✅ Validation successful: score=${searchResults.relevanceScore || 0}`);
        break;
        
      } catch (error) {
        validationError = error;
        console.error(`❌ Validation attempt ${attempt + 1} failed:`, error.message);
        console.error('Error details:', { code: error.code, status: error.response?.status });
        
        // Handle 503 model overload - switch models
        if ((error.response?.status === 503 || error.message?.includes('503') || error.message?.includes('overload')) && attempt < maxRetries) {
          console.log('🔄 Detected model overload (503), attempting to switch models...');
          
          try {
            const switchResult = await modelSelector.handleOverloadAndSwitch();
            currentModel = switchResult.newModel;
            console.log(`✅ Switched to model: ${currentModel}`);
            
            // Wait before retry
            console.log('⏳ Waiting 10s before retry with new model...');
            await new Promise(resolve => setTimeout(resolve, 10000));
            continue;
          } catch (switchError) {
            console.error('❌ Failed to switch models:', switchError.message);
          }
        }
        
        // Handle timeout - retry with longer timeout
        if ((error.code === 'TIMEOUT' || error.code === 'ECONNABORTED' || error.message?.includes('timeout')) && attempt < maxRetries) {
          console.log('⏳ Timeout detected, waiting 5s before retry...');
          await new Promise(resolve => setTimeout(resolve, 5000));
          continue;
        }
        
        // Last attempt failed
        if (attempt === maxRetries) {
          throw error;
        }
      }
    }
    
    if (!searchResults) {
      throw validationError || new Error('Validation failed after all retries');
    }
    
    // Calculate relevance score (0-100)
    const relevanceScore = Math.min(100, Math.max(0, searchResults.relevanceScore || 0));
    const isRelevant = relevanceScore >= 30; // 30% threshold
    
    console.log(`📊 Validation result: score=${relevanceScore}, isRelevant=${isRelevant}, model=${currentModel}`);
    
    res.json({
      success: true,
      validation: {
        isRelevant,
        relevanceScore,
        keyTermsFound: searchResults.keyTermsFound || [],
        reasoning: searchResults.reasoning || 'No reasoning provided',
        fileId: fileInfo.fileId,
        modelUsed: currentModel
      }
    });

  } catch (error) {
    console.error('PDF validation error:', {
      message: error.message,
      code: error.code,
      statusCode: error.statusCode
    });
    
    // Handle specific File Search errors
    if (error.code === 'FILE_NOT_FOUND') {
      return res.status(404).json({
        success: false,
        message: 'PDF file not found in File Search Store',
        canProceedWithoutPdf: true
      });
    }
    
    if (error.code === 'RATE_LIMIT') {
      return res.status(429).json({
        success: false,
        message: 'Rate limit exceeded. Please try again in a moment.',
        canProceedWithoutPdf: true
      });
    }
    
    if (error.code === 'TIMEOUT' || error.message?.includes('timeout')) {
      return res.status(408).json({
        success: false,
        message: 'Validation timeout after 90 seconds. You can proceed without PDF reference.',
        canProceedWithoutPdf: true
      });
    }
    
    // Generic error
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to validate PDF topic',
      error: error.message,
      canProceedWithoutPdf: true
    });
  }
});

// Get all sub-questions for a main question
router.get('/questions/:question_id/sub-questions', authMiddleware, async (req, res) => {
  try {
    const { question_id } = req.params;

    const [subQuestions] = await db.query(
      `SELECT sq.*, 
       (SELECT COUNT(*) FROM question_variations WHERE sub_question_id = sq.sub_question_id) as variation_count
       FROM sub_questions sq
       WHERE sq.parent_question_id = ?
       ORDER BY sq.sub_question_number`,
      [question_id]
    );

    res.json({ success: true, sub_questions: subQuestions });
  } catch (err) {
    console.error('Get sub-questions error:', err);
    res.status(500).json({ success: false, message: 'Failed to get sub-questions' });
  }
});

// Get all variations for a sub-question (with pagination)
router.get('/sub-questions/:sub_question_id/variations', authMiddleware, async (req, res) => {
  try {
    const { sub_question_id } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    // Get total count
    const [countResult] = await db.query(
      `SELECT COUNT(*) as total FROM question_variations WHERE sub_question_id = ?`,
      [sub_question_id]
    );
    const total = countResult[0].total;

    // Get paginated variations
    const [variations] = await db.query(
      `SELECT v.*, u.name as created_by_name, sq.full_question_number
       FROM question_variations v
       LEFT JOIN users u ON v.created_by = u.user_id
       LEFT JOIN sub_questions sq ON v.sub_question_id = sq.sub_question_id
       WHERE v.sub_question_id = ?
       ORDER BY v.variation_number
       LIMIT ? OFFSET ?`,
      [sub_question_id, limit, offset]
    );

    // Parse options if they're strings
    variations.forEach(v => {
      if (v.options && typeof v.options === 'string') {
        try {
          v.options = JSON.parse(v.options);
        } catch (e) {
          v.options = null;
        }
      }
    });

    res.json({ 
      success: true, 
      variations,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: offset + variations.length < total
      }
    });
  } catch (err) {
    console.error('Get variations error:', err);
    res.status(500).json({ success: false, message: 'Failed to get variations' });
  }
});

// Moderator: Get paginated variations for a sub-question (only variations sent to moderator)
router.get('/moderator/sub-questions/:sub_question_id/variations', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { sub_question_id } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    // Moderator can only see variations with these statuses (sent by SME)
    const moderatorVisibleStatuses = ['sent_to_moderator', 'selected_by_sme', 'approved', 'rejected'];

    // Get total count of moderator-visible variations only
    const [countResult] = await db.query(
      `SELECT COUNT(*) as total FROM question_variations 
       WHERE sub_question_id = ? AND status IN (?)`,
      [sub_question_id, moderatorVisibleStatuses]
    );
    const total = countResult[0].total;

    // Get paginated variations (only moderator-visible ones)
    const [variations] = await db.query(
      `SELECT v.*, u.name as created_by_name, sq.full_question_number
       FROM question_variations v
       LEFT JOIN users u ON v.created_by = u.user_id
       LEFT JOIN sub_questions sq ON v.sub_question_id = sq.sub_question_id
       WHERE v.sub_question_id = ? AND v.status IN (?)
       ORDER BY v.variation_number
       LIMIT ? OFFSET ?`,
      [sub_question_id, moderatorVisibleStatuses, limit, offset]
    );

    // Parse options if they're strings
    variations.forEach(v => {
      if (v.options && typeof v.options === 'string') {
        try {
          v.options = JSON.parse(v.options);
        } catch (e) {
          v.options = null;
        }
      }
    });

    res.json({ 
      success: true, 
      variations,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: offset + variations.length < total
      }
    });
  } catch (err) {
    console.error('Get moderator variations error:', err);
    res.status(500).json({ success: false, message: 'Failed to get variations' });
  }
});

// SME: Get paginated variations for a sub-question (only variations visible to SME)
router.get('/sme/sub-questions/:sub_question_id/variations', authMiddleware, requireRole('subject_matter_expert'), async (req, res) => {
  try {
    const { sub_question_id } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    // SME can only see variations with these statuses
    const smeVisibleStatuses = ['sent_to_sme', 'selected_by_sme', 'unselected_by_sme', 'sent_to_moderator', 'approved', 'rejected'];

    // Get total count of SME-visible variations only
    const [countResult] = await db.query(
      `SELECT COUNT(*) as total FROM question_variations 
       WHERE sub_question_id = ? AND status IN (?)`,
      [sub_question_id, smeVisibleStatuses]
    );
    const total = countResult[0].total;

    // Get paginated variations (only SME-visible ones)
    const [variations] = await db.query(
      `SELECT v.*, u.name as created_by_name, sq.full_question_number
       FROM question_variations v
       LEFT JOIN users u ON v.created_by = u.user_id
       LEFT JOIN sub_questions sq ON v.sub_question_id = sq.sub_question_id
       WHERE v.sub_question_id = ? AND v.status IN (?)
       ORDER BY v.variation_number
       LIMIT ? OFFSET ?`,
      [sub_question_id, smeVisibleStatuses, limit, offset]
    );

    // Parse options if they're strings
    variations.forEach(v => {
      if (v.options && typeof v.options === 'string') {
        try {
          v.options = JSON.parse(v.options);
        } catch (e) {
          v.options = null;
        }
      }
    });

    res.json({ 
      success: true, 
      variations,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: offset + variations.length < total
      }
    });
  } catch (err) {
    console.error('Get SME variations error:', err);
    res.status(500).json({ success: false, message: 'Failed to get variations' });
  }
});

// Send variations to SME
router.post('/variations/send-to-sme', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { variation_ids, sme_id } = req.body;
    const examinerId = req.user.user_id;
    if (!variation_ids || !Array.isArray(variation_ids) || variation_ids.length === 0) {
      return res.status(400).json({ success: false, message: 'No variations selected' });
    }

    // Check if this is the first time sending variations for this sub-question
    // Get the sub_question_id from the first variation
    const [firstVariation] = await db.query(
      'SELECT sub_question_id FROM question_variations WHERE variation_id = ?',
      [variation_ids[0]]
    );

    if (firstVariation && firstVariation.length > 0) {
      const subQuestionId = firstVariation[0].sub_question_id;

      // Count how many variations have already been sent to SME for this sub-question
      const [alreadySent] = await db.query(
        `SELECT COUNT(*) as count FROM question_variations 
         WHERE sub_question_id = ? 
         AND status IN ('sent_to_sme', 'examiner_approved', 'sme_approved', 'moderator_approved')`,
        [subQuestionId]
      );

      const alreadySentCount = alreadySent[0].count;

      // Validate: First time must send more than 3, after that any number is allowed
      if (alreadySentCount === 0 && variation_ids.length <= 3) {
        return res.status(400).json({
          success: false,
          message: 'First submission requires more than 3 variations (minimum 4)'
        });
      }
    }

    let assignedSmeId = sme_id;

    // If no SME specified, auto-assign to subject SME
    if (!assignedSmeId) {
      // Get examiner's subject
      const [examinerData] = await db.query(
        'SELECT subject_id FROM users WHERE user_id = ?',
        [examinerId]
      );

      if (!examinerData || examinerData.length === 0 || !examinerData[0].subject_id) {
        return res.status(400).json({
          success: false,
          message: 'No subject assigned to your account. Please contact administrator.'
        });
      }

      const subjectId = examinerData[0].subject_id;

      // Find SME in the same subject
      const [smes] = await db.query(
        `SELECT user_id FROM users 
         WHERE role = 'subject_matter_expert' 
         AND subject_id = ?
         AND status = 'active'
         LIMIT 1`,
        [subjectId]
      );

      if (!smes || smes.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No SME found for your subject. Please contact administrator.'
        });
      }

      assignedSmeId = smes[0].user_id;
      console.log(`✅ Auto-assigned to subject SME: ${assignedSmeId}`);
    }

    // Get paper_id from first variation
    const [firstVar] = await db.query(
      'SELECT paper_id FROM question_variations WHERE variation_id = ?',
      [variation_ids[0]]
    );
    const paperId = firstVar[0]?.paper_id;

    // Change variation status to 'sent_to_sme' when examiner sends them
    // Update all selected variations to 'sent_to_sme' status
    await db.query(
      `UPDATE question_variations 
       SET status = 'sent_to_sme' 
       WHERE variation_id IN (?)`,
      [variation_ids]
    );

    // DO NOT update paper status here - paper status should only change when examiner clicks "Confirm All"
    // The paper remains in 'draft' status until examiner confirms all variations

    // Create review records
    let reviewsCreated = 0;
    let reviewsAlreadyExist = 0;
    for (const variationId of variation_ids) {
      try {
        // Check if review already exists
        const [existing] = await db.query(
          `SELECT review_id FROM sme_variation_reviews 
           WHERE variation_id = ? AND sme_id = ?`,
          [variationId, assignedSmeId]
        );

        if (existing.length === 0) {
          const [result] = await db.query(
            `INSERT INTO sme_variation_reviews (variation_id, sme_id, examiner_id, status) 
             VALUES (?, ?, ?, 'pending')`,
            [variationId, assignedSmeId, examinerId]
          );
          reviewsCreated++;
          console.log(`  ✅ Created review record ${result.insertId} for variation ${variationId}`);
        } else {
          reviewsAlreadyExist++;
          console.log(`  ℹ️ Review record already exists for variation ${variationId}`);
        }
      } catch (insertErr) {
        console.error(`❌ Failed to create review for variation ${variationId}:`, insertErr.message);
        console.error('Full error:', insertErr);
      }
    }

    console.log(`📊 Review records summary: ${reviewsCreated} created, ${reviewsAlreadyExist} already existed`);

    console.log(`✅ Sent ${variation_ids.length} variations to SME ${assignedSmeId}, created ${reviewsCreated} review records (status changed to sent_to_sme)`);

    res.json({
      success: true,
      message: `Sent ${variation_ids.length} variations to your department SME for review`
    });

  } catch (err) {
    console.error('Send to SME error:', err);
    res.status(500).json({ success: false, message: 'Failed to send variations to SME', error: err.message });
  }
});

// SME: Get papers with pending reviews
router.get('/sme/papers-with-reviews', authMiddleware, requireRole('subject_matter_expert'), async (req, res) => {
  try {
    const smeId = req.user.user_id;

    console.log(`📋 SME ${smeId} fetching papers with reviews...`);

    // Get SME's subject
    const [smeData] = await db.query(
      'SELECT subject_id FROM users WHERE user_id = ?',
      [smeId]
    );

    if (!smeData || smeData.length === 0 || !smeData[0].subject_id) {
      return res.status(400).json({ 
        success: false, 
        message: 'No subject assigned to your account. Please contact administrator.' 
      });
    }

    const subjectId = smeData[0].subject_id;
    console.log(`📚 SME subject_id: ${subjectId}`);

    // First check if there are any review records for this SME
    const [reviewCheck] = await db.query(
      `SELECT COUNT(*) as count FROM sme_variation_reviews WHERE sme_id = ?`,
      [smeId]
    );
    console.log(`📊 Total review records for SME ${smeId}:`, reviewCheck[0].count);

    // Check variations with sent_to_sme status
    const [variationCheck] = await db.query(
      `SELECT COUNT(*) as count FROM question_variations WHERE status = 'sent_to_sme'`
    );
    console.log(`📤 Total variations with sent_to_sme status:`, variationCheck[0].count);

    // Get papers that have variations sent to this SME (subject-based filtering)
    // Join with sme_variation_reviews to only show papers assigned to this SME
    const [papers] = await db.query(
      `SELECT DISTINCT qp.paper_id, qp.paper_title, qp.status, qp.created_at, u.name as examiner_name, s.subject_name,
              (SELECT COUNT(*) FROM sme_variation_reviews svr
               INNER JOIN question_variations qv ON svr.variation_id = qv.variation_id
               WHERE qv.paper_id = qp.paper_id AND svr.sme_id = ? AND svr.status = 'pending') as pending_reviews,
              (SELECT COUNT(*) FROM sme_variation_reviews svr
               INNER JOIN question_variations qv ON svr.variation_id = qv.variation_id
               WHERE qv.paper_id = qp.paper_id AND svr.sme_id = ? AND svr.status = 'selected') as selected_count
       FROM question_papers qp
       JOIN users u ON qp.generated_by = u.user_id
       LEFT JOIN subjects s ON u.subject_id = s.subject_id
       JOIN question_variations qv ON qv.paper_id = qp.paper_id
       JOIN sme_variation_reviews svr ON svr.variation_id = qv.variation_id
       WHERE u.subject_id = ? 
         AND svr.sme_id = ?
       GROUP BY qp.paper_id
       ORDER BY 
         CASE 
           WHEN qp.status = 'confirmed_by_examiner' THEN 1
           WHEN qp.status = 'draft' THEN 2
           WHEN qp.status = 'pending_moderator' THEN 3
           ELSE 4
         END,
         qp.created_at DESC`,
      [smeId, smeId, subjectId, smeId]
    );

    console.log(`✅ Found ${papers.length} papers for SME ${smeId} in subject ${subjectId}`);
    if (papers.length > 0) {
      console.log('First paper:', papers[0]);
    }

    res.json({ success: true, papers });
  } catch (err) {
    console.error('Get SME papers error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch papers' });
  }
});

// SME: Get paper details with only variations sent to them
router.get('/sme/paper/:paperId/details', authMiddleware, requireRole('subject_matter_expert'), async (req, res) => {
  try {
    const { paperId } = req.params;
    const smeId = req.user.user_id;

    console.log(`📄 SME ${smeId} fetching paper ${paperId} details...`);

    // Get SME's subject
    const [smeData] = await db.query(
      'SELECT subject_id FROM users WHERE user_id = ?',
      [smeId]
    );

    if (!smeData || smeData.length === 0 || !smeData[0].subject_id) {
      return res.status(400).json({ 
        success: false, 
        message: 'No subject assigned to your account. Please contact administrator.' 
      });
    }

    const subjectId = smeData[0].subject_id;

    // Get paper (subject-based filtering)
    const [papers] = await db.query(
      `SELECT qp.*, u.name as generated_by_name, s.subject_name
       FROM question_papers qp
       JOIN users u ON qp.generated_by = u.user_id
       LEFT JOIN subjects s ON u.subject_id = s.subject_id
       WHERE qp.paper_id = ? AND u.subject_id = ?`,
      [paperId, subjectId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found or not in your subject' });
    }

    const paper = papers[0];
    console.log(`📋 Paper found: ${paper.paper_title}, status: ${paper.status}`);

    // Get all main questions for this paper
    let [questions] = await db.query(
      `SELECT q.* 
       FROM questions q
       JOIN paper_questions pq ON q.question_id = pq.question_id
       WHERE pq.paper_id = ?
       ORDER BY pq.question_order`,
      [paperId]
    );

    console.log(`📝 Found ${questions.length} main questions`);

    // Fallback: If no questions found via paper_questions, try to find questions directly linked to paper via sub_questions
    if (questions.length === 0) {
      console.log(`⚠️ No questions in paper_questions table. Checking sub_questions table...`);
      
      [questions] = await db.query(
        `SELECT DISTINCT q.* 
         FROM questions q
         INNER JOIN sub_questions sq ON q.question_id = sq.parent_question_id
         WHERE sq.paper_id = ?
         ORDER BY q.question_id`,
        [paperId]
      );
      
      console.log(`📋 Found ${questions.length} questions via sub_questions table`);
    }

    // For each question, get its sub-questions and ONLY variations sent to this SME
    for (let question of questions) {
      // Get sub-questions
      const [subQuestions] = await db.query(
        `SELECT * FROM sub_questions 
         WHERE parent_question_id = ?
         ORDER BY sub_question_number`,
        [question.question_id]
      );

      console.log(`  Question ${question.question_id}: ${subQuestions.length} sub-questions`);

      // For each sub-question, get variations sent to this SME
      for (let subQuestion of subQuestions) {
        // First, try to get variations through review records (proper method)
        let [variations] = await db.query(
          `SELECT qv.* 
           FROM question_variations qv
           INNER JOIN sme_variation_reviews svr ON qv.variation_id = svr.variation_id
           WHERE qv.sub_question_id = ? AND svr.sme_id = ?
           ORDER BY qv.variation_number`,
          [subQuestion.sub_question_id, smeId]
        );

        // If no variations found through review records, check if there are variations with sent_to_sme status
        // This is a fallback for cases where review records might not have been created
        if (variations.length === 0) {
          console.log(`    ⚠️ No review records found for sub-question ${subQuestion.sub_question_id}, checking by status...`);
          [variations] = await db.query(
            `SELECT qv.* 
             FROM question_variations qv
             WHERE qv.sub_question_id = ? 
             AND qv.status IN ('sent_to_sme', 'selected_by_sme', 'unselected_by_sme', 'sent_to_moderator')
             ORDER BY qv.variation_number`,
            [subQuestion.sub_question_id]
          );

          if (variations.length > 0) {
            console.log(`    ✅ Found ${variations.length} variations by status (review records missing!)`);
          }
        }

        console.log(`    Sub-question ${subQuestion.sub_question_id}: ${variations.length} variations`);

        // Parse options if they're strings
        variations.forEach(v => {
          if (v.options && typeof v.options === 'string') {
            try {
              v.options = JSON.parse(v.options);
            } catch (e) {
              v.options = null;
            }
          }
        });

        subQuestion.variations = variations;
        subQuestion.variation_count = variations.length;
      }

      // Only include sub-questions that have variations sent to this SME
      question.sub_questions = subQuestions.filter(sq => sq.variation_count > 0);
      question.sub_question_count = question.sub_questions.length;
      console.log(`  Question ${question.question_id}: ${question.sub_question_count} sub-questions with variations`);
    }

    // Only include questions that have sub-questions with variations
    paper.questions = questions.filter(q => q.sub_question_count > 0);
    console.log(`✅ Final result: ${paper.questions.length} questions with variations for SME`);

    res.json({
      success: true,
      paper
    });
  } catch (err) {
    console.error('Get SME paper details error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// SME: Get pending variation reviews
router.get('/sme/pending-reviews', authMiddleware, requireRole('subject_matter_expert'), async (req, res) => {
  try {
    const smeId = req.user.user_id;
    console.log(`📋 SME ${smeId} fetching pending reviews...`);

    // First, check if there are ANY reviews for this SME
    const [allReviews] = await db.query(
      `SELECT COUNT(*) as total, 
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_count
       FROM sme_variation_reviews 
       WHERE sme_id = ?`,
      [smeId]
    );
    console.log(`📊 Total reviews for SME ${smeId}:`, allReviews[0]);

    // Check if there are variations with sent_to_sme status
    const [sentVariations] = await db.query(
      `SELECT COUNT(*) as count FROM question_variations WHERE status = 'sent_to_sme'`
    );
    console.log(`📤 Total variations with 'sent_to_sme' status:`, sentVariations[0].count);

    const [reviews] = await db.query(
      `SELECT r.review_id, r.variation_id, r.sme_id, r.examiner_id, r.status as review_status,
              v.variation_number, v.question_text, v.question_type, v.options, v.correct_answer, 
              v.marks, v.difficulty, v.status as variation_status,
              sq.full_question_number, sq.sub_question_id,
              q.question_text as parent_question, q.question_id,
              u.name as examiner_name
       FROM sme_variation_reviews r
       JOIN question_variations v ON r.variation_id = v.variation_id
       JOIN sub_questions sq ON v.sub_question_id = sq.sub_question_id
       JOIN questions q ON sq.parent_question_id = q.question_id
       JOIN users u ON r.examiner_id = u.user_id
       WHERE r.sme_id = ? AND r.status = 'pending'
       ORDER BY r.created_at DESC`,
      [smeId]
    );

    console.log(`✅ Found ${reviews.length} pending reviews for SME ${smeId}`);
    if (reviews.length > 0) {
      console.log('First review:', {
        review_id: reviews[0].review_id,
        variation_id: reviews[0].variation_id,
        full_question_number: reviews[0].full_question_number,
        examiner_name: reviews[0].examiner_name,
        review_status: reviews[0].review_status,
        variation_status: reviews[0].variation_status
      });
    } else {
      console.log('⚠️ No pending reviews found. Checking for any reviews...');
      const [anyReviews] = await db.query(
        `SELECT r.*, v.status as variation_status 
         FROM sme_variation_reviews r
         LEFT JOIN question_variations v ON r.variation_id = v.variation_id
         WHERE r.sme_id = ? 
         LIMIT 5`,
        [smeId]
      );
      console.log(`Found ${anyReviews.length} reviews (any status):`, anyReviews);
    }

    res.json({ success: true, reviews });
  } catch (err) {
    console.error('Get pending reviews error:', err);
    res.status(500).json({ success: false, message: 'Failed to get pending reviews' });
  }
});

// SME: Review variation (Simplified - not used in new flow)
// SME doesn't change status anymore - they just view
// Status changes happen at paper level:
// - Examiner "All Done" → examiner_approved
// - SME "Send to Moderator" → sme_approved
// - Moderator approves → moderator_approved
router.post('/variations/:variation_id/review', authMiddleware, requireRole('subject_matter_expert'), async (req, res) => {
  try {
    const { variation_id } = req.params;
    const { status, comments } = req.body;
    const smeId = req.user.user_id;

    console.log(`📝 SME ${smeId} reviewing variation ${variation_id} with status: ${status}`);

    // Get the variation
    const [variationData] = await db.query(
      `SELECT qv.*, qp.status as paper_status, qp.paper_title
       FROM question_variations qv
       JOIN question_papers qp ON qv.paper_id = qp.paper_id
       WHERE qv.variation_id = ?`,
      [variation_id]
    );

    if (variationData.length === 0) {
      return res.status(404).json({ success: false, message: 'Variation not found' });
    }

    const variation = variationData[0];

    // Update variation status if provided
    if (status) {
      // Map frontend status to backend status with TOGGLE logic
      let newStatus = variation.status; // Keep current status by default

      if (status === 'approved') {
        // TOGGLE: If already selected, unselect it. Otherwise, select it.
        if (variation.status === 'selected_by_sme') {
          newStatus = 'sent_to_sme'; // Unselect by reverting to sent_to_sme
        } else {
          newStatus = 'selected_by_sme'; // Select it
        }
      } else if (status === 'rejected') {
        // TOGGLE: If already unselected, revert to sent_to_sme. Otherwise, unselect it.
        if (variation.status === 'unselected_by_sme') {
          newStatus = 'sent_to_sme'; // Revert to pending
        } else {
          newStatus = 'unselected_by_sme'; // Unselect it
        }
      } else if (status === 'sent_to_sme') {
        // Allow reverting to sent_to_sme (for reconsider)
        newStatus = 'sent_to_sme';
      }

      // Update variation status
      await db.query(
        `UPDATE question_variations 
         SET status = ? 
         WHERE variation_id = ?`,
        [newStatus, variation_id]
      );

      console.log(`✅ Updated variation ${variation_id} status: ${variation.status} → ${newStatus}`);
    }

    // Update comments in review table
    await db.query(
      `UPDATE sme_variation_reviews 
       SET comments = ?, reviewed_at = NOW(), status = ?
       WHERE variation_id = ? AND sme_id = ?`,
      [comments || '', status === 'approved' ? 'approved' : status === 'rejected' ? 'rejected' : 'pending', variation_id, smeId]
    );

    console.log(`✅ SME ${smeId} ${status || 'commented on'} variation ${variation_id}`);

    // Get the final status after update (use newStatus if it was set, otherwise use original)
    const finalStatus = status ? (
      status === 'approved' ? (variation.status === 'selected_by_sme' ? 'sent_to_sme' : 'selected_by_sme') :
      status === 'rejected' ? (variation.status === 'unselected_by_sme' ? 'sent_to_sme' : 'unselected_by_sme') :
      status === 'sent_to_sme' ? 'sent_to_sme' :
      'sent_to_sme'
    ) : variation.status;

    const isSelected = finalStatus === 'selected_by_sme';
    const isUnselected = finalStatus === 'unselected_by_sme';

    res.json({
      success: true,
      message: isSelected ? 'Variation selected successfully' :
        isUnselected ? 'Variation unselected successfully' :
          'Comments saved successfully',
      variation: {
        variation_id: variation_id,
        status: finalStatus,
        isSelected: isSelected,
        isUnselected: isUnselected
      }
    });

  } catch (err) {
    console.error('Review variation error:', err);
    res.status(500).json({ success: false, message: 'Failed to save review' });
  }
});

// Finalize variation (make it the official question)
router.post('/variations/:variation_id/finalize', authMiddleware, async (req, res) => {
  try {
    const { variation_id } = req.params;

    // Get variation details
    const [variations] = await db.query(
      'SELECT * FROM question_variations WHERE variation_id = ?',
      [variation_id]
    );

    if (variations.length === 0) {
      return res.status(404).json({ success: false, message: 'Variation not found' });
    }

    const variation = variations[0];

    // Mark this variation as selected and finalized
    await db.query(
      `UPDATE question_variations 
       SET is_selected = TRUE, status = 'finalized' 
       WHERE variation_id = ?`,
      [variation_id]
    );

    // Unselect other variations of the same sub-question
    await db.query(
      `UPDATE question_variations 
       SET is_selected = FALSE 
       WHERE sub_question_id = ? AND variation_id != ?`,
      [variation.sub_question_id, variation_id]
    );

    console.log(`✅ Finalized variation ${variation_id}`);

    res.json({ success: true, message: 'Variation finalized successfully' });

  } catch (err) {
    console.error('Finalize variation error:', err);
    res.status(500).json({ success: false, message: 'Failed to finalize variation' });
  }
});

// Update a variation (question text, options, answer)
router.put('/variations/:variation_id', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { variation_id } = req.params;
    const { question_text, options, correct_answer } = req.body;
    const userId = req.user.user_id;
    // Verify variation belongs to examiner's paper
    const [variations] = await db.query(
      `SELECT v.*, sq.paper_id, qp.generated_by 
       FROM question_variations v
       JOIN sub_questions sq ON v.sub_question_id = sq.sub_question_id
       JOIN question_papers qp ON sq.paper_id = qp.paper_id
       WHERE v.variation_id = ? AND qp.generated_by = ?`,
      [variation_id, userId]
    );

    if (variations.length === 0) {
      return res.status(404).json({ success: false, message: 'Variation not found or unauthorized' });
    }

    const variation = variations[0];

    // Only allow editing if status is draft or rejected
    if (variation.status !== 'draft' && variation.status !== 'rejected') {
      return res.status(400).json({
        success: false,
        message: `Cannot edit variation with status: ${variation.status}`
      });
    }

    // Update variation
    await db.query(
      `UPDATE question_variations 
       SET question_text = ?, options = ?, correct_answer = ?
       WHERE variation_id = ?`,
      [
        question_text,
        options ? JSON.stringify(options) : null,
        correct_answer,
        variation_id
      ]
    );

    res.json({
      success: true,
      message: 'Variation updated successfully',
      variation: {
        variation_id,
        question_text,
        options,
        correct_answer
      }
    });
  } catch (err) {
    console.error('Update variation error:', err);
    res.status(500).json({ success: false, message: 'Failed to update variation' });
  }
});

module.exports = router;


// ==================== MODERATOR ENDPOINTS ====================

// Moderator: Get all papers sent by SME (status = 'pending') - subject-based system
router.get('/moderator/papers', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const subjectId = req.user.subject_id;
    
    const [papers] = await db.query(
      `SELECT 
        qp.paper_id,
        qp.paper_title,
        qp.subject,
        qp.topic,
        qp.status,
        qp.created_at,
        qp.updated_at,
        u_examiner.name as examiner_name,
        u_sme.name as sme_name,
        COUNT(DISTINCT q.question_id) as total_questions,
        COUNT(DISTINCT sq.sub_question_id) as total_sub_questions,
        COUNT(DISTINCT v.variation_id) as total_variations,
        SUM(CASE WHEN v.sme_status = 'approved' THEN 1 ELSE 0 END) as approved_variations
      FROM question_papers qp
      LEFT JOIN users u_examiner ON qp.created_by = u_examiner.user_id
      LEFT JOIN users u_sme ON qp.sme_id = u_sme.user_id
      LEFT JOIN questions q ON qp.paper_id = q.paper_id
      LEFT JOIN sub_questions sq ON q.question_id = sq.question_id
      LEFT JOIN sub_question_variations v ON sq.sub_question_id = v.sub_question_id
      WHERE qp.status = 'pending' AND qp.subject_id = ?
      GROUP BY qp.paper_id
      ORDER BY qp.updated_at DESC`,
      [subjectId]
    );

    res.json({ success: true, papers });
  } catch (err) {
    console.error('Get moderator papers error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Moderator: Get paper details with all questions and variations
router.get('/moderator/paper/:paperId/details', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { paperId } = req.params;
    // Get paper details
    const [papers] = await db.query(
      `SELECT 
        qp.*,
        u_examiner.name as examiner_name,
        u_examiner.email as examiner_email,
        u_sme.name as sme_name,
        u_sme.email as sme_email
      FROM question_papers qp
      LEFT JOIN users u_examiner ON qp.created_by = u_examiner.user_id
      LEFT JOIN users u_sme ON qp.sme_id = u_sme.user_id
      WHERE qp.paper_id = ?`,
      [paperId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found' });
    }

    const paper = papers[0];

    // Get all questions with sub-questions and variations
    const [questions] = await db.query(
      `SELECT 
        q.question_id,
        q.question_number,
        q.question_text,
        q.question_type,
        q.marks,
        q.options,
        q.correct_answer,
        q.created_at
      FROM questions q
      WHERE q.paper_id = ?
      ORDER BY q.question_number`,
      [paperId]
    );

    // For each question, get sub-questions and their variations
    for (let question of questions) {
      const [subQuestions] = await db.query(
        `SELECT 
          sq.sub_question_id,
          sq.sub_question_number,
          sq.full_question_number,
          sq.sub_question_text,
          sq.marks,
          sq.created_at
        FROM sub_questions sq
        WHERE sq.question_id = ?
        ORDER BY sq.sub_question_number`,
        [question.question_id]
      );

      // For each sub-question, get all variations
      for (let subQuestion of subQuestions) {
        const [variations] = await db.query(
          `SELECT 
            v.variation_id,
            v.variation_number,
            v.variation_text,
            v.options,
            v.correct_answer,
            v.marks,
            v.ai_quality_score,
            v.sme_status,
            v.sme_comments,
            v.sme_reviewed_at,
            v.created_at
          FROM sub_question_variations v
          WHERE v.sub_question_id = ?
          ORDER BY v.variation_number`,
          [subQuestion.sub_question_id]
        );

        subQuestion.variations = variations;
      }

      question.sub_questions = subQuestions;
    }

    paper.questions = questions;

    res.json({ success: true, paper });
  } catch (err) {
    console.error('Get moderator paper details error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== FILE MANAGEMENT ENDPOINTS ====================

// Get user's uploaded files
router.get('/my-uploaded-files', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const userId = req.user.user_id;
    // Get all active files uploaded by this user
    const [files] = await db.query(
      `SELECT 
        upload_id,
        file_id,
        display_name,
        original_filename,
        file_size_bytes,
        subject,
        topic,
        upload_timestamp,
        last_used_timestamp,
        usage_count,
        status
      FROM file_search_uploads
      WHERE uploaded_by = ? AND status = 'active'
      ORDER BY upload_timestamp DESC`,
      [userId]
    );

    res.json({
      success: true,
      files: files.map(file => ({
        uploadId: file.upload_id,
        fileId: file.file_id,
        displayName: file.display_name,
        originalFilename: file.original_filename,
        fileSizeBytes: file.file_size_bytes,
        subject: file.subject,
        topic: file.topic,
        uploadTimestamp: file.upload_timestamp,
        lastUsedTimestamp: file.last_used_timestamp,
        usageCount: file.usage_count,
        status: file.status
      }))
    });
  } catch (err) {
    console.error('Get uploaded files error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to retrieve uploaded files',
      error: err.message 
    });
  }
});

// Get file metadata
router.get('/uploaded-files/:fileId/metadata', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { fileId } = req.params;
    const userId = req.user.user_id;
    // Get file metadata from database
    const [files] = await db.query(
      `SELECT 
        upload_id,
        file_id,
        file_hash,
        display_name,
        original_filename,
        file_size_bytes,
        mime_type,
        uploaded_by,
        subject,
        topic,
        upload_timestamp,
        last_used_timestamp,
        usage_count,
        status
      FROM file_search_uploads
      WHERE file_id = ? AND uploaded_by = ?`,
      [fileId, userId]
    );

    if (files.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'File not found or unauthorized' 
      });
    }

    const file = files[0];

    // Optionally verify file still exists in Gemini File Search Store
    try {
      const fileSearchService = new FileSearchService();
      const geminiMetadata = await fileSearchService.getFileMetadata(fileId);
      
      if (!geminiMetadata) {
        // File doesn't exist in Gemini anymore, update database
        await db.query(
          'UPDATE file_search_uploads SET status = ? WHERE file_id = ?',
          ['error', fileId]
        );
        
        return res.status(404).json({
          success: false,
          message: 'File not found in File Search Store',
          databaseMetadata: {
            uploadId: file.upload_id,
            fileId: file.file_id,
            displayName: file.display_name,
            status: 'error'
          }
        });
      }

      // Return combined metadata
      res.json({
        success: true,
        metadata: {
          uploadId: file.upload_id,
          fileId: file.file_id,
          fileHash: file.file_hash,
          displayName: file.display_name,
          originalFilename: file.original_filename,
          fileSizeBytes: file.file_size_bytes,
          mimeType: file.mime_type,
          subject: file.subject,
          topic: file.topic,
          uploadTimestamp: file.upload_timestamp,
          lastUsedTimestamp: file.last_used_timestamp,
          usageCount: file.usage_count,
          status: file.status,
          geminiMetadata: {
            state: geminiMetadata.state,
            createTime: geminiMetadata.createTime,
            updateTime: geminiMetadata.updateTime,
            expirationTime: geminiMetadata.expirationTime,
            uri: geminiMetadata.uri
          }
        }
      });
    } catch (geminiError) {
      console.error('Error fetching Gemini metadata:', geminiError);
      
      // Return database metadata only if Gemini check fails
      res.json({
        success: true,
        metadata: {
          uploadId: file.upload_id,
          fileId: file.file_id,
          fileHash: file.file_hash,
          displayName: file.display_name,
          originalFilename: file.original_filename,
          fileSizeBytes: file.file_size_bytes,
          mimeType: file.mime_type,
          subject: file.subject,
          topic: file.topic,
          uploadTimestamp: file.upload_timestamp,
          lastUsedTimestamp: file.last_used_timestamp,
          usageCount: file.usage_count,
          status: file.status
        },
        warning: 'Could not verify file in Gemini File Search Store'
      });
    }
  } catch (err) {
    console.error('Get file metadata error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to retrieve file metadata',
      error: err.message 
    });
  }
});

// Delete file from File Search Store
router.delete('/uploaded-files/:fileId', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { fileId } = req.params;
    const userId = req.user.user_id;
    // Verify file belongs to user
    const [files] = await db.query(
      `SELECT upload_id, file_id, display_name, status 
       FROM file_search_uploads
       WHERE file_id = ? AND uploaded_by = ?`,
      [fileId, userId]
    );

    if (files.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'File not found or unauthorized' 
      });
    }

    const file = files[0];

    // Check if already deleted
    if (file.status === 'deleted') {
      return res.json({
        success: true,
        message: 'File already deleted',
        fileId: file.file_id
      });
    }

    // Delete from Gemini File Search Store
    try {
      const fileSearchService = new FileSearchService();
      await fileSearchService.deleteFile(fileId);
      console.log(`✅ Deleted file ${fileId} from Gemini File Search Store`);
    } catch (deleteError) {
      console.error('Error deleting from Gemini:', deleteError);
      
      // If file not found in Gemini (404), that's okay - continue with database update
      if (deleteError.code !== 'FILE_NOT_FOUND') {
        // For other errors, still update database but warn user
        console.warn(`⚠️ Could not delete from Gemini, but updating database status`);
      }
    }

    // Update database status to 'deleted'
    await db.query(
      'UPDATE file_search_uploads SET status = ? WHERE file_id = ?',
      ['deleted', fileId]
    );

    res.json({
      success: true,
      message: 'File deleted successfully',
      fileId: file.file_id,
      displayName: file.display_name
    });
  } catch (err) {
    console.error('Delete file error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to delete file',
      error: err.message 
    });
  }
});

module.exports = router;
