// backend/routes/coordinators.js
const express = require('express');
const { authMiddleware, requireRole } = require('../middleware/auth');
const db = require('../config/db');

const router = express.Router();

// Super Admin: Get all pending coordinators
router.get('/pending', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    const [coordinators] = await db.query(
      `SELECT u.*, c.college_name, uni.university_name 
       FROM users u
       LEFT JOIN colleges c ON u.college_id = c.college_id
       LEFT JOIN universities uni ON u.university_id = uni.university_id
       WHERE u.role = ? AND u.status = ?
       ORDER BY u.created_at DESC`,
      ['coordinator', 'pending']
    );

    res.json({ success: true, pending_coordinators: coordinators });
  } catch (err) {
    console.error('Get pending coordinators error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Super Admin: Get all coordinators
router.get('/', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    const [coordinators] = await db.query(
      `SELECT u.*, c.college_name, uni.university_name 
       FROM users u
       LEFT JOIN colleges c ON u.college_id = c.college_id
       LEFT JOIN universities uni ON u.university_id = uni.university_id
       WHERE u.role = ?
       ORDER BY u.created_at DESC`,
      ['coordinator']
    );

    res.json({ success: true, coordinators });
  } catch (err) {
    console.error('Get coordinators error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Super Admin: Approve/Reject coordinator
router.put('/:id/approve', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body;

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Invalid action' });
    }

    // Check if coordinator exists and is pending
    const [coordinators] = await db.query(
      'SELECT user_id, name, email FROM users WHERE user_id = ? AND role = ? AND status = ?',
      [id, 'coordinator', 'pending']
    );

    if (coordinators.length === 0) {
      return res.status(404).json({ success: false, message: 'Pending coordinator not found' });
    }

    if (action === 'approve') {
      await db.query('UPDATE users SET status = ? WHERE user_id = ?', ['active', id]);
      res.json({ success: true, message: 'Coordinator approved successfully' });
    } else {
      await db.query('DELETE FROM users WHERE user_id = ?', [id]);
      res.json({ success: true, message: 'Coordinator registration rejected' });
    }
  } catch (err) {
    console.error('Approve coordinator error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Super Admin: Update coordinator status
router.put('/:id/status', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['active', 'inactive', 'suspended'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    await db.query(
      'UPDATE users SET status = ? WHERE user_id = ? AND role = ?',
      [status, id, 'coordinator']
    );

    res.json({ success: true, message: 'Coordinator status updated' });
  } catch (err) {
    console.error('Update coordinator error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
