const express = require('express');
const db = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

// Helper function to check if user is admin (super_admin, CET admin, or EduLab admin)
const isAdmin = (user) => {
  if (user.role !== 'super_admin') return false;
  
  // Super admin from CET or EduLab department is considered admin
  const department = user.department?.toLowerCase();
  return department === 'cet' || department === 'edulab';
};

// Get all templates for the examiner (own + public templates from others)
// Admins can also see all templates for approval
router.get('/', authMiddleware, requireRole('examiner', 'super_admin'), async (req, res) => {
  try {
    const userId = req.user.user_id;
    const userRole = req.user.role;
    
    // Get global template visibility setting
    const [settings] = await db.query(
      `SELECT setting_value FROM system_settings WHERE setting_key = 'template_visibility_enabled'`
    );
    const templateVisibilityEnabled = settings.length > 0 && settings[0].setting_value === 'true';
    
    let query, params;
    
    if (isAdmin(req.user)) {
      // Admins see all templates (for management)
      query = `SELECT pt.*, u.name as created_by_name FROM paper_templates pt
               LEFT JOIN users u ON pt.created_by = u.user_id
               ORDER BY pt.is_default DESC, pt.created_at DESC`;
      params = [];
    } else if (templateVisibilityEnabled) {
      // When visibility is ON: all examiners see all templates
      query = `SELECT pt.*, u.name as created_by_name FROM paper_templates pt
               LEFT JOIN users u ON pt.created_by = u.user_id
               ORDER BY pt.is_default DESC, pt.created_at DESC`;
      params = [];
    } else {
      // When visibility is OFF: examiners see only their own templates
      query = `SELECT pt.*, u.name as created_by_name FROM paper_templates pt
               LEFT JOIN users u ON pt.created_by = u.user_id
               WHERE pt.created_by = ?
               ORDER BY pt.is_default DESC, pt.created_at DESC`;
      params = [userId];
    }
    
    const [templates] = await db.query(query, params);

    res.json({ success: true, templates });
  } catch (err) {
    console.error('Get templates error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get template details with questions
router.get('/:templateId', authMiddleware, requireRole('examiner', 'super_admin'), async (req, res) => {
  try {
    const { templateId } = req.params;
    const userId = req.user.user_id;

    // Get global template visibility setting
    const [settings] = await db.query(
      `SELECT setting_value FROM system_settings WHERE setting_key = 'template_visibility_enabled'`
    );
    const templateVisibilityEnabled = settings.length > 0 && settings[0].setting_value === 'true';

    // Build query based on visibility setting and user role
    let query, params;
    
    if (isAdmin(req.user)) {
      // Admins can view any template
      query = 'SELECT * FROM paper_templates WHERE template_id = ?';
      params = [templateId];
    } else if (templateVisibilityEnabled) {
      // When visibility is ON: all examiners can view any template
      query = 'SELECT * FROM paper_templates WHERE template_id = ?';
      params = [templateId];
    } else {
      // When visibility is OFF: examiners can only view their own or public templates
      query = 'SELECT * FROM paper_templates WHERE template_id = ? AND (created_by = ? OR is_public = TRUE)';
      params = [templateId, userId];
    }

    const [templates] = await db.query(query, params);

    if (templates.length === 0) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }

    const template = templates[0];
    
    // Parse questions from JSON (if it's a string)
    if (template.questions) {
      // If it's already an object/array (MySQL auto-parsed), use it directly
      if (typeof template.questions === 'string') {
        try {
          template.questions = JSON.parse(template.questions);
        } catch (e) {
          console.error('Failed to parse template questions:', e);
          template.questions = [];
        }
      }
      // If it's already an object, keep it as is
    } else {
      template.questions = [];
    }

    // Extract class_weightage from first question (if available)
    if (template.questions.length > 0 && template.questions[0].class_weightage) {
      template.class_weightage = template.questions[0].class_weightage;
    } else {
      template.class_weightage = { class_11: 50, class_12: 50 };
    }

    res.json({ 
      success: true, 
      template
    });
  } catch (err) {
    console.error('Get template error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Create new template
router.post('/', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { template_name, description, questions, class_weightage } = req.body;
    const userId = req.user.user_id;
    if (!template_name || !questions || questions.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Template name and questions are required' 
      });
    }

    // Calculate total marks (including sub-questions)
    const totalMarks = questions.reduce((sum, q) => {
      if (q.has_subquestions && q.subquestions) {
        return sum + q.subquestions.reduce((subSum, sq) => subSum + (parseInt(sq.marks) || 0), 0);
      }
      return sum + (parseInt(q.marks) || 0);
    }, 0);

    // Store class_weightage with questions
    const questionsWithClassWeightage = questions.map(q => ({
      ...q,
      class_weightage: class_weightage
    }));

    // Insert template with questions as JSON (class_level is stored inside questions array)
    const [result] = await db.query(
      `INSERT INTO paper_templates (created_by, template_name, description, total_marks, questions, question_count) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, template_name, description || '', totalMarks, JSON.stringify(questionsWithClassWeightage), questions.length]
    );

    const templateId = result.insertId;

    res.status(201).json({ 
      success: true, 
      message: 'Template created successfully',
      template_id: templateId
    });
  } catch (err) {
    console.error('Create template error:', err);
    res.status(500).json({ success: false, message: 'Failed to create template' });
  }
});

// Update template
router.put('/:templateId', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { templateId } = req.params;
    const { template_name, description, questions, class_weightage } = req.body;
    const userId = req.user.user_id;

    // Verify template belongs to user
    const [templates] = await db.query(
      'SELECT template_id FROM paper_templates WHERE template_id = ? AND created_by = ?',
      [templateId, userId]
    );

    if (templates.length === 0) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }

    // Calculate total marks (including sub-questions)
    const totalMarks = questions.reduce((sum, q) => {
      if (q.has_subquestions && q.subquestions) {
        return sum + q.subquestions.reduce((subSum, sq) => subSum + (parseInt(sq.marks) || 0), 0);
      }
      return sum + (parseInt(q.marks) || 0);
    }, 0);

    // Store class_weightage with questions
    const questionsWithClassWeightage = questions.map(q => ({
      ...q,
      class_weightage: class_weightage
    }));

    // Update template with questions as JSON (class_level is stored inside questions array)
    await db.query(
      `UPDATE paper_templates 
       SET template_name = ?, description = ?, total_marks = ?, questions = ?, question_count = ? 
       WHERE template_id = ?`,
      [template_name, description || '', totalMarks, JSON.stringify(questionsWithClassWeightage), questions.length, templateId]
    );

    res.json({ success: true, message: 'Template updated successfully' });
  } catch (err) {
    console.error('Update template error:', err);
    res.status(500).json({ success: false, message: 'Failed to update template' });
  }
});

// Check if template has papers using it
router.get('/:templateId/usage', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { templateId } = req.params;
    const userId = req.user.user_id;

    // Check if template_id column exists
    const [columns] = await db.query(
      `SHOW COLUMNS FROM question_papers LIKE 'template_id'`
    );

    if (columns.length === 0) {
      // Column doesn't exist yet, return no usage
      return res.json({ 
        success: true, 
        has_papers: false,
        paper_count: 0,
        draft_count: 0,
        confirmed_count: 0
      });
    }

    // Check if papers are using this template
    const [papers] = await db.query(
      `SELECT COUNT(*) as paper_count, 
              SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as draft_count,
              SUM(CASE WHEN status != 'draft' THEN 1 ELSE 0 END) as confirmed_count
       FROM question_papers 
       WHERE template_id = ? AND generated_by = ?`,
      [templateId, userId]
    );

    const usage = papers[0];
    
    // Get list of draft papers using this template
    const [draftPapers] = await db.query(
      `SELECT paper_id, paper_title, subject_id, status, created_at
       FROM question_papers 
       WHERE template_id = ? AND generated_by = ? AND status = 'draft'
       ORDER BY created_at DESC`,
      [templateId, userId]
    );
    
    res.json({ 
      success: true, 
      has_papers: usage.paper_count > 0,
      paper_count: usage.paper_count || 0,
      draft_count: usage.draft_count || 0,
      confirmed_count: usage.confirmed_count || 0,
      draft_papers: draftPapers || []
    });
  } catch (err) {
    console.error('Check template usage error:', err);
    res.status(500).json({ success: false, message: 'Failed to check template usage' });
  }
});

// Delete template
router.delete('/:templateId', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { templateId } = req.params;
    const userId = req.user.user_id;

    // Verify template belongs to user and is not default
    const [templates] = await db.query(
      'SELECT template_id, is_default FROM paper_templates WHERE template_id = ? AND created_by = ?',
      [templateId, userId]
    );

    if (templates.length === 0) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }

    if (templates[0].is_default) {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot delete default template' 
      });
    }

    // Check if template_id column exists
    const [columns] = await db.query(
      `SHOW COLUMNS FROM question_papers LIKE 'template_id'`
    );

    console.log('🔍 Checking template_id column:', columns.length > 0 ? 'EXISTS' : 'NOT EXISTS');

    // If column exists, check for draft papers
    if (columns.length > 0) {
      const [papers] = await db.query(
        `SELECT COUNT(*) as draft_count
         FROM question_papers 
         WHERE template_id = ? AND generated_by = ? AND status = 'draft'`,
        [templateId, userId]
      );

      console.log(`📊 Template ${templateId} has ${papers[0].draft_count} draft papers`);

      if (papers[0].draft_count > 0) {
        console.log(`❌ Blocking deletion - template has ${papers[0].draft_count} draft papers`);
        return res.status(400).json({ 
          success: false, 
          message: `Cannot delete template. It is being used by ${papers[0].draft_count} unconfirmed paper(s).`,
          has_draft_papers: true,
          draft_count: papers[0].draft_count
        });
      }
    } else {
      console.log('⚠️  template_id column does not exist - skipping draft check');
    }

    // Delete template (cascade will delete questions)
    await db.query('DELETE FROM paper_templates WHERE template_id = ?', [templateId]);

    res.json({ success: true, message: 'Template deleted successfully' });
  } catch (err) {
    console.error('Delete template error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete template' });
  }
});

// Set template as default
router.put('/:templateId/set-default', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { templateId } = req.params;
    const userId = req.user.user_id;

    // Verify template belongs to user
    const [templates] = await db.query(
      'SELECT template_id FROM paper_templates WHERE template_id = ? AND created_by = ?',
      [templateId, userId]
    );

    if (templates.length === 0) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }

    // Unset all defaults for this user
    await db.query(
      'UPDATE paper_templates SET is_default = FALSE WHERE created_by = ?',
      [userId]
    );

    // Set this template as default
    await db.query(
      'UPDATE paper_templates SET is_default = TRUE WHERE template_id = ?',
      [templateId]
    );

    res.json({ success: true, message: 'Default template updated' });
  } catch (err) {
    console.error('Set default template error:', err);
    res.status(500).json({ success: false, message: 'Failed to set default template' });
  }
});

// Toggle template visibility (public/private)
// Examiners can make their own templates public
// Admins can approve templates to make them public for all users
router.put('/:templateId/toggle-visibility', authMiddleware, requireRole('examiner', 'super_admin'), async (req, res) => {
  try {
    const { templateId } = req.params;
    const { is_public, is_admin_approved } = req.body;
    const userId = req.user.user_id;
    const userRole = req.user.role;

    // Get template
    const [templates] = await db.query(
      'SELECT template_id, is_public, is_admin_approved, created_by FROM paper_templates WHERE template_id = ?',
      [templateId]
    );

    if (templates.length === 0) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }

    const template = templates[0];

    // Check permissions
    if (isAdmin(req.user)) {
      // Admin can approve/disapprove templates for all users
      if (is_admin_approved !== undefined) {
        await db.query(
          'UPDATE paper_templates SET is_admin_approved = ?, is_public = ? WHERE template_id = ?',
          [is_admin_approved ? true : false, is_admin_approved ? true : false, templateId]
        );

        res.json({ 
          success: true, 
          message: `Template is now ${is_admin_approved ? 'approved and public' : 'unapproved'}`,
          is_admin_approved: is_admin_approved ? true : false,
          is_public: is_admin_approved ? true : false
        });
      } else {
        return res.status(400).json({ success: false, message: 'Admin must specify is_admin_approved' });
      }
    } else {
      // Regular examiner can only toggle their own templates
      if (template.created_by !== userId) {
        return res.status(403).json({ success: false, message: 'You can only modify your own templates' });
      }

      // Examiner can only toggle is_public (not admin-approved)
      if (is_public !== undefined) {
        await db.query(
          'UPDATE paper_templates SET is_public = ? WHERE template_id = ?',
          [is_public ? true : false, templateId]
        );

        res.json({ 
          success: true, 
          message: `Template is now ${is_public ? 'public' : 'private'}`,
          is_public: is_public ? true : false
        });
      } else {
        return res.status(400).json({ success: false, message: 'Must specify is_public' });
      }
    }
  } catch (err) {
    console.error('Toggle template visibility error:', err);
    res.status(500).json({ success: false, message: 'Failed to update template visibility' });
  }
});

// Admin endpoint: Get templates pending approval
router.get('/admin/pending-approval', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    // Get templates that are public but not admin-approved
    const [templates] = await db.query(
      `SELECT pt.*, u.name as created_by_name, u.email as created_by_email
       FROM paper_templates pt
       LEFT JOIN users u ON pt.created_by = u.user_id
       WHERE pt.is_public = TRUE AND pt.is_admin_approved = FALSE
       ORDER BY pt.created_at DESC`
    );

    res.json({ success: true, templates });
  } catch (err) {
    console.error('Get pending approval templates error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch templates' });
  }
});

// Admin endpoint: Approve template for all users
router.put('/admin/:templateId/approve', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    const { templateId } = req.params;

    // Verify template exists
    const [templates] = await db.query(
      'SELECT template_id FROM paper_templates WHERE template_id = ?',
      [templateId]
    );

    if (templates.length === 0) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }

    // Approve template
    await db.query(
      'UPDATE paper_templates SET is_admin_approved = TRUE, is_public = TRUE WHERE template_id = ?',
      [templateId]
    );

    res.json({ 
      success: true, 
      message: 'Template approved and made public for all users',
      is_admin_approved: true,
      is_public: true
    });
  } catch (err) {
    console.error('Approve template error:', err);
    res.status(500).json({ success: false, message: 'Failed to approve template' });
  }
});

// Admin endpoint: Reject/Unapprove template
router.put('/admin/:templateId/reject', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    const { templateId } = req.params;

    // Verify template exists
    const [templates] = await db.query(
      'SELECT template_id FROM paper_templates WHERE template_id = ?',
      [templateId]
    );

    if (templates.length === 0) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }

    // Reject template (keep is_public but remove admin approval)
    await db.query(
      'UPDATE paper_templates SET is_admin_approved = FALSE WHERE template_id = ?',
      [templateId]
    );

    res.json({ 
      success: true, 
      message: 'Template rejected',
      is_admin_approved: false
    });
  } catch (err) {
    console.error('Reject template error:', err);
    res.status(500).json({ success: false, message: 'Failed to reject template' });
  }
});

// Admin endpoint: Get template visibility setting
router.get('/admin/settings/template-visibility', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    const [settings] = await db.query(
      `SELECT setting_value FROM system_settings WHERE setting_key = 'template_visibility_enabled'`
    );

    const isEnabled = settings.length > 0 && settings[0].setting_value === 'true';

    res.json({ 
      success: true, 
      template_visibility_enabled: isEnabled
    });
  } catch (err) {
    console.error('Get template visibility setting error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch setting' });
  }
});

// Admin endpoint: Update template visibility setting
router.put('/admin/settings/template-visibility', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    if (!isAdmin(req.user)) {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, message: 'enabled must be a boolean' });
    }

    await db.query(
      `UPDATE system_settings SET setting_value = ?, updated_by = ? WHERE setting_key = 'template_visibility_enabled'`,
      [enabled ? 'true' : 'false', req.user.user_id]
    );

    res.json({ 
      success: true, 
      message: `Template visibility ${enabled ? 'enabled' : 'disabled'}`,
      template_visibility_enabled: enabled
    });
  } catch (err) {
    console.error('Update template visibility setting error:', err);
    res.status(500).json({ success: false, message: 'Failed to update setting' });
  }
});

module.exports = router;
