// backend/routes/users.js
const express = require('express');
const bcrypt = require('bcryptjs');
const { authMiddleware, requireRole } = require('../middleware/auth');
const db = require('../config/db');

const router = express.Router();

// Moderator: Get all users in their college OR subject
router.get('/', authMiddleware, requireRole('moderator'), async (req, res) => {
    try {
        const { status } = req.query; // Optional filter by status

        // Check if moderator is using subject-based system
        const useSubjectSystem = req.user.subject_id;

        let query, params;
        
        if (useSubjectSystem) {
            // NEW: Subject-based system - get users in moderator's subject
            query = `SELECT u.user_id, u.name, u.email, u.role, u.status, u.created_at, s.subject_name
                     FROM users u
                     LEFT JOIN subjects s ON u.subject_id = s.subject_id
                     WHERE u.subject_id = ?`;
            params = [req.user.subject_id];
        } else {
            // OLD: College-based system
            query = 'SELECT user_id, name, email, role, status, created_at FROM users WHERE college_id = ?';
            params = [req.user.college_id];
        }

        if (status) {
            query += ' AND u.status = ?';
            params.push(status);
        }

        query += ' ORDER BY created_at DESC';

        const [users] = await db.query(query, params);

        res.json({ success: true, users });
    } catch (err) {
        console.error('Get users error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Moderator: Get pending SME and Moderator registrations (not examiners)
router.get('/pending', authMiddleware, requireRole('moderator'), async (req, res) => {
    try {
        const useSubjectSystem = req.user.subject_id;
        
        console.log('📋 Moderator fetching pending users:', {
            moderator_id: req.user.user_id,
            moderator_subject_id: req.user.subject_id,
            using_subject_system: !!useSubjectSystem
        });
        
        let query, params;
        
        if (useSubjectSystem) {
            // NEW: Subject-based system - Moderator only sees pending SMEs (not examiners)
            query = `SELECT u.user_id, u.name, u.email, u.role, u.status, u.created_at, 
                     u.phone, u.qualification, u.institution_name,
                     s.subject_name, s.subject_code
                     FROM users u
                     LEFT JOIN subjects s ON u.subject_id = s.subject_id
                     WHERE u.subject_id = ? AND u.status = ? AND u.role = ?
                     ORDER BY u.created_at DESC`;
            params = [req.user.subject_id, 'pending', 'subject_matter_expert'];
        } else {
            // OLD: College-based system
            query = 'SELECT user_id, name, email, role, status, created_at FROM users WHERE college_id = ? AND status = ? AND role IN (?, ?) ORDER BY created_at DESC';
            params = [req.user.college_id, 'pending', 'subject_matter_expert', 'moderator'];
        }

        const [users] = await db.query(query, params);

        console.log('✅ Found pending users:', users.length);

        res.json({ success: true, pending_users: users });
    } catch (err) {
        console.error('Get pending users error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// SME: Update examiner status (activate/deactivate)
router.put('/examiner/:id/status', authMiddleware, requireRole('subject_matter_expert'), async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['active', 'inactive'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status. Use active or inactive' });
        }

        // Get SME's department
        const [smeData] = await db.query(
            'SELECT department_id FROM users WHERE user_id = ?',
            [req.user.user_id]
        );

        if (smeData.length === 0 || !smeData[0].department_id) {
            return res.status(400).json({ success: false, message: 'Department not found for SME' });
        }

        const departmentId = smeData[0].department_id;

        // Check if examiner exists and belongs to SME's department
        const [examiners] = await db.query(
            'SELECT user_id, name, status FROM users WHERE user_id = ? AND college_id = ? AND department_id = ? AND role = ?',
            [id, req.user.college_id, departmentId, 'examiner']
        );

        if (examiners.length === 0) {
            return res.status(404).json({ success: false, message: 'Examiner not found in your department' });
        }

        const examiner = examiners[0];

        // Don't allow changing status of pending examiners
        if (examiner.status === 'pending') {
            return res.status(400).json({ success: false, message: 'Cannot change status of pending examiners. Please approve or reject them first.' });
        }

        // Update status
        await db.query(
            'UPDATE users SET status = ? WHERE user_id = ?',
            [status, id]
        );

        res.json({ 
            success: true, 
            message: `Examiner ${status === 'active' ? 'activated' : 'deactivated'} successfully` 
        });
    } catch (err) {
        console.error('Update examiner status error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// SME: Get all examiners in their department OR subject
router.get('/my-examiners', authMiddleware, requireRole('subject_matter_expert'), async (req, res) => {
    try {
        const useSubjectSystem = req.user.subject_id;

        let query, params;

        if (useSubjectSystem) {
            // NEW: Subject-based system - Get examiners from subject_examiners table
            query = `SELECT u.user_id, u.name, u.email, u.role, u.status, u.created_at, u.last_login,
                     se.assigned_at, s.subject_name
                     FROM subject_examiners se
                     JOIN users u ON se.examiner_user_id = u.user_id
                     LEFT JOIN subjects s ON se.subject_id = s.subject_id
                     WHERE se.subject_id = ? AND se.status = 'active'
                     ORDER BY u.status, u.name`;
            params = [req.user.subject_id];
        } else {
            // OLD: Department-based system
            // Get SME's department
            const [smeData] = await db.query(
                'SELECT department_id FROM users WHERE user_id = ?',
                [req.user.user_id]
            );

            if (smeData.length === 0 || !smeData[0].department_id) {
                return res.status(400).json({ success: false, message: 'Department not found for SME' });
            }

            const departmentId = smeData[0].department_id;

            // Get all examiners in the same department
            query = `SELECT user_id, name, email, role, status, created_at, last_login
                     FROM users 
                     WHERE college_id = ? AND department_id = ? AND role = ? 
                     ORDER BY status, name`;
            params = [req.user.college_id, departmentId, 'examiner'];
        }

        const [examiners] = await db.query(query, params);

        res.json({ success: true, examiners });
    } catch (err) {
        console.error('Get my examiners error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// SME: Get pending examiner registrations in their department OR subject
router.get('/pending-examiners', authMiddleware, requireRole('subject_matter_expert'), async (req, res) => {
    try {
        const useSubjectSystem = req.user.subject_id;

        let query, params;

        if (useSubjectSystem) {
            // NEW: Subject-based system
            // Get pending examiners for SME's subject(s)
            query = `SELECT u.user_id, u.name, u.email, u.role, u.status, u.created_at, 
                     s.subject_name, u.phone, u.qualification, u.institution_name
                     FROM users u 
                     LEFT JOIN subjects s ON u.subject_id = s.subject_id
                     WHERE u.subject_id = ? AND u.status = ? AND u.role = ? 
                     ORDER BY u.created_at DESC`;
            params = [req.user.subject_id, 'pending', 'examiner'];
        } else {
            // OLD: Department-based system
            // Get SME's department
            const [smeData] = await db.query(
                'SELECT department_id FROM users WHERE user_id = ?',
                [req.user.user_id]
            );

            if (smeData.length === 0 || !smeData[0].department_id) {
                return res.status(400).json({ success: false, message: 'Department not found for SME' });
            }

            const departmentId = smeData[0].department_id;

            // Get pending examiners in the same department
            query = `SELECT u.user_id, u.name, u.email, u.role, u.status, u.created_at, d.department_name 
                     FROM users u 
                     LEFT JOIN departments d ON u.department_id = d.department_id
                     WHERE u.college_id = ? AND u.department_id = ? AND u.status = ? AND u.role = ? 
                     ORDER BY u.created_at DESC`;
            params = [req.user.college_id, departmentId, 'pending', 'examiner'];
        }

        const [users] = await db.query(query, params);

        res.json({ success: true, pending_users: users });
    } catch (err) {
        console.error('Get pending examiners error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Moderator: Create examiner user
router.post('/', authMiddleware, requireRole('moderator'), async (req, res) => {
    try {
        const { name, email, password, department_id, role } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ success: false, message: 'All fields required' });
        }

        // Check if user exists
        const [existing] = await db.query('SELECT user_id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'User already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const userRole = role || 'examiner';

        const [result] = await db.query(
            'INSERT INTO users (name, email, password, role, college_id, university_id, department_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [name, email, hashedPassword, userRole, req.user.college_id, req.user.university_id, department_id || null, 'active']
        );

        res.status(201).json({
            success: true,
            user: { user_id: result.insertId, name, email, role: userRole }
        });
    } catch (err) {
        console.error('Create user error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Moderator: Approve/Reject pending SME or Moderator (not examiners)
router.put('/:id/approve', authMiddleware, requireRole('moderator'), async (req, res) => {
    try {
        const { id } = req.params;
        const { action } = req.body; // 'approve' or 'reject'

        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ success: false, message: 'Invalid action. Use approve or reject' });
        }

        const useSubjectSystem = req.user.subject_id;

        let query, params;

        if (useSubjectSystem) {
            // NEW: Subject-based system
            query = 'SELECT user_id, name, email, role, subject_id FROM users WHERE user_id = ? AND subject_id = ? AND status = ? AND role IN (?, ?)';
            params = [id, req.user.subject_id, 'pending', 'subject_matter_expert', 'moderator'];
        } else {
            // OLD: College-based system
            query = 'SELECT user_id, name, email, role FROM users WHERE user_id = ? AND college_id = ? AND status = ? AND role IN (?, ?)';
            params = [id, req.user.college_id, 'pending', 'subject_matter_expert', 'moderator'];
        }

        // Check if user exists and is pending (SME or Moderator only)
        const [users] = await db.query(query, params);

        if (users.length === 0) {
            return res.status(404).json({ success: false, message: 'Pending user not found or not authorized' });
        }

        if (action === 'approve') {
            // Check if approving SME - enforce one SME per subject
            if (users[0].role === 'subject_matter_expert' && useSubjectSystem) {
                const [existingSME] = await db.query(
                    'SELECT user_id, name FROM users WHERE subject_id = ? AND role = ? AND status = ? AND user_id != ?',
                    [users[0].subject_id, 'subject_matter_expert', 'active', id]
                );

                if (existingSME.length > 0) {
                    return res.status(400).json({ 
                        success: false, 
                        message: `Cannot approve. An active SME (${existingSME[0].name}) already exists for this subject. Only one SME is allowed per subject.`,
                        existingSME: existingSME[0].name
                    });
                }
            }

            await db.query(
                'UPDATE users SET status = ? WHERE user_id = ?',
                ['active', id]
            );

            // If subject-based system and approving SME, add to subject_smes table
            if (useSubjectSystem && users[0].role === 'subject_matter_expert') {
                await db.query(
                    'INSERT INTO subject_smes (subject_id, sme_user_id, assigned_by) VALUES (?, ?, ?)',
                    [users[0].subject_id, id, req.user.user_id]
                );
            }

            res.json({ success: true, message: `${users[0].role === 'subject_matter_expert' ? 'Subject Matter Expert' : 'Moderator'} approved successfully` });
        } else {
            // Reject - delete the user
            await db.query('DELETE FROM users WHERE user_id = ?', [id]);
            res.json({ success: true, message: 'Registration rejected' });
        }
    } catch (err) {
        console.error('Approve user error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// SME: Approve/Reject pending examiner in their department OR subject
router.put('/:id/approve-examiner', authMiddleware, requireRole('subject_matter_expert'), async (req, res) => {
    try {
        const { id } = req.params;
        const { action } = req.body; // 'approve' or 'reject'

        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ success: false, message: 'Invalid action. Use approve or reject' });
        }

        const useSubjectSystem = req.user.subject_id;

        let query, params;

        if (useSubjectSystem) {
            // NEW: Subject-based system
            query = 'SELECT user_id, name, email, subject_id FROM users WHERE user_id = ? AND subject_id = ? AND status = ? AND role = ?';
            params = [id, req.user.subject_id, 'pending', 'examiner'];
        } else {
            // OLD: Department-based system
            // Get SME's department
            const [smeData] = await db.query(
                'SELECT department_id FROM users WHERE user_id = ?',
                [req.user.user_id]
            );

            if (smeData.length === 0 || !smeData[0].department_id) {
                return res.status(400).json({ success: false, message: 'Department not found for SME' });
            }

            const departmentId = smeData[0].department_id;

            // Check if examiner exists, is pending, and belongs to SME's department
            query = 'SELECT user_id, name, email FROM users WHERE user_id = ? AND college_id = ? AND department_id = ? AND status = ? AND role = ?';
            params = [id, req.user.college_id, departmentId, 'pending', 'examiner'];
        }

        const [users] = await db.query(query, params);

        if (users.length === 0) {
            return res.status(404).json({ success: false, message: 'Pending examiner not found in your department/subject' });
        }

        if (action === 'approve') {
            await db.query(
                'UPDATE users SET status = ? WHERE user_id = ?',
                ['active', id]
            );

            // If subject-based system, add to subject_examiners table
            if (useSubjectSystem) {
                await db.query(
                    'INSERT INTO subject_examiners (subject_id, examiner_user_id, assigned_by) VALUES (?, ?, ?)',
                    [users[0].subject_id, id, req.user.user_id]
                );
            }

            res.json({ success: true, message: 'Examiner approved successfully' });
        } else {
            // Reject - delete the user
            await db.query('DELETE FROM users WHERE user_id = ?', [id]);
            res.json({ success: true, message: 'Examiner registration rejected' });
        }
    } catch (err) {
        console.error('Approve examiner error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Moderator: Update user status
router.put('/:id/status', authMiddleware, requireRole('moderator'), async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['active', 'inactive', 'suspended'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status' });
        }

        // Ensure user belongs to same college
        await db.query(
            'UPDATE users SET status = ? WHERE user_id = ? AND college_id = ?',
            [status, id, req.user.college_id]
        );

        res.json({ success: true, message: 'User status updated' });
    } catch (err) {
        console.error('Update user error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Super Admin: Get all moderators (subject-based)
router.get('/moderators', authMiddleware, requireRole('super_admin'), async (req, res) => {
    try {
        const [moderators] = await db.query(
            `SELECT u.user_id, u.name, u.email, u.phone, u.status, u.created_at, u.department,
                    s.subject_name, s.subject_code
             FROM users u
             LEFT JOIN subjects s ON u.subject_id = s.subject_id
             WHERE u.role = 'moderator' AND u.status IN ('active', 'inactive')
             ORDER BY u.created_at DESC`
        );

        res.json({ success: true, moderators });
    } catch (err) {
        console.error('Get moderators error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// EDULAB Super Admin: Get CET super admins
router.get('/cet-super-admins', authMiddleware, requireRole('super_admin'), async (req, res) => {
    try {
        // Only EDULAB super admin can access this
        if (req.user.department !== 'EDULAB') {
            return res.status(403).json({ success: false, message: 'Access denied. EDULAB admin only.' });
        }

        const [cetAdmins] = await db.query(
            `SELECT user_id, name, email, phone, status, created_at, last_login
             FROM users
             WHERE role = 'super_admin' AND department = 'CET' AND status IN ('active', 'inactive')
             ORDER BY created_at DESC`
        );

        res.json({ success: true, cet_super_admins: cetAdmins });
    } catch (err) {
        console.error('Get CET super admins error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Super Admin: Get pending moderators (subject-based)
router.get('/pending-moderators', authMiddleware, requireRole('super_admin'), async (req, res) => {
    try {
        const [moderators] = await db.query(
            `SELECT u.user_id, u.name, u.email, u.phone, u.qualification, u.institution_name,
                    u.subject_id, u.status, u.created_at, u.department,
                    s.subject_name, s.subject_code, s.moderator_user_id
             FROM users u
             LEFT JOIN subjects s ON u.subject_id = s.subject_id
             WHERE u.role = 'moderator' AND u.status = 'pending' AND u.subject_id IS NOT NULL
             ORDER BY u.created_at DESC`
        );

        res.json({ success: true, pending_moderators: moderators });
    } catch (err) {
        console.error('Get pending moderators error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Super Admin: Approve/Reject moderator (subject-based)
router.put('/:id/approve-moderator', authMiddleware, requireRole('super_admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const { action } = req.body; // 'approve' or 'reject'

        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ success: false, message: 'Invalid action. Use approve or reject' });
        }

        // Check if user is a pending moderator
        const [users] = await db.query(
            'SELECT user_id, name, email, subject_id FROM users WHERE user_id = ? AND role = ? AND status = ?',
            [id, 'moderator', 'pending']
        );

        if (users.length === 0) {
            return res.status(404).json({ success: false, message: 'Pending moderator not found' });
        }

        const moderator = users[0];

        if (action === 'approve') {
            // Check if subject already has a moderator
            if (moderator.subject_id) {
                // Check both: moderator_user_id in subjects table AND active moderators with this subject_id
                const [subjects] = await db.query(
                    'SELECT moderator_user_id FROM subjects WHERE subject_id = ?',
                    [moderator.subject_id]
                );

                const [existingModerators] = await db.query(
                    'SELECT user_id, name FROM users WHERE subject_id = ? AND role = ? AND status = ? AND user_id != ?',
                    [moderator.subject_id, 'moderator', 'active', id]
                );

                if ((subjects.length > 0 && subjects[0].moderator_user_id) || existingModerators.length > 0) {
                    const existingModName = existingModerators.length > 0 ? existingModerators[0].name : 'Unknown';
                    return res.status(400).json({
                        success: false,
                        message: `This subject already has a moderator assigned: ${existingModName}. Only one moderator is allowed per subject.`,
                        existingModerator: existingModName
                    });
                }

                // Approve moderator
                await db.query(
                    'UPDATE users SET status = ? WHERE user_id = ?',
                    ['active', id]
                );

                // Assign moderator to subject
                await db.query(
                    'UPDATE subjects SET moderator_user_id = ? WHERE subject_id = ?',
                    [id, moderator.subject_id]
                );

                res.json({ success: true, message: 'Moderator approved and assigned to subject successfully' });
            } else {
                // No subject assigned, just approve
                await db.query(
                    'UPDATE users SET status = ? WHERE user_id = ?',
                    ['active', id]
                );
                res.json({ success: true, message: 'Moderator approved successfully' });
            }
        } else {
            // Reject - delete the user
            await db.query('DELETE FROM users WHERE user_id = ?', [id]);
            res.json({ success: true, message: 'Moderator registration rejected' });
        }
    } catch (err) {
        console.error('Approve moderator error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
