// backend/routes/departments.js
const express = require('express');
const { authMiddleware, requireRole } = require('../middleware/auth');
const db = require('../config/db');

const router = express.Router();

// Moderator: Get all departments in their college
router.get('/', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const [departments] = await db.query(
      `SELECT d.*, u.name as hod_name, u.email as hod_email,
       (SELECT COUNT(*) FROM users WHERE department_id = d.department_id AND role = 'examiner') as faculty_count
       FROM departments d
       LEFT JOIN users u ON d.hod_user_id = u.user_id
       WHERE d.college_id = ?
       ORDER BY d.department_name`,
      [req.user.college_id]
    );

    res.json({ success: true, departments });
  } catch (err) {
    console.error('Get departments error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Moderator: Create department
router.post('/', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { department_name, department_code } = req.body;

    if (!department_name || !department_code) {
      return res.status(400).json({ success: false, message: 'Department name and code required' });
    }

    // Check if department code already exists in this college
    const [existing] = await db.query(
      'SELECT department_id FROM departments WHERE department_code = ? AND college_id = ?',
      [department_code, req.user.college_id]
    );

    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: 'Department code already exists' });
    }

    const [result] = await db.query(
      'INSERT INTO departments (department_name, department_code, college_id) VALUES (?, ?, ?)',
      [department_name, department_code, req.user.college_id]
    );

    res.status(201).json({
      success: true,
      department: {
        department_id: result.insertId,
        department_name,
        department_code
      }
    });
  } catch (err) {
    console.error('Create department error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Moderator: Update department
router.put('/:id', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { id } = req.params;
    const { department_name, department_code, status } = req.body;

    await db.query(
      'UPDATE departments SET department_name = ?, department_code = ?, status = ? WHERE department_id = ? AND college_id = ?',
      [department_name, department_code, status, id, req.user.college_id]
    );

    res.json({ success: true, message: 'Department updated successfully' });
  } catch (err) {
    console.error('Update department error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Moderator: Assign Subject Matter Expert to department
router.put('/:id/assign-hod', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ success: false, message: 'User ID required' });
    }

    // Verify user is faculty in this college and department
    const [users] = await db.query(
      'SELECT user_id, role, department_id FROM users WHERE user_id = ? AND college_id = ?',
      [user_id, req.user.college_id]
    );

    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Check if user is already HOD of another department
    const [existingHod] = await db.query(
      'SELECT department_id FROM departments WHERE hod_user_id = ? AND college_id = ?',
      [user_id, req.user.college_id]
    );

    if (existingHod.length > 0 && existingHod[0].department_id != id) {
      return res.status(400).json({ success: false, message: 'User is already HOD of another department' });
    }

    // Update department with new HOD
    await db.query(
      'UPDATE departments SET hod_user_id = ? WHERE department_id = ? AND college_id = ?',
      [user_id, id, req.user.college_id]
    );

    // Update user role to subject_matter_expert and set is_hod flag
    await db.query(
      'UPDATE users SET role = ?, is_hod = TRUE, department_id = ? WHERE user_id = ?',
      ['subject_matter_expert', id, user_id]
    );

    res.json({ success: true, message: 'HOD assigned successfully' });
  } catch (err) {
    console.error('Assign HOD error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Moderator: Remove Subject Matter Expert from department
router.put('/:id/remove-hod', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { id } = req.params;

    // Get current HOD
    const [dept] = await db.query(
      'SELECT hod_user_id FROM departments WHERE department_id = ? AND college_id = ?',
      [id, req.user.college_id]
    );

    if (dept.length === 0) {
      return res.status(404).json({ success: false, message: 'Department not found' });
    }

    const hodUserId = dept[0].hod_user_id;

    // Remove HOD from department
    await db.query(
      'UPDATE departments SET hod_user_id = NULL WHERE department_id = ? AND college_id = ?',
      [id, req.user.college_id]
    );

    // Update user role back to faculty
    if (hodUserId) {
      await db.query(
        'UPDATE users SET role = ?, is_hod = FALSE WHERE user_id = ?',
        ['examiner', hodUserId]
      );
    }

    res.json({ success: true, message: 'HOD removed successfully' });
  } catch (err) {
    console.error('Remove HOD error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// College Admin or HOD: Get faculty in department
router.get('/:id/faculty', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // Check access
    if (req.user.role === 'subject_matter_expert') {
      // Subject Matter Expert can only see their own department
      const [dept] = await db.query(
        'SELECT department_id FROM departments WHERE department_id = ? AND hod_user_id = ?',
        [id, req.user.user_id]
      );
      if (dept.length === 0) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
    } else if (req.user.role !== 'moderator') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const [faculty] = await db.query(
      `SELECT user_id, name, email, role, status, is_hod, created_at 
       FROM users 
       WHERE department_id = ? AND role IN ('examiner', 'subject_matter_expert')
       ORDER BY is_hod DESC, name`,
      [id]
    );

    res.json({ success: true, faculty });
  } catch (err) {
    console.error('Get faculty error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Subject Matter Expert: Get their department info
router.get('/my-department', authMiddleware, requireRole('subject_matter_expert'), async (req, res) => {
  try {
    // Check if SME is using subject-based system
    if (req.user.subject_id && !req.user.department_id) {
      // Subject-based SME - return subject info instead
      const [subjects] = await db.query(
        `SELECT subject_id, subject_name, subject_code, description, category, level,
         (SELECT COUNT(*) FROM subject_examiners WHERE subject_id = ? AND status = 'active') as faculty_count
         FROM subjects
         WHERE subject_id = ?`,
        [req.user.subject_id, req.user.subject_id]
      );

      if (subjects.length === 0) {
        return res.status(404).json({ success: false, message: 'Subject not found for SME' });
      }

      // Return subject info in department format for compatibility
      res.json({ 
        success: true, 
        department: {
          department_id: null,
          department_name: subjects[0].subject_name,
          department_code: subjects[0].subject_code,
          faculty_count: subjects[0].faculty_count,
          subject_based: true,
          subject_id: subjects[0].subject_id,
          subject_name: subjects[0].subject_name,
          subject_code: subjects[0].subject_code
        }
      });
    } else {
      // Department-based SME - return department info
      // First get the SME's department_id
      const [smeData] = await db.query(
        'SELECT department_id FROM users WHERE user_id = ?',
        [req.user.user_id]
      );

      if (smeData.length === 0 || !smeData[0].department_id) {
        return res.status(404).json({ success: false, message: 'Department not found for SME' });
      }

      const departmentId = smeData[0].department_id;

      // Get department details
      const [departments] = await db.query(
        `SELECT d.*, 
         (SELECT COUNT(*) FROM users WHERE department_id = d.department_id AND role = 'examiner') as faculty_count
         FROM departments d
         WHERE d.department_id = ?`,
        [departmentId]
      );

      if (departments.length === 0) {
        return res.status(404).json({ success: false, message: 'Department not found' });
      }

      res.json({ success: true, department: departments[0] });
    }
  } catch (err) {
    console.error('Get my department error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
