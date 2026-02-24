// backend/routes/auth-subject-based.js
// Updated auth route to support SUBJECT-BASED registration
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

// Register - SUBJECT-BASED SYSTEM
router.post('/register', async (req, res) => {
  try {
    const { 
      name, email, password, role, phone,
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

    let finalSubjectId = subject_id;

    // Handle custom subject creation
    if (custom_subject_name && custom_subject_name.trim()) {
      const inputName = custom_subject_name.trim().toLowerCase();
      
      // Get all existing subjects to check for similar names
      const [allSubjects] = await db.query(
        'SELECT subject_id, subject_name, subject_code, moderator_user_id FROM subjects WHERE status = "active"'
      );
      
      // Function to check if two subject names are similar
      const areSubjectsSimilar = (name1, name2) => {
        const n1 = name1.toLowerCase().replace(/[^a-z]/g, '');
        const n2 = name2.toLowerCase().replace(/[^a-z]/g, '');
        
        // Direct match
        if (n1 === n2) return true;
        
        // Common abbreviations and variations
        const mathVariations = ['math', 'maths', 'mathematics', 'mathematic'];
        const physicsVariations = ['physics', 'phy', 'phys'];
        const chemistryVariations = ['chemistry', 'chem', 'chemical'];
        const biologyVariations = ['biology', 'bio', 'biological'];
        const englishVariations = ['english', 'eng', 'englishliterature', 'literature'];
        const computerVariations = ['computerscience', 'cs', 'computer', 'computing'];
        const businessVariations = ['business', 'businessadministration', 'bus', 'management'];
        const economicsVariations = ['economics', 'econ', 'economy'];
        const historyVariations = ['history', 'hist', 'historical'];
        const psychologyVariations = ['psychology', 'psych', 'psy', 'psychological'];
        
        const allVariations = [
          mathVariations, physicsVariations, chemistryVariations, biologyVariations,
          englishVariations, computerVariations, businessVariations, economicsVariations,
          historyVariations, psychologyVariations
        ];
        
        // Check if both names belong to the same variation group
        for (const variations of allVariations) {
          if (variations.includes(n1) && variations.includes(n2)) {
            return true;
          }
        }
        
        return false;
      };
      
      // Check for exact name match first
      let existingSubject = allSubjects.find(s => 
        s.subject_name.toLowerCase() === inputName
      );
      
      // If no exact match, check for similar names
      if (!existingSubject) {
        existingSubject = allSubjects.find(s => 
          areSubjectsSimilar(s.subject_name, custom_subject_name.trim())
        );
        
        if (existingSubject) {
          return res.status(400).json({ 
            success: false, 
            message: `A similar subject "${existingSubject.subject_name}" already exists. Please select it from the dropdown or use a more specific name like "${custom_subject_name.trim()} - Advanced" or "${custom_subject_name.trim()} - Specialized".`
          });
        }
      }
      
      // Check if subject code already exists (if provided)
      let existingByCode = null;
      if (custom_subject_code && custom_subject_code.trim()) {
        existingByCode = allSubjects.find(s => 
          s.subject_code && s.subject_code.toLowerCase() === custom_subject_code.trim().toLowerCase()
        );
        
        if (existingByCode) {
          return res.status(400).json({ 
            success: false, 
            message: `The subject code "${custom_subject_code.trim()}" is already used by "${existingByCode.subject_name}". Please use a different subject code or select the existing subject from the dropdown.`
          });
        }
      }

      // If exact subject name exists, use existing subject
      if (existingSubject) {
        finalSubjectId = existingSubject.subject_id;
        
        // If user is trying to register as moderator for an existing subject,
        // check if that subject already has a moderator
        if (role === 'moderator' && existingSubject.moderator_user_id) {
          return res.status(400).json({ 
            success: false, 
            message: `The subject "${existingSubject.subject_name}" already exists and has a moderator assigned. Please select a different subject or choose from the available subjects in the dropdown.`
          });
        }
      }
      // Create new subject only if no similar subjects exist
      else {
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

    // Check if user exists
    const [existing] = await db.query('SELECT user_id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: 'User already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Set user status based on role
    // Examiner, SME, and Moderator self-registration goes to 'pending' status
    const userStatus = (role === 'examiner' || role === 'moderator' || role === 'subject_matter_expert') ? 'pending' : 'active';

    // Insert user with new fields
    const [result] = await db.query(
      `INSERT INTO users (
        name, email, password, role, subject_id, status,
        phone, qualification, years_of_experience, institution_name, specialization
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name, 
        email, 
        hashedPassword, 
        role, 
        finalSubjectId || null, 
        userStatus,
        phone || null,
        qualification || null,
        years_of_experience || null,
        institution_name || null,
        specialization || null
      ]
    );

    // Log audit
    await logAudit(result.insertId, null, 'USER_REGISTERED', 'user', result.insertId, `Role: ${role}, Status: ${userStatus}, Subject: ${finalSubjectId}`, req.ip);

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
      if (custom_subject_name) {
        approvalMsg += ' New subject has been created.';
      }
      return res.status(201).json({
        success: true,
        message: approvalMsg,
        user: { user_id: result.insertId, name, email, role, status: 'pending' }
      });
    }

    // Generate token for active users
    const token = jwt.sign(
      { user_id: result.insertId, name, email, role, subject_id: finalSubjectId, department: null },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      success: true,
      token,
      user: { user_id: result.insertId, name, email, role, subject_id: finalSubjectId }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Login - Updated for subject-based system
router.post('/login', async (req, res) => {
  try {
    const { email, password, twoFactorCode } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }

    // Find user with subject info
    const [users] = await db.query(
      `SELECT u.*, s.subject_name, s.subject_code
       FROM users u 
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
    await logAudit(user.user_id, null, 'USER_LOGIN', 'user', user.user_id, null, req.ip);

    // Generate token
    const token = jwt.sign(
      {
        user_id: user.user_id,
        name: user.name,
        email: user.email,
        role: user.role,
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
        subject_id: user.subject_id,
        subject_name: user.subject_name,
        two_factor_enabled: user.two_factor_enabled
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get user profile - Updated for subject-based system
router.get('/profile', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.user_id;

    const [users] = await db.query(
      `SELECT u.user_id, u.name, u.email, u.role, u.phone, u.bio, 
       u.qualification, u.years_of_experience, u.institution_name, u.specialization,
       u.designation, u.experience, u.address, u.city, u.state, u.country, u.pincode, 
       u.subject_id, u.status, u.created_at, u.last_login,
       s.subject_name, s.subject_code
       FROM users u
       LEFT JOIN subjects s ON u.subject_id = s.subject_id
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

// ... (Keep all other routes from original auth.js: 2FA setup, verify, disable, update profile, change password, profile stats)

module.exports = router;
