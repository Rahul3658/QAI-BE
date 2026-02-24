const express = require('express');
const db = require('../config/db');
const { authMiddleware, superAdminOnly } = require('../middleware/auth');

const router = express.Router();

// Get all universities (admin only)
router.get('/', authMiddleware, superAdminOnly, async (req, res) => {
    try {
        const [universities] = await db.query(
            'SELECT university_id, university_name, location, created_at FROM universities ORDER BY university_name'
        );

        // Add default status since column doesn't exist in DB yet
        const universitiesWithStatus = universities.map(u => ({
            ...u,
            status: 'active'
        }));

        res.json({ success: true, universities: universitiesWithStatus });
    } catch (err) {
        console.error('Get universities error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Add new university
router.post('/', authMiddleware, superAdminOnly, async (req, res) => {
    try {
        const { university_name, location, status } = req.body;

        if (!university_name) {
            return res.status(400).json({ success: false, message: 'University name is required' });
        }

        // Check if university already exists
        const [existing] = await db.query(
            'SELECT university_id FROM universities WHERE university_name = ?',
            [university_name]
        );

        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'University already exists' });
        }

        const [result] = await db.query(
            'INSERT INTO universities (university_name, location) VALUES (?, ?)',
            [university_name, location || null]
        );

        res.json({
            success: true,
            message: 'University added successfully',
            university_id: result.insertId
        });
    } catch (err) {
        console.error('Add university error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Update university
router.put('/:id', authMiddleware, superAdminOnly, async (req, res) => {
    try {
        const { id } = req.params;
        const { university_name, location, status } = req.body;

        if (!university_name) {
            return res.status(400).json({ success: false, message: 'University name is required' });
        }

        // Check if university exists
        const [existing] = await db.query(
            'SELECT university_id FROM universities WHERE university_id = ?',
            [id]
        );

        if (existing.length === 0) {
            return res.status(404).json({ success: false, message: 'University not found' });
        }

        // Check if name is already taken by another university
        const [duplicate] = await db.query(
            'SELECT university_id FROM universities WHERE university_name = ? AND university_id != ?',
            [university_name, id]
        );

        if (duplicate.length > 0) {
            return res.status(400).json({ success: false, message: 'University name already exists' });
        }

        await db.query(
            'UPDATE universities SET university_name = ?, location = ? WHERE university_id = ?',
            [university_name, location || null, id]
        );

        res.json({
            success: true,
            message: 'University updated successfully'
        });
    } catch (err) {
        console.error('Update university error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Delete university
router.delete('/:id', authMiddleware, superAdminOnly, async (req, res) => {
    try {
        const { id } = req.params;

        // Check if university has colleges
        const [colleges] = await db.query(
            'SELECT COUNT(*) as count FROM colleges WHERE university_id = ?',
            [id]
        );

        if (colleges[0].count > 0) {
            return res.status(400).json({
                success: false,
                message: 'Cannot delete university with existing colleges. Please delete or reassign colleges first.'
            });
        }

        const [result] = await db.query(
            'DELETE FROM universities WHERE university_id = ?',
            [id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'University not found' });
        }

        res.json({
            success: true,
            message: 'University deleted successfully'
        });
    } catch (err) {
        console.error('Delete university error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
