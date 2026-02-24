// PDF Upload and Management Routes
const express = require('express');
const multer = require('multer');
const { authMiddleware } = require('../middleware/auth');
const { processPDF, generateFileHash } = require('../utils/pdfProcessor');
const { storeChunks, deleteChunksByFileHash, getNamespaceStats } = require('../utils/pinecone');
const db = require('../config/db');

const router = express.Router();

// Configure multer for PDF uploads (memory storage)
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

// Upload PDF and process it
router.post('/upload', authMiddleware, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No PDF file uploaded' });
    }

    const { subject, topic, description } = req.body;
    const userId = req.user.user_id;
    const subjectId = req.user.subject_id;

    console.log(`📤 Upload request from user ${userId}`);

    // Generate file hash
    const fileHash = generateFileHash(req.file.buffer);

    // Check if file already exists in database (subject-based system)
    const [existing] = await db.query(
      'SELECT pdf_id, file_hash, status FROM uploaded_pdfs WHERE file_hash = ? AND subject_id = ?',
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

    // Process PDF
    const processed = await processPDF(req.file.buffer, req.file.originalname);

    // Store in database (subject-based system)
    const [result] = await db.query(
      `INSERT INTO uploaded_pdfs 
       (file_name, file_hash, file_size, pages, total_chunks, subject, topic, description, 
        uploaded_by, subject_id, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.file.originalname,
        fileHash,
        req.file.size,
        processed.pages,
        processed.totalChunks,
        subject || null,
        topic || null,
        description || null,
        userId,
        subjectId,
        'processing'
      ]
    );

    const pdfId = result.insertId;

    // Store chunks in Pinecone (namespace per subject)
    const namespace = `subject_${subjectId}`;
    const chunkStats = await storeChunks(
      processed.chunks,
      {
        fileName: req.file.originalname,
        fileHash,
        uploadedBy: userId,
        uploadedAt: new Date().toISOString(),
        additional: {
          pdfId,
          subject,
          topic
        }
      },
      namespace
    );

    // Update status
    await db.query(
      'UPDATE uploaded_pdfs SET status = ?, chunks_stored = ? WHERE pdf_id = ?',
      ['ready', chunkStats.stored, pdfId]
    );

    res.json({
      success: true,
      message: 'PDF uploaded and processed successfully',
      pdf: {
        pdf_id: pdfId,
        file_name: req.file.originalname,
        file_hash: fileHash,
        pages: processed.pages,
        total_chunks: processed.totalChunks,
        chunks_stored: chunkStats.stored,
        chunks_skipped: chunkStats.skipped
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

// Get all uploaded PDFs for user's subject (subject-based system)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const subjectId = req.user.subject_id;

    const [pdfs] = await db.query(
      `SELECT p.*, u.name as uploaded_by_name 
       FROM uploaded_pdfs p
       LEFT JOIN users u ON p.uploaded_by = u.user_id
       WHERE p.subject_id = ?
       ORDER BY p.uploaded_at DESC`,
      [subjectId]
    );

    res.json({ success: true, pdfs });
  } catch (error) {
    console.error('Get PDFs error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get single PDF details (subject-based system)
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const subjectId = req.user.subject_id;

    const [pdfs] = await db.query(
      `SELECT p.*, u.name as uploaded_by_name 
       FROM uploaded_pdfs p
       LEFT JOIN users u ON p.uploaded_by = u.user_id
       WHERE p.pdf_id = ? AND p.subject_id = ?`,
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

// Delete PDF and its chunks (subject-based system)
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

    // Check permission (only uploader or admin can delete)
    if (pdf.uploaded_by !== userId && req.user.role !== 'moderator' && req.user.role !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Permission denied' });
    }

    // Delete chunks from Pinecone (namespace per subject)
    const namespace = `subject_${subjectId}`;
    await deleteChunksByFileHash(pdf.file_hash, namespace);

    // Delete from database
    await db.query('DELETE FROM uploaded_pdfs WHERE pdf_id = ?', [id]);

    res.json({ success: true, message: 'PDF deleted successfully' });
  } catch (error) {
    console.error('Delete PDF error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get Pinecone stats for subject (subject-based system)
router.get('/stats/pinecone', authMiddleware, async (req, res) => {
  try {
    const subjectId = req.user.subject_id;
    const namespace = `subject_${subjectId}`;

    const stats = await getNamespaceStats(namespace);

    res.json({
      success: true,
      stats: {
        vectorCount: stats.vectorCount || 0,
        namespace
      }
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
