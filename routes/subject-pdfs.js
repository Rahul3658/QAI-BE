const express = require('express');
const db = require('../config/db');
const { authMiddleware, requireEduLabAdmin } = require('../middleware/auth');
const multer = require('multer');
const FileSearchService = require('../utils/fileSearchService');

const router = express.Router();
const fileSearchService = new FileSearchService();

// Configure multer for PDF uploads (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

/**
 * Upload subject-level PDF (EduLab Admin only)
 * POST /api/subject-pdfs/upload
 */
router.post('/upload', authMiddleware, requireEduLabAdmin, upload.single('pdf'), async (req, res) => {
  try {
    const { subject_name, topic, description, class_level } = req.body;
    const userId = req.user.user_id;
    
    console.log(`📤 Subject PDF upload request from EduLab Admin ${userId}`);
    console.log(`   Subject Name: ${subject_name}`);
    console.log(`   Class Level (raw): "${class_level}" (type: ${typeof class_level})`);
    console.log(`   Topic: "${topic}"`);
    console.log(`   Description: "${description}"`);
    
    // Validate required fields
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        message: 'No PDF file uploaded'
      });
    }
    
    if (!subject_name || subject_name.trim() === '') {
      return res.status(400).json({ 
        success: false, 
        message: 'Subject name is required'
      });
    }
    
    if (!class_level || class_level.trim() === '') {
      return res.status(400).json({ 
        success: false, 
        message: 'Class/Grade level is required'
      });
    }
    
    // Validate file size
    if (req.file.size > 50 * 1024 * 1024) {
      return res.status(400).json({ 
        success: false, 
        message: 'File exceeds 50MB limit'
      });
    }
    
    // Normalize subject name (trim and title case)
    const normalizedSubjectName = subject_name.trim();
    
    try {
      // Generate file hash for deduplication
      const fileHash = fileSearchService.generateFileHash(req.file.buffer);
      
      // Check for duplicate file within same subject (using subject_name + file_hash)
      const [existingFiles] = await db.query(
        `SELECT pdf_id, file_id, display_name, original_filename, subject_name, status
         FROM subject_level_pdfs 
         WHERE file_hash = ? AND subject_name = ? AND status = 'active'
         LIMIT 1`,
        [fileHash, normalizedSubjectName]
      );
      
      if (existingFiles.length > 0) {
        const existing = existingFiles[0];
        console.log(`ℹ️ Duplicate file detected: ${existing.original_filename}`);
        
        // Update usage count and return existing file
        await db.query(
          `UPDATE subject_level_pdfs 
           SET last_used_timestamp = NOW(), usage_count = usage_count + 1
           WHERE pdf_id = ?`,
          [existing.pdf_id]
        );
        
        return res.json({
          success: true,
          message: 'This PDF already exists for this subject',
          isDuplicate: true,
          fileMetadata: {
            pdf_id: existing.pdf_id,
            file_id: existing.file_id,
            filename: existing.original_filename,
            subject_name: existing.subject_name
          }
        });
      }
      
      // Upload to Gemini File Search Store
      const displayName = `${normalizedSubjectName} - ${req.file.originalname}`;
      console.log(`📤 Uploading to File Search: ${displayName}`);
      
      const uploadResult = await fileSearchService.uploadFile(req.file.buffer, displayName);
      
      console.log(`✅ File uploaded to File Search: ${uploadResult.fileId}`);
      
      // Wait for file to be processed
      const isActive = await fileSearchService.waitForFileProcessing(uploadResult.fileId, 60000);
      
      if (!isActive) {
        // Cleanup: delete from File Search
        try {
          await fileSearchService.deleteFile(uploadResult.fileId);
        } catch (cleanupError) {
          console.error('Cleanup error:', cleanupError.message);
        }
        
        return res.status(500).json({
          success: false,
          message: 'File upload succeeded but processing timed out. Please try again.'
        });
      }
      
      // Store metadata in database
      // Note: subject_id is now optional (can be NULL)
      // subject_name is the primary identifier
      // Convert empty strings to NULL for proper database storage
      const normalizedClassLevel = (class_level && class_level.trim() !== '') ? class_level.trim() : null;
      const normalizedTopic = (topic && topic.trim() !== '') ? topic.trim() : null;
      const normalizedDescription = (description && description.trim() !== '') ? description.trim() : null;
      
      console.log(`💾 Storing in database with subject_name: "${normalizedSubjectName}", class_level: "${normalizedClassLevel}"`);
      
      const [insertResult] = await db.query(
        `INSERT INTO subject_level_pdfs 
         (file_id, file_hash, display_name, original_filename, file_size_bytes, mime_type,
          subject_name, class_level, topic, description, uploaded_by, college_id, usage_count, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active')`,
        [
          uploadResult.fileId,
          fileHash,
          displayName,
          req.file.originalname,
          req.file.size,
          req.file.mimetype,
          normalizedSubjectName,
          normalizedClassLevel,
          normalizedTopic,
          normalizedDescription,
          userId,
          req.user.college_id || null  // Allow NULL for global PDFs
        ]
      );
      
      const pdfId = insertResult.insertId;
      
      console.log(`✅ Subject PDF uploaded successfully (ID: ${pdfId})`);
      console.log(`📊 Response includes subject_name: "${normalizedSubjectName}", class_level: "${normalizedClassLevel}"`);
      
      const responseData = {
        success: true,
        message: 'Subject PDF uploaded successfully',
        isNewUpload: true,
        fileMetadata: {
          pdf_id: pdfId,
          file_id: uploadResult.fileId,
          filename: req.file.originalname,
          display_name: displayName,
          file_size: req.file.size,
          subject_name: normalizedSubjectName,
          class_level: normalizedClassLevel,
          topic: normalizedTopic,
          description: normalizedDescription,
          upload_timestamp: new Date()
        }
      };
      
      console.log(`📤 Sending response:`, JSON.stringify(responseData, null, 2));
      
      res.json(responseData);
      
    } catch (uploadError) {
      console.error('Subject PDF upload error:', {
        message: uploadError.message,
        code: uploadError.code,
        statusCode: uploadError.statusCode
      });
      
      // Handle specific error types
      if (uploadError.code === 'RATE_LIMIT') {
        return res.status(429).json({
          success: false,
          message: 'Rate limit exceeded. Please try again in a few moments.',
          error: 'rate_limit'
        });
      }
      
      if (uploadError.code === 'FILE_TOO_LARGE') {
        return res.status(413).json({
          success: false,
          message: 'File is too large. Please upload a file smaller than 50MB.',
          error: 'file_too_large'
        });
      }
      
      if (uploadError.code === 'TIMEOUT') {
        return res.status(408).json({
          success: false,
          message: 'Upload timeout. Please try again with a smaller file or check your connection.',
          error: 'timeout'
        });
      }
      
      // Generic error
      return res.status(500).json({
        success: false,
        message: 'Failed to upload PDF to File Search',
        error: uploadError.message
      });
    }
    
  } catch (error) {
    console.error('Subject PDF upload endpoint error:', error);
    
    // Handle multer errors
    if (error.message === 'Only PDF files are allowed') {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Server error during subject PDF upload',
      error: error.message
    });
  }
});

/**
 * Query subject-level PDFs by subject name and topic (for variation generation)
 * GET /api/subject-pdfs/query?subject_name=X&topic=Y&class_level=Z
 */
router.get('/query', authMiddleware, async (req, res) => {
  try {
    const { subject_name, topic, class_level } = req.query;
    
    if (!subject_name || subject_name.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Subject name is required'
      });
    }
    
    const normalizedSubjectName = subject_name.trim();
    
    console.log(`🔍 Querying subject PDFs: subject="${normalizedSubjectName}", topic=${topic || 'any'}, class_level=${class_level || 'any'}`);
    
    // Query for active PDFs matching subject name, topic, and class level
    let query = `
      SELECT pdf_id, file_id, original_filename, display_name, subject_name, class_level, topic, description,
             file_size_bytes, upload_timestamp, usage_count
      FROM subject_level_pdfs
      WHERE subject_name = ? 
        AND status = 'active'
    `;
    const params = [normalizedSubjectName];
    
    // Add class_level filter if provided
    if (class_level && class_level.trim() !== '') {
      query += ` AND class_level = ?`;
      params.push(class_level.trim());
    }
    
    // Add topic filter if provided
    if (topic && topic.trim() !== '') {
      query += ` AND (topic LIKE ? OR topic IS NULL)`;
      params.push(`%${topic.trim()}%`);
    }
    
    query += ` ORDER BY usage_count DESC, upload_timestamp DESC LIMIT 5`;
    
    const [pdfs] = await db.query(query, params);
    
    console.log(`✅ Found ${pdfs.length} EduLab PDFs for subject "${normalizedSubjectName}"`);
    
    // Hide full filenames from non-EduLab users
    const isEduLabUser = req.user.department?.toLowerCase() === 'edulab';
    
    res.json({
      success: true,
      count: pdfs.length,
      pdfs: pdfs.map(pdf => ({
        pdf_id: pdf.pdf_id,
        file_id: pdf.file_id,
        filename: isEduLabUser ? pdf.original_filename : null,  // Hide filename from non-EduLab users
        display_name: pdf.display_name,
        subject_name: pdf.subject_name,
        class_level: pdf.class_level,
        topic: pdf.topic,
        description: isEduLabUser ? pdf.description : null,  // Hide description from non-EduLab users
        file_size: pdf.file_size_bytes,
        upload_date: pdf.upload_timestamp,
        usage_count: pdf.usage_count
      }))
    });
    
  } catch (error) {
    console.error('Subject PDF query error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to query subject PDFs',
      error: error.message
    });
  }
});

/**
 * List all subject-level PDFs (EduLab Admin only)
 * GET /api/subject-pdfs/list?subject_name=X&class_level=Y
 */
router.get('/list', authMiddleware, requireEduLabAdmin, async (req, res) => {
  try {
    const { subject_name, class_level } = req.query;
    
    console.log(`📋 Listing subject PDFs${subject_name ? ` for subject "${subject_name}"` : ' (all subjects)'}${class_level ? ` at class level "${class_level}"` : ''}`);
    
    let query = `
      SELECT slp.pdf_id, slp.file_id, slp.original_filename, slp.display_name,
             slp.subject_name, slp.class_level, slp.topic, slp.description,
             slp.file_size_bytes, slp.upload_timestamp, slp.last_used_timestamp,
             slp.usage_count, slp.status, u.name as uploaded_by_name
      FROM subject_level_pdfs slp
      LEFT JOIN users u ON slp.uploaded_by = u.user_id
      WHERE 1=1
    `;
    const params = [];
    
    if (subject_name && subject_name.trim() !== '') {
      query += ` AND slp.subject_name = ?`;
      params.push(subject_name.trim());
    }
    
    if (class_level && class_level.trim() !== '') {
      query += ` AND slp.class_level = ?`;
      params.push(class_level.trim());
    }
    
    query += ` ORDER BY slp.subject_name ASC, slp.class_level ASC, slp.upload_timestamp DESC`;
    
    const [pdfs] = await db.query(query, params);
    
    console.log(`✅ Found ${pdfs.length} subject PDFs`);
    
    res.json({
      success: true,
      count: pdfs.length,
      pdfs: pdfs.map(pdf => ({
        pdf_id: pdf.pdf_id,
        file_id: pdf.file_id,
        filename: pdf.original_filename,
        display_name: pdf.display_name,
        subject_name: pdf.subject_name,
        class_level: pdf.class_level,
        topic: pdf.topic,
        description: pdf.description,
        file_size: pdf.file_size_bytes,
        upload_date: pdf.upload_timestamp,
        last_used: pdf.last_used_timestamp,
        usage_count: pdf.usage_count,
        status: pdf.status,
        uploaded_by: pdf.uploaded_by_name
      }))
    });
    
  } catch (error) {
    console.error('Subject PDF list error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to list subject PDFs',
      error: error.message
    });
  }
});

/**
 * Delete subject-level PDF permanently (EduLab Admin only)
 * DELETE /api/subject-pdfs/:pdf_id
 */
router.delete('/:pdf_id', authMiddleware, requireEduLabAdmin, async (req, res) => {
  try {
    const { pdf_id } = req.params;
    const userId = req.user.user_id;
    
    console.log(`🗑️ Permanent delete request for subject PDF ${pdf_id} by EduLab Admin ${userId}`);
    
    // Get PDF details
    const [pdfs] = await db.query(
      'SELECT pdf_id, file_id, original_filename FROM subject_level_pdfs WHERE pdf_id = ?',
      [pdf_id]
    );
    
    if (pdfs.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Subject PDF not found'
      });
    }
    
    const pdf = pdfs[0];
    
    try {
      // Delete from Gemini File Search Store
      console.log(`🗑️ Deleting from File Search: ${pdf.file_id}`);
      await fileSearchService.deleteFile(pdf.file_id);
      console.log(`✅ Deleted from File Search successfully`);
    } catch (deleteError) {
      console.error('File Search deletion error:', deleteError.message);
      // Continue with database deletion even if File Search deletion fails
    }
    
    // Permanently delete from database
    await db.query(
      'DELETE FROM subject_level_pdfs WHERE pdf_id = ?',
      [pdf_id]
    );
    
    console.log(`✅ Subject PDF ${pdf_id} permanently deleted from database`);
    
    res.json({
      success: true,
      message: 'Subject PDF permanently deleted',
      pdf_id: parseInt(pdf_id),
      filename: pdf.original_filename
    });
    
  } catch (error) {
    console.error('Subject PDF delete error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete subject PDF',
      error: error.message
    });
  }
});

module.exports = router;
