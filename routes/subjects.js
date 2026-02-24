const express = require('express');
const { authMiddleware, requireRole } = require('../middleware/auth');
const db = require('../config/db');

const router = express.Router();

// Get all subjects (public or authenticated)
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    
    let query = `
      SELECT s.*, 
             u.name as moderator_name, 
             u.email as moderator_email,
             (SELECT COUNT(*) FROM subject_smes WHERE subject_id = s.subject_id AND status = 'active') as sme_count,
             (SELECT COUNT(*) FROM subject_examiners WHERE subject_id = s.subject_id AND status = 'active') as examiner_count
      FROM subjects s
      LEFT JOIN users u ON s.moderator_user_id = u.user_id
    `;
    
    const params = [];
    if (status) {
      query += ' WHERE s.status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY s.subject_name';
    
    const [subjects] = await db.query(query, params);
    
    res.json({ success: true, subjects });
  } catch (err) {
    console.error('Get subjects error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get single subject by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [subjects] = await db.query(`
      SELECT s.*, 
             u.name as moderator_name, 
             u.email as moderator_email
      FROM subjects s
      LEFT JOIN users u ON s.moderator_user_id = u.user_id
      WHERE s.subject_id = ?
    `, [id]);
    
    if (subjects.length === 0) {
      return res.status(404).json({ success: false, message: 'Subject not found' });
    }
    
    res.json({ success: true, subject: subjects[0] });
  } catch (err) {
    console.error('Get subject error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Create new subject (Super Admin or during registration)
router.post('/', async (req, res) => {
  try {
    const { subject_name, subject_code, description, category, level } = req.body;
    
    if (!subject_name) {
      return res.status(400).json({ success: false, message: 'Subject name is required' });
    }
    
    // Check if subject already exists
    const [existing] = await db.query(
      'SELECT subject_id FROM subjects WHERE LOWER(subject_name) = LOWER(?) OR (subject_code IS NOT NULL AND subject_code = ?)',
      [subject_name, subject_code]
    );
    
    if (existing.length > 0) {
      return res.json({ success: true, subject_id: existing[0].subject_id, exists: true });
    }
    
    const [result] = await db.query(
      'INSERT INTO subjects (subject_name, subject_code, description, category, level) VALUES (?, ?, ?, ?, ?)',
      [subject_name, subject_code || null, description || null, category || null, level || null]
    );
    
    res.status(201).json({ 
      success: true, 
      subject_id: result.insertId,
      message: 'Subject created successfully'
    });
  } catch (err) {
    console.error('Create subject error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Update subject (Super Admin only)
router.put('/:id', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { subject_name, subject_code, description, category, level, status } = req.body;
    
    const [result] = await db.query(
      `UPDATE subjects 
       SET subject_name = COALESCE(?, subject_name),
           subject_code = COALESCE(?, subject_code),
           description = COALESCE(?, description),
           category = COALESCE(?, category),
           level = COALESCE(?, level),
           status = COALESCE(?, status)
       WHERE subject_id = ?`,
      [subject_name, subject_code, description, category, level, status, id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Subject not found' });
    }
    
    res.json({ success: true, message: 'Subject updated successfully' });
  } catch (err) {
    console.error('Update subject error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Delete subject (Super Admin only)
router.delete('/:id', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if subject has users
    const [users] = await db.query(
      'SELECT COUNT(*) as count FROM users WHERE subject_id = ?',
      [id]
    );
    
    if (users[0].count > 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot delete subject with assigned users' 
      });
    }
    
    await db.query('DELETE FROM subjects WHERE subject_id = ?', [id]);
    
    res.json({ success: true, message: 'Subject deleted successfully' });
  } catch (err) {
    console.error('Delete subject error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get moderator for a subject
router.get('/:id/moderator', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [moderators] = await db.query(`
      SELECT u.user_id, u.name, u.email, u.phone, u.status
      FROM users u
      JOIN subjects s ON u.user_id = s.moderator_user_id
      WHERE s.subject_id = ? AND u.role = 'moderator'
    `, [id]);
    
    res.json({ 
      success: true, 
      moderator: moderators.length > 0 ? moderators[0] : null 
    });
  } catch (err) {
    console.error('Get moderator error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get all SMEs for a subject
router.get('/:id/smes', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [smes] = await db.query(`
      SELECT u.user_id, u.name, u.email, u.phone, u.status, 
             ss.assigned_at, ss.status as assignment_status,
             assigned_by_user.name as assigned_by_name
      FROM subject_smes ss
      JOIN users u ON ss.sme_user_id = u.user_id
      LEFT JOIN users assigned_by_user ON ss.assigned_by = assigned_by_user.user_id
      WHERE ss.subject_id = ?
      ORDER BY ss.assigned_at DESC
    `, [id]);
    
    res.json({ success: true, smes });
  } catch (err) {
    console.error('Get SMEs error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get all examiners for a subject
router.get('/:id/examiners', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [examiners] = await db.query(`
      SELECT u.user_id, u.name, u.email, u.phone, u.status,
             se.assigned_at, se.status as assignment_status,
             assigned_by_user.name as assigned_by_name
      FROM subject_examiners se
      JOIN users u ON se.examiner_user_id = u.user_id
      LEFT JOIN users assigned_by_user ON se.assigned_by = assigned_by_user.user_id
      WHERE se.subject_id = ?
      ORDER BY se.assigned_at DESC
    `, [id]);
    
    res.json({ success: true, examiners });
  } catch (err) {
    console.error('Get examiners error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Assign moderator to subject (Super Admin only)
router.post('/:id/assign-moderator', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { moderator_user_id } = req.body;
    
    if (!moderator_user_id) {
      return res.status(400).json({ success: false, message: 'Moderator user ID required' });
    }
    
    // Check if user is a moderator
    const [users] = await db.query(
      'SELECT user_id, role FROM users WHERE user_id = ? AND role = ?',
      [moderator_user_id, 'moderator']
    );
    
    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'Moderator not found' });
    }
    
    // Check if subject already has a moderator
    const [subjects] = await db.query(
      'SELECT moderator_user_id FROM subjects WHERE subject_id = ?',
      [id]
    );
    
    if (subjects.length === 0) {
      return res.status(404).json({ success: false, message: 'Subject not found' });
    }
    
    if (subjects[0].moderator_user_id) {
      return res.status(400).json({ 
        success: false, 
        message: 'Subject already has a moderator assigned' 
      });
    }
    
    // Assign moderator
    await db.query(
      'UPDATE subjects SET moderator_user_id = ? WHERE subject_id = ?',
      [moderator_user_id, id]
    );
    
    // Update user's subject_id
    await db.query(
      'UPDATE users SET subject_id = ? WHERE user_id = ?',
      [id, moderator_user_id]
    );
    
    res.json({ success: true, message: 'Moderator assigned successfully' });
  } catch (err) {
    console.error('Assign moderator error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Assign SME to subject (Moderator only)
router.post('/:id/assign-sme', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { id } = req.params;
    const { sme_user_id } = req.body;
    
    if (!sme_user_id) {
      return res.status(400).json({ success: false, message: 'SME user ID required' });
    }
    
    // Check if moderator is assigned to this subject
    const [subjects] = await db.query(
      'SELECT moderator_user_id FROM subjects WHERE subject_id = ?',
      [id]
    );
    
    if (subjects.length === 0) {
      return res.status(404).json({ success: false, message: 'Subject not found' });
    }
    
    if (subjects[0].moderator_user_id !== req.user.user_id) {
      return res.status(403).json({ 
        success: false, 
        message: 'You are not the moderator for this subject' 
      });
    }
    
    // Check if user is an SME
    const [users] = await db.query(
      'SELECT user_id, role FROM users WHERE user_id = ? AND role = ?',
      [sme_user_id, 'subject_matter_expert']
    );
    
    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'SME not found' });
    }
    
    // Check if already assigned
    const [existing] = await db.query(
      'SELECT id FROM subject_smes WHERE subject_id = ? AND sme_user_id = ?',
      [id, sme_user_id]
    );
    
    if (existing.length > 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'SME already assigned to this subject' 
      });
    }
    
    // Assign SME
    await db.query(
      'INSERT INTO subject_smes (subject_id, sme_user_id, assigned_by) VALUES (?, ?, ?)',
      [id, sme_user_id, req.user.user_id]
    );
    
    // Update user's subject_id (primary subject)
    await db.query(
      'UPDATE users SET subject_id = ? WHERE user_id = ? AND subject_id IS NULL',
      [id, sme_user_id]
    );
    
    res.json({ success: true, message: 'SME assigned successfully' });
  } catch (err) {
    console.error('Assign SME error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Assign examiner to subject (SME only)
router.post('/:id/assign-examiner', authMiddleware, requireRole('subject_matter_expert'), async (req, res) => {
  try {
    const { id } = req.params;
    const { examiner_user_id } = req.body;
    
    if (!examiner_user_id) {
      return res.status(400).json({ success: false, message: 'Examiner user ID required' });
    }
    
    // Check if SME is assigned to this subject
    const [smeAssignments] = await db.query(
      'SELECT id FROM subject_smes WHERE subject_id = ? AND sme_user_id = ? AND status = ?',
      [id, req.user.user_id, 'active']
    );
    
    if (smeAssignments.length === 0) {
      return res.status(403).json({ 
        success: false, 
        message: 'You are not assigned as SME for this subject' 
      });
    }
    
    // Check if user is an examiner
    const [users] = await db.query(
      'SELECT user_id, role FROM users WHERE user_id = ? AND role = ?',
      [examiner_user_id, 'examiner']
    );
    
    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'Examiner not found' });
    }
    
    // Check if already assigned
    const [existing] = await db.query(
      'SELECT id FROM subject_examiners WHERE subject_id = ? AND examiner_user_id = ?',
      [id, examiner_user_id]
    );
    
    if (existing.length > 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Examiner already assigned to this subject' 
      });
    }
    
    // Assign examiner
    await db.query(
      'INSERT INTO subject_examiners (subject_id, examiner_user_id, assigned_by) VALUES (?, ?, ?)',
      [id, examiner_user_id, req.user.user_id]
    );
    
    // Update user's subject_id (primary subject)
    await db.query(
      'UPDATE users SET subject_id = ? WHERE user_id = ? AND subject_id IS NULL',
      [id, examiner_user_id]
    );
    
    res.json({ success: true, message: 'Examiner assigned successfully' });
  } catch (err) {
    console.error('Assign examiner error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
