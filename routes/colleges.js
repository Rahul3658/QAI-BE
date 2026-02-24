// backend/routes/colleges.js
const express = require('express');
const { authMiddleware, requireRole } = require('../middleware/auth');
const db = require('../config/db');

const router = express.Router();

// Super Admin: Get all colleges
router.get('/', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    const [colleges] = await db.query(
      `SELECT c.*, u.university_name, 
       (SELECT COUNT(*) FROM users WHERE college_id = c.college_id) as user_count
       FROM colleges c
       LEFT JOIN universities u ON c.university_id = u.university_id
       ORDER BY c.created_at DESC`
    );

    res.json({ success: true, colleges });
  } catch (err) {
    console.error('Get colleges error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Super Admin: Create college
router.post('/', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    const { college_name, university_id, contact_email, contact_phone, subscription_status } = req.body;

    if (!college_name || !university_id) {
      return res.status(400).json({ success: false, message: 'College name and university required' });
    }

    const [result] = await db.query(
      'INSERT INTO colleges (college_name, university_id, contact_email, contact_phone, subscription_status) VALUES (?, ?, ?, ?, ?)',
      [college_name, university_id, contact_email, contact_phone, subscription_status || 'trial']
    );

    res.status(201).json({
      success: true,
      college: { college_id: result.insertId, college_name, university_id }
    });
  } catch (err) {
    console.error('Create college error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Super Admin: Update college
router.put('/:id', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { college_name, status, subscription_status, subscription_start, subscription_end } = req.body;

    await db.query(
      'UPDATE colleges SET college_name = COALESCE(?, college_name), status = COALESCE(?, status), subscription_status = COALESCE(?, subscription_status), subscription_start = COALESCE(?, subscription_start), subscription_end = COALESCE(?, subscription_end) WHERE college_id = ?',
      [college_name, status, subscription_status, subscription_start, subscription_end, id]
    );

    res.json({ success: true, message: 'College updated' });
  } catch (err) {
    console.error('Update college error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Moderator: Get own college info
router.get('/my-college', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    // Check if moderator is using subject-based system
    if (req.user.subject_id && !req.user.college_id) {
      // Subject-based moderator - return subject info instead
      const [subjects] = await db.query(
        `SELECT subject_id, subject_name, subject_code, description, category, level
         FROM subjects
         WHERE subject_id = ?`,
        [req.user.subject_id]
      );

      if (subjects.length === 0) {
        return res.status(404).json({ success: false, message: 'Subject not found' });
      }

      // Return subject info in college format for compatibility
      res.json({ 
        success: true, 
        college: {
          college_id: null,
          college_name: subjects[0].subject_name,
          university_name: `Subject: ${subjects[0].subject_code}`,
          subject_based: true,
          subject_id: subjects[0].subject_id,
          subject_name: subjects[0].subject_name,
          subject_code: subjects[0].subject_code
        }
      });
    } else {
      // College-based moderator - return college info
      const [colleges] = await db.query(
        `SELECT c.*, u.university_name 
         FROM colleges c
         LEFT JOIN universities u ON c.university_id = u.university_id
         WHERE c.college_id = ?`,
        [req.user.college_id]
      );

      if (colleges.length === 0) {
        return res.status(404).json({ success: false, message: 'College not found' });
      }

      res.json({ success: true, college: colleges[0] });
    }
  } catch (err) {
    console.error('Get college error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});



// Moderator: Get pending papers for approval
router.get('/pending-papers', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const collegeId = req.user.college_id;

    const [papers] = await db.query(
      `SELECT qp.*, u.name as generated_by_name
       FROM question_papers qp
       JOIN users u ON qp.generated_by = u.user_id
       WHERE qp.college_id = ? AND qp.status = 'draft'
       ORDER BY qp.created_at DESC`,
      [collegeId]
    );

    res.json({ success: true, papers });
  } catch (err) {
    console.error('Get pending papers error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Moderator: Approve/Reject paper
router.put('/papers/:paperId/approve', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { paperId } = req.params;
    const { action } = req.body;
    const collegeId = req.user.college_id;
    const userId = req.user.user_id;

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Invalid action' });
    }

    // Verify paper belongs to this college
    const [papers] = await db.query(
      'SELECT paper_id, generated_by FROM question_papers WHERE paper_id = ? AND college_id = ?',
      [paperId, collegeId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found' });
    }

    const newStatus = action === 'approve' ? 'finalized' : 'archived';

    await db.query(
      'UPDATE question_papers SET status = ? WHERE paper_id = ?',
      [newStatus, paperId]
    );

    // Log audit
    await db.query(
      'INSERT INTO audit_logs (user_id, college_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, collegeId, `PAPER_${action.toUpperCase()}D`, 'question_paper', paperId, null, req.ip]
    );

    res.json({ success: true, message: `Paper ${action}d successfully` });
  } catch (err) {
    console.error('Approve paper error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;