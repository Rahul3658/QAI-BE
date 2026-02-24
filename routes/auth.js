// backend/routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const db = require('../config/db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Helper: Log audit trail
async function logAudit(userId, collegeId, action, entityType, entityId, details, ip) {
  try {
    await db.query(
      'INSERT INTO audit_logs (user_id, college_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, collegeId, action, entityType, entityId, details, ip]
    );
  } catch (err) {
    console.error('Audit log error:', err);
  }
}

// Register (Admin creates users OR Faculty self-registration)
// UPDATED: Now supports BOTH old system (college/university) AND new system (subjects)
router.post('/register', async (req, res) => {
  try {
    const { 
      name, email, password, role, phone,
      // Old system fields
      college_id, university_id, custom_university, custom_college, department_id, custom_department,
      // New system fields
      subject_id, custom_subject_name, custom_subject_code, custom_subject_description,
      qualification, years_of_experience, institution_name, specialization
    } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({ success: false, message: 'Name, email, password, and role are required' });
    }

    // Validate role
    const validRoles = ['super_admin', 'moderator', 'examiner', 'subject_matter_expert'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ success: false, message: 'Invalid role' });
    }

    // Determine if using NEW subject-based system or OLD college-based system
    const useSubjectSystem = subject_id || custom_subject_name;
    
    let finalSubjectId = subject_id;
    let finalUniversityId = university_id;
    let finalCollegeId = college_id;
    let finalDepartmentId = department_id;

    // ========== NEW SUBJECT-BASED SYSTEM ==========
    if (useSubjectSystem) {
      // Handle custom subject creation
      if (custom_subject_name && custom_subject_name.trim()) {
        // Check if subject already exists
        const [existingSubject] = await db.query(
          'SELECT subject_id FROM subjects WHERE LOWER(subject_name) = LOWER(?)',
          [custom_subject_name.trim()]
        );

        if (existingSubject.length > 0) {
          finalSubjectId = existingSubject[0].subject_id;
        } else {
          // Create new subject
          const [subjectResult] = await db.query(
            'INSERT INTO subjects (subject_name, subject_code, description) VALUES (?, ?, ?)',
            [
              custom_subject_name.trim(), 
              custom_subject_code?.trim() || null, 
              custom_subject_description?.trim() || null
            ]
          );
          finalSubjectId = subjectResult.insertId;
        }
      }

      // All roles except super_admin must have subject_id
      if (role !== 'super_admin' && !finalSubjectId) {
        return res.status(400).json({ success: false, message: 'subject_id or custom_subject_name required for this role' });
      }

      // Check if moderator already exists for this subject (only check ACTIVE, allow PENDING)
      if (role === 'moderator' && finalSubjectId) {
        const [existingModerator] = await db.query(
          'SELECT user_id, name FROM users WHERE role = ? AND subject_id = ? AND status = ?',
          ['moderator', finalSubjectId, 'active']
        );

        if (existingModerator.length > 0) {
          return res.status(400).json({ 
            success: false, 
            message: `This subject already has an active moderator (${existingModerator[0].name}). Only one moderator is allowed per subject.`,
            existingModerator: existingModerator[0].name
          });
        }
      }

      // Check if SME already exists for this subject (only check ACTIVE, allow PENDING)
      if (role === 'subject_matter_expert' && finalSubjectId) {
        const [existingSME] = await db.query(
          'SELECT user_id, name FROM users WHERE role = ? AND subject_id = ? AND status = ?',
          ['subject_matter_expert', finalSubjectId, 'active']
        );

        if (existingSME.length > 0) {
          return res.status(400).json({ 
            success: false, 
            message: `This subject already has an active SME (${existingSME[0].name}). Only one SME is allowed per subject.`,
            existingSME: existingSME[0].name
          });
        }
      }
    }
    // ========== OLD COLLEGE-BASED SYSTEM ==========
    else {

    // Handle custom university
    if (custom_university && custom_university.trim()) {
      // Check if university already exists
      const [existingUni] = await db.query(
        'SELECT university_id FROM universities WHERE LOWER(university_name) = LOWER(?)',
        [custom_university.trim()]
      );

      if (existingUni.length > 0) {
        finalUniversityId = existingUni[0].university_id;
      } else {
        // Create new university
        const [uniResult] = await db.query(
          'INSERT INTO universities (university_name) VALUES (?)',
          [custom_university.trim()]
        );
        finalUniversityId = uniResult.insertId;
      }
    }

    // Handle custom college
    if (custom_college && custom_college.trim()) {
      // Check if college already exists
      const [existingCollege] = await db.query(
        'SELECT college_id FROM colleges WHERE LOWER(college_name) = LOWER(?) AND university_id = ?',
        [custom_college.trim(), finalUniversityId]
      );

      if (existingCollege.length > 0) {
        finalCollegeId = existingCollege[0].college_id;
      } else {
        // Create new college with trial subscription
        const [collegeResult] = await db.query(
          'INSERT INTO colleges (college_name, university_id, subscription_status) VALUES (?, ?, ?)',
          [custom_college.trim(), finalUniversityId, 'trial']
        );
        finalCollegeId = collegeResult.insertId;
      }
    }

    // Moderator, Examiner, and Subject Matter Expert must have college_id
    if ((role === 'moderator' || role === 'examiner' || role === 'subject_matter_expert') && !finalCollegeId) {
      return res.status(400).json({ success: false, message: 'college_id or custom_college required for this role' });
    }

    let finalDepartmentId = department_id;

    // Handle custom department
    if ((role === 'examiner' || role === 'subject_matter_expert') && custom_department && custom_department.trim()) {
      // Check if department already exists in this college
      const [existingDept] = await db.query(
        'SELECT department_id FROM departments WHERE LOWER(department_name) = LOWER(?) AND college_id = ?',
        [custom_department.trim(), finalCollegeId]
      );

      if (existingDept.length > 0) {
        finalDepartmentId = existingDept[0].department_id;

        // If Subject Matter Expert role, check if this department already has one
        if (role === 'subject_matter_expert') {
          const [existingHod] = await db.query(
            'SELECT user_id FROM users WHERE role = ? AND department_id = ? AND college_id = ? AND status != ?',
            ['subject_matter_expert', finalDepartmentId, finalCollegeId, 'rejected']
          );

          if (existingHod.length > 0) {
            return res.status(400).json({ success: false, message: 'This department already has a Subject Matter Expert assigned' });
          }
        }
      } else {
        // Create new department with auto-generated code
        // Generate department code from first 3-4 letters of department name
        const deptCode = custom_department.trim()
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, '')
          .substring(0, 4) || 'DEPT';

        // Check if code exists, if so append a number
        let finalDeptCode = deptCode;
        let counter = 1;
        while (true) {
          const [codeCheck] = await db.query(
            'SELECT department_id FROM departments WHERE department_code = ? AND college_id = ?',
            [finalDeptCode, finalCollegeId]
          );
          if (codeCheck.length === 0) break;
          finalDeptCode = `${deptCode}${counter}`;
          counter++;
        }

        const [deptResult] = await db.query(
          'INSERT INTO departments (department_name, department_code, college_id) VALUES (?, ?, ?)',
          [custom_department.trim(), finalDeptCode, finalCollegeId]
        );
        finalDepartmentId = deptResult.insertId;
      }
    }

    // Examiner and Subject Matter Expert must have department_id
    if ((role === 'examiner' || role === 'subject_matter_expert') && !finalDepartmentId) {
      return res.status(400).json({ success: false, message: 'department_id or custom_department required for Examiner and Subject Matter Expert roles' });
    }

    // Check if Subject Matter Expert already exists for this department (for non-custom departments)
    if (role === 'subject_matter_expert' && finalDepartmentId && !custom_department) {
      const [existingHod] = await db.query(
        'SELECT user_id FROM users WHERE role = ? AND department_id = ? AND college_id = ? AND status != ?',
        ['subject_matter_expert', finalDepartmentId, finalCollegeId, 'rejected']
      );

      if (existingHod.length > 0) {
        return res.status(400).json({ success: false, message: 'This department already has a Subject Matter Expert assigned' });
      }

      // Also check if department's hod_user_id is set
      const [dept] = await db.query(
        'SELECT hod_user_id FROM departments WHERE department_id = ? AND college_id = ?',
        [finalDepartmentId, finalCollegeId]
      );

      if (dept.length > 0 && dept[0].hod_user_id) {
        return res.status(400).json({ success: false, message: 'This department already has a Subject Matter Expert assigned' });
      }
    }

    // Check if user exists
    const [existing] = await db.query('SELECT user_id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: 'User already exists' });
    }

    } // End of OLD system check

    // Check if user exists
    const [existing] = await db.query('SELECT user_id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: 'User already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Examiner self-registration goes to 'pending' status (for SME approval)
    // Moderator and Subject Matter Expert self-registration goes to 'pending' status (for Moderator approval)
    const userStatus = (role === 'examiner' || role === 'moderator' || role === 'subject_matter_expert') ? 'pending' : 'active';

    // Insert user with BOTH old and new system fields
    const [result] = await db.query(
      `INSERT INTO users (
        name, email, password, role, status,
        college_id, university_id, department_id,
        subject_id, phone, qualification, years_of_experience, institution_name, specialization
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name, email, hashedPassword, role, userStatus,
        finalCollegeId || null, finalUniversityId || null, finalDepartmentId || null,
        finalSubjectId || null, phone || null, qualification || null, 
        years_of_experience || null, institution_name || null, specialization || null
      ]
    );

    // Log audit
    await logAudit(result.insertId, finalCollegeId, 'USER_REGISTERED', 'user', result.insertId, `Role: ${role}, Status: ${userStatus}, Subject: ${finalSubjectId}`, req.ip);

    // If pending, don't generate token yet
    if (userStatus === 'pending') {
      let approvalMsg = 'Registration submitted successfully! ';
      if (role === 'examiner') {
        approvalMsg += 'Your account is pending Subject Matter Expert approval.';
      } else if (role === 'subject_matter_expert') {
        approvalMsg += 'Your account is pending Moderator approval.';
      } else if (role === 'moderator') {
        approvalMsg += 'Your account is pending Super Admin approval.';
      }
      if (custom_university || custom_college || custom_department || custom_subject_name) {
        approvalMsg += ' New institution/department/subject has been created.';
      }
      return res.status(201).json({
        success: true,
        message: approvalMsg,
        user: { user_id: result.insertId, name, email, role, status: 'pending' }
      });
    }

    // Generate token for active users
    const token = jwt.sign(
      { 
        user_id: result.insertId, name, email, role, 
        college_id: finalCollegeId, university_id: finalUniversityId,
        subject_id: finalSubjectId,
        department: null  // New users don't have department by default
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      success: true,
      token,
      user: { 
        user_id: result.insertId, name, email, role, 
        college_id: finalCollegeId, university_id: finalUniversityId,
        subject_id: finalSubjectId
      }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password, twoFactorCode } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }

    // Find user with college and subject info
    const [users] = await db.query(
      `SELECT u.*, 
       c.college_name, c.status as college_status, c.subscription_status,
       s.subject_name, s.subject_code
       FROM users u 
       LEFT JOIN colleges c ON u.college_id = c.college_id 
       LEFT JOIN subjects s ON u.subject_id = s.subject_id
       WHERE u.email = ?`,
      [email]
    );

    if (users.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const user = users[0];

    // Check if user is active
    if (user.status === 'pending') {
      let approvalMsg = 'Your account is pending approval. ';
      if (user.role === 'examiner') {
        approvalMsg += 'Please wait for Subject Matter Expert approval.';
      } else if (user.role === 'subject_matter_expert') {
        approvalMsg += 'Please wait for Moderator approval.';
      } else if (user.role === 'moderator') {
        approvalMsg += 'Please wait for Super Admin approval.';
      }
      return res.status(403).json({ success: false, message: approvalMsg });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Account is inactive or suspended' });
    }

    // Check college subscription (except super_admin and subject-based users)
    if (user.role !== 'super_admin' && user.college_id) {
      // Only check college status if user is part of old college-based system
      if (user.college_status !== 'active') {
        return res.status(403).json({ success: false, message: 'College account is inactive' });
      }
      if (user.subscription_status === 'expired' || user.subscription_status === 'cancelled') {
        return res.status(403).json({ success: false, message: 'College subscription has expired' });
      }
    }

    // Check password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Check 2FA if enabled
    if (user.two_factor_enabled) {
      if (!twoFactorCode) {
        return res.status(200).json({
          success: false,
          requires2FA: true,
          message: 'Two-factor authentication code required'
        });
      }

      const verified = speakeasy.totp.verify({
        secret: user.two_factor_secret,
        encoding: 'base32',
        token: twoFactorCode,
        window: 2
      });

      if (!verified) {
        return res.status(401).json({ success: false, message: 'Invalid 2FA code' });
      }
    }

    // Update last login time
    await db.query(
      'UPDATE users SET last_login = NOW() WHERE user_id = ?',
      [user.user_id]
    );

    // Log audit
    await logAudit(user.user_id, user.college_id, 'USER_LOGIN', 'user', user.user_id, null, req.ip);

    // Generate token
    const token = jwt.sign(
      {
        user_id: user.user_id,
        name: user.name,
        email: user.email,
        role: user.role,
        college_id: user.college_id,
        university_id: user.university_id,
        subject_id: user.subject_id,
        department: user.department
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        user_id: user.user_id,
        name: user.name,
        email: user.email,
        role: user.role,
        college_id: user.college_id,
        university_id: user.university_id,
        subject_id: user.subject_id,
        college_name: user.college_name,
        subject_name: user.subject_name,
        department: user.department,
        two_factor_enabled: user.two_factor_enabled
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Setup 2FA - Generate QR code
router.post('/2fa/setup', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.user_id;

    // Generate secret
    const secret = speakeasy.generateSecret({
      name: `Question Generator (${req.user.email})`,
      length: 32
    });

    // Save secret to database (but don't enable yet)
    await db.query(
      'UPDATE users SET two_factor_secret = ? WHERE user_id = ?',
      [secret.base32, userId]
    );

    // Generate QR code
    const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);

    res.json({
      success: true,
      secret: secret.base32,
      qrCode: qrCodeUrl
    });
  } catch (err) {
    console.error('2FA setup error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Verify and enable 2FA
router.post('/2fa/verify', authMiddleware, async (req, res) => {
  try {
    const { token } = req.body;
    const userId = req.user.user_id;

    if (!token) {
      return res.status(400).json({ success: false, message: 'Token required' });
    }

    // Get user's secret
    const [users] = await db.query(
      'SELECT two_factor_secret FROM users WHERE user_id = ?',
      [userId]
    );

    if (users.length === 0 || !users[0].two_factor_secret) {
      return res.status(400).json({ success: false, message: 'Please setup 2FA first' });
    }

    // Verify token
    const verified = speakeasy.totp.verify({
      secret: users[0].two_factor_secret,
      encoding: 'base32',
      token: token,
      window: 2
    });

    if (!verified) {
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }

    // Enable 2FA
    await db.query(
      'UPDATE users SET two_factor_enabled = TRUE WHERE user_id = ?',
      [userId]
    );

    await logAudit(userId, req.user.college_id, '2FA_ENABLED', 'user', userId, null, req.ip);

    res.json({
      success: true,
      message: '2FA enabled successfully'
    });
  } catch (err) {
    console.error('2FA verify error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Disable 2FA
router.post('/2fa/disable', authMiddleware, async (req, res) => {
  try {
    const { password } = req.body;
    const userId = req.user.user_id;

    if (!password) {
      return res.status(400).json({ success: false, message: 'Password required' });
    }

    // Get user
    const [users] = await db.query(
      'SELECT password FROM users WHERE user_id = ?',
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Verify password
    const isMatch = await bcrypt.compare(password, users[0].password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid password' });
    }

    // Disable 2FA
    await db.query(
      'UPDATE users SET two_factor_enabled = FALSE, two_factor_secret = NULL WHERE user_id = ?',
      [userId]
    );

    await logAudit(userId, req.user.college_id, '2FA_DISABLED', 'user', userId, null, req.ip);

    res.json({
      success: true,
      message: '2FA disabled successfully'
    });
  } catch (err) {
    console.error('2FA disable error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get 2FA status
router.get('/2fa/status', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.user_id;

    const [users] = await db.query(
      'SELECT two_factor_enabled FROM users WHERE user_id = ?',
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({
      success: true,
      enabled: users[0].two_factor_enabled
    });
  } catch (err) {
    console.error('2FA status error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get user profile
router.get('/profile', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.user_id;

    const [users] = await db.query(
      `SELECT u.user_id, u.name, u.email, u.role, u.phone, u.bio, u.department, u.designation, 
       u.experience, u.specialization, u.address, u.city, u.state, u.country, u.pincode, 
       u.college_id, u.university_id, u.status, u.created_at, u.last_login,
       c.college_name,
       d.department_name,
       uni.university_name
       FROM users u
       LEFT JOIN colleges c ON u.college_id = c.college_id
       LEFT JOIN departments d ON u.department_id = d.department_id
       LEFT JOIN universities uni ON u.university_id = uni.university_id
       WHERE u.user_id = ?`,
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({
      success: true,
      user: users[0]
    });
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Update user profile
router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const {
      name, phone, bio, department, designation, experience,
      specialization, address, city, state, country, pincode
    } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }

    // Convert empty strings to NULL for integer fields
    const experienceValue = experience === '' || experience === null || experience === undefined ? null : parseInt(experience);
    const pincodeValue = pincode === '' || pincode === null || pincode === undefined ? null : pincode;

    await db.query(
      `UPDATE users SET 
       name = ?, phone = ?, bio = ?, department = ?, designation = ?,
       experience = ?, specialization = ?, address = ?, city = ?, 
       state = ?, country = ?, pincode = ?
       WHERE user_id = ?`,
      [name, phone, bio, department, designation, experienceValue,
        specialization, address, city, state, country, pincodeValue, userId]
    );

    await logAudit(userId, req.user.college_id, 'PROFILE_UPDATED', 'user', userId, null, req.ip);

    res.json({
      success: true,
      message: 'Profile updated successfully'
    });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Change password
router.put('/change-password', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Current and new password required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    // Get current password
    const [users] = await db.query(
      'SELECT password FROM users WHERE user_id = ?',
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, users[0].password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password
    await db.query(
      'UPDATE users SET password = ? WHERE user_id = ?',
      [hashedPassword, userId]
    );

    await logAudit(userId, req.user.college_id, 'PASSWORD_CHANGED', 'user', userId, null, req.ip);

    res.json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get profile stats
router.get('/profile/stats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const role = req.user.role;

    let stats = {
      totalPapers: 0,
      totalQuestions: 0,
      pendingApprovals: 0,
      completedPapers: 0
    };

    if (role === 'examiner' || role === 'subject_matter_expert') {
      // Get papers created by examiner/SME
      const [papers] = await db.query(
        'SELECT COUNT(*) as count FROM question_papers WHERE generated_by = ?',
        [userId]
      );
      stats.totalPapers = papers[0].count;

      // Get questions created by examiner/SME
      const [questions] = await db.query(
        'SELECT COUNT(*) as count FROM questions WHERE created_by = ?',
        [userId]
      );
      stats.totalQuestions = questions[0].count;

      // Get pending papers
      const [pending] = await db.query(
        'SELECT COUNT(*) as count FROM question_papers WHERE generated_by = ? AND status = ?',
        [userId, 'pending']
      );
      stats.pendingApprovals = pending[0].count;

      // Get completed papers
      const [completed] = await db.query(
        'SELECT COUNT(*) as count FROM question_papers WHERE generated_by = ? AND status = ?',
        [userId, 'approved']
      );
      stats.completedPapers = completed[0].count;
    } else if (role === 'moderator') {
      // Get papers in moderator's college
      const [papers] = await db.query(
        'SELECT COUNT(*) as count FROM question_papers WHERE college_id = ?',
        [req.user.college_id]
      );
      stats.totalPapers = papers[0].count;

      // Get questions in admin's college
      const [questions] = await db.query(
        `SELECT COUNT(*) as count FROM questions q 
         JOIN question_papers qp ON q.paper_id = qp.paper_id 
         WHERE qp.college_id = ?`,
        [req.user.college_id]
      );
      stats.totalQuestions = questions[0].count;

      // Get pending users
      const [pending] = await db.query(
        'SELECT COUNT(*) as count FROM users WHERE college_id = ? AND status = ?',
        [req.user.college_id, 'pending']
      );
      stats.pendingApprovals = pending[0].count;

      // Get active users
      const [active] = await db.query(
        'SELECT COUNT(*) as count FROM users WHERE college_id = ? AND status = ?',
        [req.user.college_id, 'active']
      );
      stats.completedPapers = active[0].count;
    } else if (role === 'super_admin') {
      // Get all papers
      const [papers] = await db.query('SELECT COUNT(*) as count FROM question_papers');
      stats.totalPapers = papers[0].count;

      // Get all questions
      const [questions] = await db.query('SELECT COUNT(*) as count FROM questions');
      stats.totalQuestions = questions[0].count;

      // Get pending colleges
      const [pending] = await db.query(
        'SELECT COUNT(*) as count FROM colleges WHERE status = ?',
        ['pending']
      );
      stats.pendingApprovals = pending[0].count;

      // Get active colleges
      const [active] = await db.query(
        'SELECT COUNT(*) as count FROM colleges WHERE status = ?',
        ['active']
      );
      stats.completedPapers = active[0].count;
    }

    res.json({
      success: true,
      stats
    });
  } catch (err) {
    console.error('Get profile stats error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
