// Simple PDF Upload - Extract text only, no embeddings
const express = require('express');
const multer = require('multer');
const { authMiddleware } = require('../middleware/auth');
const pdfParse = require('pdf-parse');
const crypto = require('crypto');
const db = require('../config/db');

const router = express.Router();

// Configure multer for PDF uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

// Generate file hash
function generateFileHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Upload PDF and extract text (no embeddings)
router.post('/upload', authMiddleware, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No PDF file uploaded' });
    }

    const { subject, topic, description } = req.body;
    const userId = req.user.user_id;
    const subjectId = req.user.subject_id;

    console.log(`📤 Simple PDF upload from user ${userId}`);

    // Generate file hash
    const fileHash = generateFileHash(req.file.buffer);

    // Check if file already exists (subject-based system)
    const [existing] = await db.query(
      'SELECT pdf_id, file_hash FROM uploaded_pdfs WHERE file_hash = ? AND subject_id = ?',
      [fileHash, subjectId]
    );

    if (existing.length > 0) {
      return res.status(200).json({
        success: true,
        message: 'This PDF has already been uploaded',
        pdf: existing[0],
        isDuplicate: true
      });
    }

    // Extract text from PDF
    console.log(`📄 Extracting text from ${req.file.originalname}...`);
    const pdfData = await pdfParse(req.file.buffer);
    const extractedText = pdfData.text;
    const pages = pdfData.numpages;

    console.log(`📝 Extracted ${extractedText.length} characters from ${pages} pages`);

    if (!extractedText || extractedText.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No text content found in PDF. Please ensure the PDF contains readable text.'
      });
    }

    // Store in database with extracted text (subject-based system)
    const [result] = await db.query(
      `INSERT INTO uploaded_pdfs 
       (file_name, file_hash, file_size, pages, total_chunks, extracted_text, subject, topic, description, 
        uploaded_by, subject_id, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.file.originalname,
        fileHash,
        req.file.size,
        pages,
        0, // No chunks - just storing full text
        extractedText, // Store the full extracted text
        subject || null,
        topic || null,
        description || null,
        userId,
        subjectId,
        'ready' // No processing needed, just extraction
      ]
    );

    const pdfId = result.insertId;

    console.log(`✅ PDF uploaded and text extracted successfully (ID: ${pdfId})`);

    res.json({
      success: true,
      message: 'PDF uploaded and text extracted successfully',
      pdf: {
        pdf_id: pdfId,
        file_name: req.file.originalname,
        file_hash: fileHash,
        pages: pages,
        text_length: extractedText.length,
        status: 'ready'
      }
    });
  } catch (error) {
    console.error('PDF upload error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to upload PDF'
    });
  }
});

// Get all uploaded PDFs (subject-based system)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const subjectId = req.user.subject_id;

    const [pdfs] = await db.query(
      `SELECT pdf_id, file_name, file_hash, file_size, pages, subject, topic, description, 
              uploaded_at, status, LENGTH(extracted_text) as text_length
       FROM uploaded_pdfs 
       WHERE subject_id = ?
       ORDER BY uploaded_at DESC`,
      [subjectId]
    );

    res.json({ success: true, pdfs });
  } catch (error) {
    console.error('Get PDFs error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get single PDF with extracted text (subject-based system)
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const subjectId = req.user.subject_id;

    const [pdfs] = await db.query(
      `SELECT * FROM uploaded_pdfs 
       WHERE pdf_id = ? AND subject_id = ?`,
      [id, subjectId]
    );

    if (pdfs.length === 0) {
      return res.status(404).json({ success: false, message: 'PDF not found' });
    }

    res.json({ success: true, pdf: pdfs[0] });
  } catch (error) {
    console.error('Get PDF error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Delete PDF (subject-based system)
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const subjectId = req.user.subject_id;
    const userId = req.user.user_id;

    // Get PDF details
    const [pdfs] = await db.query(
      'SELECT * FROM uploaded_pdfs WHERE pdf_id = ? AND subject_id = ?',
      [id, subjectId]
    );

    if (pdfs.length === 0) {
      return res.status(404).json({ success: false, message: 'PDF not found' });
    }

    const pdf = pdfs[0];

    // Check permission
    if (pdf.uploaded_by !== userId && req.user.role !== 'moderator' && req.user.role !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Permission denied' });
    }

    // Delete from database
    await db.query('DELETE FROM uploaded_pdfs WHERE pdf_id = ?', [id]);

    res.json({ success: true, message: 'PDF deleted successfully' });
  } catch (error) {
    console.error('Delete PDF error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
