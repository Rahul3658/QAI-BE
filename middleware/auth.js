// backend/middleware/auth.js
const jwt = require('jsonwebtoken');

// Basic authentication
const authMiddleware = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { user_id, name, email, role, college_id, university_id }
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

// Role-based access control
const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    next();
  };
};

// College isolation middleware
const requireCollegeAccess = (req, res, next) => {
  if (req.user.role === 'super_admin') {
    // Super admin can access all colleges for management, but not data
    return next();
  }

  // College Admin and Faculty must have college_id
  if (!req.user.college_id) {
    return res.status(403).json({ success: false, message: 'No college access' });
  }

  next();
};

// Ensure data isolation by college_id
const enforceCollegeIsolation = (req, res, next) => {
  if (req.user.role === 'super_admin') {
    return res.status(403).json({ success: false, message: 'Super Admin cannot access college data' });
  }

  // Attach college_id to request for query filtering
  req.college_id = req.user.college_id;
  next();
};

// Super Admin only middleware
const superAdminOnly = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ success: false, message: 'Super Admin access required' });
  }

  next();
};

// EduLab Admin only middleware (Super Admin from EduLab department)
const requireEduLabAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  if (req.user.role !== 'super_admin') {
    console.warn(`⚠️ Unauthorized EduLab access attempt: user_id=${req.user.user_id}, role=${req.user.role}`);
    return res.status(403).json({ success: false, message: 'Super Admin access required' });
  }

  if (req.user.department?.toLowerCase() !== 'edulab') {
    console.warn(`⚠️ Unauthorized EduLab access attempt: user_id=${req.user.user_id}, department=${req.user.department || 'none'}`);
    return res.status(403).json({ success: false, message: 'EduLab department access required' });
  }

  next();
};

module.exports = {
  authMiddleware,
  requireRole,
  requireCollegeAccess,
  enforceCollegeIsolation,
  superAdminOnly,
  requireEduLabAdmin
};
