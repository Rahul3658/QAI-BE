// backend/routes/public.js
const express = require('express');
const db = require('../config/db');

const router = express.Router();

// Get all universities (for registration dropdown)
router.get('/universities', async (req, res) => {
  try {
    const [universities] = await db.query(
      'SELECT university_id, university_name, location FROM universities ORDER BY university_name'
    );

    res.json({ success: true, universities });
  } catch (err) {
    console.error('Get universities error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get colleges by university (for registration dropdown)
router.get('/colleges', async (req, res) => {
  try {
    const { university_id } = req.query;

    let query = 'SELECT college_id, college_name, university_id FROM colleges WHERE status = ?';
    const params = ['active'];

    if (university_id) {
      query += ' AND university_id = ?';
      params.push(university_id);
    }

    query += ' ORDER BY college_name';

    const [colleges] = await db.query(query, params);

    res.json({ success: true, colleges });
  } catch (err) {
    console.error('Get colleges error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get departments by college (for registration dropdown)
router.get('/departments', async (req, res) => {
  try {
    const { college_id } = req.query;

    if (!college_id) {
      return res.status(400).json({ success: false, message: 'college_id required' });
    }

    const [departments] = await db.query(
      'SELECT department_id, department_name, department_code, hod_user_id FROM departments WHERE college_id = ? ORDER BY department_name',
      [college_id]
    );

    res.json({ success: true, departments });
  } catch (err) {
    console.error('Get departments error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get all subjects (for registration dropdown)
router.get('/subjects', async (req, res) => {
  try {
    const [subjects] = await db.query(`
      SELECT s.subject_id, s.subject_name, s.subject_code, s.description, 
             s.category, s.level, s.moderator_user_id,
             u.name as moderator_name
      FROM subjects s
      LEFT JOIN users u ON s.moderator_user_id = u.user_id
      WHERE s.status = 'active'
      ORDER BY s.subject_name
    `);

    res.json({ success: true, subjects });
  } catch (err) {
    console.error('Get subjects error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
