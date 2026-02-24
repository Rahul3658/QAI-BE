// backend/routes/admins.js
const express = require('express');
const { authMiddleware, requireRole } = require('../middleware/auth');
const db = require('../config/db');

const router = express.Router();

// Super Admin: Get all pending college admins
router.get('/pending', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    const [admins] = await db.query(
      `SELECT u.*, c.college_name, uni.university_name 
       FROM users u
       LEFT JOIN colleges c ON u.college_id = c.college_id
       LEFT JOIN universities uni ON u.university_id = uni.university_id
       WHERE u.role = ? AND u.status = ?
       ORDER BY u.created_at DESC`,
      ['moderator', 'pending']
    );

    res.json({ success: true, pending_admins: admins });
  } catch (err) {
    console.error('Get pending admins error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Super Admin: Get all college admins
router.get('/', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    const [admins] = await db.query(
      `SELECT u.*, c.college_name, uni.university_name 
       FROM users u
       LEFT JOIN colleges c ON u.college_id = c.college_id
       LEFT JOIN universities uni ON u.university_id = uni.university_id
       WHERE u.role = ?
       ORDER BY u.created_at DESC`,
      ['moderator']
    );

    res.json({ success: true, admins });
  } catch (err) {
    console.error('Get admins error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Super Admin: Approve/Reject college admin
// Super Admin: Approve/Reject college admin
router.put('/:id/approve', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { action, force } = req.body; // ✅ Add 'force' flag for confirmation

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Invalid action' });
    }

    // 1️⃣ Check if pending admin exists
    const [admins] = await db.query(
      'SELECT user_id, name, email, college_id, subject_id FROM users WHERE user_id = ? AND role = ? AND status = ?',
      [id, 'moderator', 'pending']
    );

    if (admins.length === 0) {
      return res.status(404).json({ success: false, message: 'Pending admin not found' });
    }

    const { college_id, subject_id } = admins[0];

    // 2️⃣ Check if a moderator already exists for this subject (subject-based system) or college (old system)
    if (action === 'approve' && !force) {
      let existingMods;
      
      if (subject_id) {
        // NEW: Subject-based system - check for existing moderator in this subject
        [existingMods] = await db.query(
          `SELECT user_id, name FROM users 
           WHERE subject_id = ? 
           AND role = 'moderator' 
           AND status IN ('active', 'inactive')
           AND user_id != ?`,
          [subject_id, id]
        );

        // Also check if subject already has a moderator assigned
        const [subjects] = await db.query(
          'SELECT moderator_user_id FROM subjects WHERE subject_id = ?',
          [subject_id]
        );

        if (existingMods.length > 0 || (subjects.length > 0 && subjects[0].moderator_user_id)) {
          const existingModName = existingMods.length > 0 ? existingMods[0].name : 'Unknown';
          return res.status(400).json({
            success: false,
            message: `A moderator already exists for this subject: ${existingModName}. Only one moderator is allowed per subject.`,
            existingModerator: existingModName
          });
        }
      } else {
        // OLD: College-based system
        [existingMods] = await db.query(
          `SELECT COUNT(*) AS count 
           FROM users 
           WHERE college_id = ? 
           AND role = 'moderator' 
           AND status IN ('active', 'inactive')`,
          [college_id]
        );

        console.log("Existing moderator count:", existingMods[0].count);

        if (existingMods[0].count > 0) {
          return res.json({
            success: false,
            warning: true,
            message: 'A moderator already exists for this college. Confirm to approve another.'
          });
        }
      }
    }

    // 3️⃣ Perform action
    if (action === 'approve') {
      await db.query('UPDATE users SET status = ? WHERE user_id = ?', ['active', id]);
      
      // If subject-based system, assign moderator to subject
      if (subject_id) {
        await db.query(
          'UPDATE subjects SET moderator_user_id = ? WHERE subject_id = ?',
          [id, subject_id]
        );
      }
      
      res.json({ success: true, message: subject_id ? 'Moderator approved and assigned to subject successfully' : 'College Admin approved successfully' });
    } else {
      await db.query('DELETE FROM users WHERE user_id = ?', [id]);
      res.json({ success: true, message: 'Registration rejected' });
    }
  } catch (err) {
    console.error('Approve admin error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Super Admin: Update college admin status
router.put('/:id/status', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['active', 'inactive', 'suspended'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    await db.query(
      'UPDATE users SET status = ? WHERE user_id = ? AND role = ?',
      [status, id, 'moderator']
    );

    res.json({ success: true, message: 'College Admin status updated' });
  } catch (err) {
    console.error('Update admin error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});
// Super Admin: Get universities and colleges list (lightweight)
router.get('/reports/filters', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    // Get all universities
    const [universities] = await db.query(
      'SELECT university_id, university_name FROM universities ORDER BY university_name'
    );

    // Get all colleges with counts
    const [colleges] = await db.query(
      `SELECT 
        c.college_id, 
        c.college_name, 
        c.university_id,
        (SELECT COUNT(*) FROM users WHERE college_id = c.college_id AND role IN ('examiner', 'moderator', 'subject_matter_expert') AND status IN ('active', 'inactive')) as faculty_count
       FROM colleges c 
       ORDER BY c.college_name`
    );

    // Get system-wide totals
    const [totals] = await db.query(
      `SELECT 
        (SELECT COUNT(*) FROM users WHERE role = 'examiner' AND status IN ('active', 'inactive')) as total_examiners,
        (SELECT COUNT(*) FROM users WHERE role = 'moderator' AND status IN ('active', 'inactive')) as total_moderators,
        (SELECT COUNT(*) FROM users WHERE role = 'subject_matter_expert' AND status IN ('active', 'inactive')) as total_smes,
        (SELECT COUNT(*) FROM question_papers) as total_papers,
        (SELECT COUNT(*) FROM sme_selections) as total_selections,
        (SELECT COUNT(*) FROM question_papers WHERE status IN ('finalized', 'approved')) as total_finalizations`
    );

    res.json({
      success: true,
      universities,
      colleges,
      summary: totals[0]
    });
  } catch (err) {
    console.error('Get filters error:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
});

// Super Admin: Get detailed reports for a specific college
router.get('/reports/college/:collegeId', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    const { collegeId } = req.params;

    // Get college info
    const [colleges] = await db.query(
      `SELECT c.*, u.university_name 
       FROM colleges c
       LEFT JOIN universities u ON c.university_id = u.university_id
       WHERE c.college_id = ?`,
      [collegeId]
    );

    if (colleges.length === 0) {
      return res.status(404).json({ success: false, message: 'College not found' });
    }

    const college = colleges[0];

    // Get all users for this specific college with paper counts
    const [users] = await db.query(
      `SELECT 
        u.user_id,
        u.name,
        u.email,
        u.role,
        u.status,
        u.created_at,
        
        -- Count papers created by examiners
        (SELECT COUNT(*) 
         FROM question_papers qp 
         WHERE qp.generated_by = u.user_id 
         AND u.role = 'examiner') as papers_created,
        
        -- Count papers selected by SMEs
        (SELECT COUNT(*) 
         FROM sme_selections ss 
         WHERE ss.sme_id = u.user_id 
         AND u.role = 'subject_matter_expert') as papers_selected,
        
        -- Count papers finalized by moderators
        (SELECT COUNT(*) 
         FROM moderator_categorizations mc 
         WHERE mc.moderator_id = u.user_id 
         AND u.role = 'moderator') as papers_finalized
        
       FROM users u
       WHERE u.college_id = ?
       AND u.role IN ('examiner', 'moderator', 'subject_matter_expert')
       AND u.status IN ('active', 'inactive')
       ORDER BY u.role, u.name`,
      [collegeId]
    );

    // Get detailed paper information for examiners in this college
    const [examinerPapers] = await db.query(
      `SELECT 
        qp.paper_id,
        qp.paper_title,
        qp.generated_by,
        qp.status,
        qp.created_at,
        qp.total_marks,
        pgr.subject,
        pgr.topic
       FROM question_papers qp
       LEFT JOIN paper_generation_requests pgr ON qp.parent_request_id = pgr.request_id
       WHERE qp.college_id = ?
       ORDER BY qp.created_at DESC`,
      [collegeId]
    );

    // Get detailed selection information for SMEs in this college
    const [smeSelections] = await db.query(
      `SELECT 
        ss.selection_id,
        ss.sme_id as selected_by,
        ss.selected_at,
        ss.selection_reason,
        qp.paper_id,
        qp.paper_title,
        pgr.subject,
        pgr.topic
       FROM sme_selections ss
       JOIN question_papers qp ON ss.paper_id = qp.paper_id
       LEFT JOIN paper_generation_requests pgr ON qp.parent_request_id = pgr.request_id
       WHERE qp.college_id = ?
       ORDER BY ss.selected_at DESC`,
      [collegeId]
    );

    // Get detailed finalization information for each moderator
    // Get papers with status 'finalized' or 'approved' from question_papers table
    const [moderatorFinalizations] = await db.query(
      `SELECT 
        qp.paper_id,
        qp.paper_title,
        qp.college_id,
        qp.updated_at as finalized_at,
        qp.status,
        qp.generated_by,
        COALESCE(mc.moderator_id, qp.generated_by) as categorized_by,
        mc.category as paper_category,
        mc.notes as moderator_notes,
        pgr.subject,
        pgr.topic
       FROM question_papers qp
       LEFT JOIN moderator_categorizations mc ON qp.paper_id = mc.paper_id
       LEFT JOIN paper_generation_requests pgr ON qp.parent_request_id = pgr.request_id
       WHERE qp.college_id = ? AND qp.status IN ('finalized', 'approved')
       ORDER BY qp.updated_at DESC`,
      [collegeId]
    );

    // Attach paper details to each user
    const usersWithDetails = users.map(user => {
      const userObj = { ...user };

      if (user.role === 'examiner') {
        userObj.paper_details = examinerPapers.filter(p => p.generated_by === user.user_id);
      } else if (user.role === 'subject_matter_expert') {
        userObj.selection_details = smeSelections.filter(s => s.selected_by === user.user_id);
      } else if (user.role === 'moderator') {
        userObj.finalization_details = moderatorFinalizations.filter(f => f.categorized_by === user.user_id);
      }

      return userObj;
    });

    // Calculate summary statistics
    const summary = {
      total_examiners: users.filter(u => u.role === 'examiner').length,
      total_moderators: users.filter(u => u.role === 'moderator').length,
      total_smes: users.filter(u => u.role === 'subject_matter_expert').length,
      total_papers: examinerPapers.length,
      total_selections: smeSelections.length,
      total_finalizations: moderatorFinalizations.length
    };

    res.json({
      success: true,
      college,
      users: usersWithDetails,
      summary
    });

  } catch (err) {
    console.error('Get comprehensive reports error:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
});

module.exports = router;
