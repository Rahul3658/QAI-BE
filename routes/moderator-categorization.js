const express = require('express');
const db = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const router = express.Router();

// Moderator: Get all requests (pending and processed)
router.get('/pending-requests', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const moderatorId = req.user.user_id;

    // Get moderator's subject
    const [moderatorData] = await db.query(
      'SELECT subject_id FROM users WHERE user_id = ?',
      [moderatorId]
    );

    if (!moderatorData || moderatorData.length === 0 || !moderatorData[0].subject_id) {
      return res.status(400).json({ 
        success: false, 
        message: 'No subject assigned to your account. Please contact administrator.' 
      });
    }

    const subjectId = moderatorData[0].subject_id;

    // Get all requests that have been selected by SME in moderator's subject
    const [requests] = await db.query(
      `SELECT pgr.request_id, pgr.subject, pgr.topic, pgr.difficulty, pgr.num_questions, pgr.total_marks,
              pgr.status, pgr.created_at, pgr.updated_at,
              u.name as faculty_name, s.subject_name,
              (SELECT u2.name FROM sme_selections ss2 
               JOIN users u2 ON ss2.sme_id = u2.user_id 
               WHERE ss2.request_id = pgr.request_id LIMIT 1) as sme_name,
              (SELECT COUNT(*) FROM sme_selections WHERE request_id = pgr.request_id) as selected_count,
              (SELECT COUNT(*) FROM moderator_categorizations WHERE request_id = pgr.request_id) as categorized_count
       FROM paper_generation_requests pgr
       JOIN users u ON pgr.faculty_id = u.user_id
       LEFT JOIN subjects s ON u.subject_id = s.subject_id
       WHERE u.subject_id = ?
         AND pgr.status IN ('pending_moderator', 'pending_hod', 'approved', 'completed', 'rejected')
       ORDER BY 
         CASE 
           WHEN pgr.status = 'pending_moderator' THEN 1
           WHEN pgr.status = 'pending_hod' THEN 2
           WHEN pgr.status = 'completed' THEN 3
           ELSE 4
         END,
         pgr.updated_at DESC`,
      [subjectId]
    );

    res.json({ success: true, requests });
  } catch (err) {
    console.error('Get requests error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Moderator: Get the 3 selected sets for a request
router.get('/request/:requestId/selected-sets', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { requestId } = req.params;
    // Verify request belongs to moderator's college
    const [requests] = await db.query(
      `SELECT pgr.* 
       FROM paper_generation_requests pgr
       WHERE pgr.request_id = ?`,
      [requestId]);

    if (requests.length === 0) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }

    // Get the 3 selected papers
    const [papers] = await db.query(
      `SELECT qp.paper_id, qp.paper_title, qp.total_marks, qp.set_number, qp.ai_quality_score,
              qp.paper_category, qp.created_at,
              ss.selection_reason, ss.ai_assisted,
              mc.category as current_category, mc.notes as moderator_notes
       FROM question_papers qp
       JOIN sme_selections ss ON qp.paper_id = ss.paper_id
       LEFT JOIN moderator_categorizations mc ON qp.paper_id = mc.paper_id
       WHERE ss.request_id = ?
       ORDER BY ss.selected_at ASC`,
      [requestId]);

    // Get questions for each paper
    for (let paper of papers) {
      const [questions] = await db.query(
        `SELECT q.question_id, q.question_text, q.question_type, q.difficulty, q.marks,
                q.options, q.correct_answer, pq.question_order
         FROM questions q
         JOIN paper_questions pq ON q.question_id = pq.question_id
         WHERE pq.paper_id = ?
         ORDER BY pq.question_order`,
        [paper.paper_id]
      );

      // Parse options JSON
      questions.forEach(q => {
        if (q.options && typeof q.options === 'string') {
          try {
            q.options = JSON.parse(q.options);
          } catch (e) {
            q.options = null;
          }
        }
      });

      paper.questions = questions;
    }

    res.json({ 
      success: true, 
      request: requests[0],
      selected_sets: papers 
    });
  } catch (err) {
    console.error('Get selected sets error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Moderator: Categorize the 3 selected sets
router.post('/request/:requestId/categorize', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { requestId } = req.params;
    const { categorizations } = req.body; // Array of { paper_id, category, notes }
    const userId = req.user.user_id;
    // Validate categorizations
    if (!categorizations || categorizations.length !== 3) {
      return res.status(400).json({ success: false, message: 'You must categorize all 3 selected sets' });
    }

    // Validate categories
    const validCategories = ['general', 'reexam', 'special'];
    const categories = categorizations.map(c => c.category);
    
    if (!categories.every(cat => validCategories.includes(cat))) {
      return res.status(400).json({ success: false, message: 'Invalid category. Use: general, reexam, or special' });
    }

    // Check for duplicate categories
    if (new Set(categories).size !== 3) {
      return res.status(400).json({ success: false, message: 'Each paper must have a unique category' });
    }

    // Verify request exists and is pending moderator
    const [requests] = await db.query(
      `SELECT * FROM paper_generation_requests 
       WHERE request_id = ? AND status = 'pending_moderator'`,
      [requestId]);

    if (requests.length === 0) {
      return res.status(404).json({ success: false, message: 'Request not found or already processed' });
    }

    // Verify all papers are selected for this request
    const paperIds = categorizations.map(c => c.paper_id);
    const [papers] = await db.query(
      `SELECT qp.paper_id 
       FROM question_papers qp
       JOIN sme_selections ss ON qp.paper_id = ss.paper_id
       WHERE ss.request_id = ? AND qp.paper_id IN (?)`,
      [requestId, paperIds]
    );

    if (papers.length !== 3) {
      return res.status(400).json({ success: false, message: 'Invalid paper selections' });
    }

    // Delete existing categorizations (in case of re-categorization)
    await db.query('DELETE FROM moderator_categorizations WHERE request_id = ?', [requestId]);

    // Insert categorizations
    for (const cat of categorizations) {
      await db.query(
        `INSERT INTO moderator_categorizations (request_id, paper_id, moderator_id, category, notes) 
         VALUES (?, ?, ?, ?, ?)`,
        [requestId, cat.paper_id, userId, cat.category, cat.notes || null]
      );

      // Update paper category
      await db.query(
        'UPDATE question_papers SET paper_category = ? WHERE paper_id = ?',
        [cat.category, cat.paper_id]
      );

      // Update paper status to approved
      await db.query(
        'UPDATE question_papers SET status = ? WHERE paper_id = ?',
        ['approved', cat.paper_id]
      );
    }

    // Update request status to completed
    await db.query(
      'UPDATE paper_generation_requests SET status = ? WHERE request_id = ?',
      ['completed', requestId]
    );

    // Log audit
    await db.query(
      'INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, null, 'MODERATOR_CATEGORIZED_PAPERS', 'paper_generation_request', requestId, 
       `Categorized 3 papers: ${categorizations.map(c => `${c.paper_id}=${c.category}`).join(', ')}`, req.ip]
    );

    res.json({ 
      success: true, 
      message: 'Successfully categorized all 3 question papers' 
    });

  } catch (err) {
    console.error('Categorization error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

  let arabicReshaper = null;
  let bidiJs = null;

  try {
    arabicReshaper = require('arabic-reshaper');
  } catch (e) {
    console.warn('arabic-reshaper not installed — Urdu shaping will be degraded. npm i arabic-reshaper');
  }
  try {
    bidiJs = require('bidi-js');
  } catch (e) {
    console.warn('bidi-js not installed — BiDi reordering will be degraded. npm i bidi-js');
  }

  const containsArabic = (text = '') => /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(text);

  const processArabicForPdf = (text) => {
    if (!text || !containsArabic(text)) return text;

    try {
      let shaped = text;
      if (arabicReshaper && typeof arabicReshaper.reshape === 'function') {
        shaped = arabicReshaper.reshape(text);
      }

      // 2) reorder using bidi algorithm so the visual order is correct (if available)
      if (bidiJs && typeof bidiJs.getDisplay === 'function') {
        return bidiJs.getDisplay(shaped);
      } else if (bidiJs && typeof bidiJs.createBidi === 'function') {
        const bidi = bidiJs.createBidi(shaped);
        return bidi.getLogicalToVisual();
      }

      return shaped.split(' ').reverse().join(' ');
    } catch (err) {
      console.error('processArabicForPdf error:', err && err.message ? err.message : err);
      return text.split('').reverse().join('');
    }
  };

  // The updated route handler
  router.get('/paper/:paperId/download', authMiddleware, requireRole('moderator'), async (req, res) => {
    try {
      const { paperId } = req.params;
      // Get paper details
      const [papers] = await db.query(
        `SELECT qp.*, mc.category, mc.notes as moderator_notes
        FROM question_papers qp
        LEFT JOIN moderator_categorizations mc ON qp.paper_id = mc.paper_id
        WHERE qp.paper_id = ?`,
        [paperId]
      );

      if (papers.length === 0) {
        return res.status(404).json({ success: false, message: 'Paper not found' });
      }

      const paper = papers[0];

      // Get questions
      const [questions] = await db.query(
        `SELECT q.question_text, q.question_type, q.difficulty, q.marks, q.options, q.correct_answer, pq.question_order
        FROM questions q
        JOIN paper_questions pq ON q.question_id = pq.question_id
        WHERE pq.paper_id = ?
        ORDER BY pq.question_order`,
        [paperId]
      );

      // Parse options (if JSON stored as string)
      questions.forEach(q => {
        if (q.options && typeof q.options === 'string') {
          try {
            q.options = JSON.parse(q.options);
          } catch (e) {
            q.options = null;
          }
        }
      });

      // Create PDF
      const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });

      // Fonts (ensure you have these files in the specified assets path)
      const devanagariFont = path.join(__dirname, '../assets/fonts/NotoSansDevanagari_Condensed-Regular.ttf');
      const urduFont = path.join(__dirname, '../assets/fonts/AwamiNastaliq-Regular.ttf');
      const fallbackReg = path.join(__dirname, '../assets/fonts/NotoSans-Regular.ttf');
      const fallbackBold = path.join(__dirname, '../assets/fonts/NotoSans-Bold.ttf');

      let devanagariAvailable = false;
      let urduAvailable = false;
      let fallbackAvailable = false;

      if (fs.existsSync(devanagariFont)) { doc.registerFont('Devanagari', devanagariFont); devanagariAvailable = true; }
      if (fs.existsSync(urduFont)) { doc.registerFont('Urdu', urduFont); urduAvailable = true; }
      if (fs.existsSync(fallbackReg)) { doc.registerFont('Fallback', fallbackReg); fallbackAvailable = true; }
      if (fs.existsSync(fallbackBold)) { doc.registerFont('Fallback-Bold', fallbackBold); }

      const detectLanguageAndSetFont = (text, size = 11, bold = false) => {
        const hasDevanagari = /[\u0900-\u097F]/.test(text);
        const hasUrdu = containsArabic(text);

        if (hasDevanagari && devanagariAvailable) {
          doc.font('Devanagari').fontSize(size);
        } else if (hasUrdu && urduAvailable) {
          doc.font('Urdu').fontSize(size);
        } else if (bold && fallbackAvailable) {
          doc.font('Fallback-Bold').fontSize(size);
        } else if (fallbackAvailable) {
          doc.font('Fallback').fontSize(size);
        } else {
          doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
        }
      };

      // Pipes and headers
      res.setHeader('Content-Type', 'application/pdf');
      const fileSafeCategory = (paper.paper_category || 'uncategorized').replace(/[^\w\-]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="paper_${paperId}_${fileSafeCategory}.pdf"`);
      doc.pipe(res);

      // ===== HEADER =====
      const title = paper.paper_title || 'Question Paper';
      const hasUrduInTitle = containsArabic(title);
      detectLanguageAndSetFont(title, 18, true);

      // If Urdu, process text for shaping + BiDi before printing, and align right.
      const printedTitle = hasUrduInTitle ? processArabicForPdf(title) : title;
      doc.text(printedTitle, { align: hasUrduInTitle ? 'right' : 'center' });
      doc.moveDown(0.5);

      // Category label (keep in Latin)
      if (paper.paper_category) {
        const categoryLabels = {
          general: 'GENERAL EXAMINATION',
          reexam: 'RE-EXAMINATION',
          special: 'SPECIAL CASE EXAMINATION'
        };
        doc.fontSize(12).font('Helvetica-Bold')
          .fillColor('#0066cc')
          .text(`[${categoryLabels[paper.paper_category] || paper.paper_category}]`, { align: 'center' });
        doc.fillColor('#000000');
        doc.moveDown(0.5);
      }

      doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
      doc.moveDown(0.8);

      // Paper details
      doc.fontSize(10).font('Helvetica');
      doc.text(`Total Marks: ${paper.total_marks}`, 50, doc.y);
      doc.text(`Date: ${new Date().toLocaleDateString()}`, 320, doc.y);
      doc.moveDown(0.5);
      doc.text(`Duration: 3 Hours`, 50, doc.y);
      doc.moveDown(1);

      doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
      doc.moveDown(0.5);

      // Instructions
      doc.fontSize(11).font('Helvetica-Bold').text('INSTRUCTIONS:', 50);
      doc.moveDown(0.3);
      doc.fontSize(9).font('Helvetica');
      doc.text('1. Answer all questions.', 60);
      doc.text('2. Write your answers in the space provided or on separate answer sheets.', 60);
      doc.text('3. For multiple choice questions, select the most appropriate answer.', 60);
      doc.text('4. Marks are indicated in brackets for each question.', 60);
      doc.moveDown(0.5);

      doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
      doc.moveDown(1.5);

      // ===== GROUP QUESTIONS BY MAIN QUESTION NUMBER =====
      const groupedQuestions = {};
      questions.forEach((q, index) => {
        let mainQ = 'Q1';
        let subQ = '';
        let questionText = q.question_text || '';

        // Try to extract main question number from text
        // Formats: "Q.1.a) text", "Q.2.1) text", "Q1.a text", "Q1. text", etc.
        const match = questionText.match(/^Q\.?(\d+)\.([a-z0-9]+)\)?[\s\)]*(.+)$/i);
        if (match) {
          mainQ = `Q${match[1]}`;
          subQ = match[2];
          questionText = match[3];
        } else {
          // Fallback: group every 5 questions together
          mainQ = `Q${Math.floor(index / 5) + 1}`;
          subQ = String.fromCharCode(97 + (index % 5)); // a, b, c, d, e
        }

        if (!groupedQuestions[mainQ]) {
          groupedQuestions[mainQ] = {
            mainNumber: mainQ,
            subQuestions: []
          };
        }

        groupedQuestions[mainQ].subQuestions.push({
          ...q,
          subNumber: subQ,
          cleanText: questionText
        });
      });

      // ===== RENDER GROUPED QUESTIONS =====
      const mainQuestionKeys = Object.keys(groupedQuestions).sort((a, b) => {
        const numA = parseInt(a.replace('Q', ''));
        const numB = parseInt(b.replace('Q', ''));
        return numA - numB;
      });

      mainQuestionKeys.forEach((mainKey, mainIndex) => {
        const mainGroup = groupedQuestions[mainKey];
        
        if (doc.y > doc.page.height - 150) doc.addPage();

        // Main question header
        if (mainIndex > 0) doc.moveDown(1.5);
        doc.fontSize(14).font('Helvetica-Bold').text(mainKey, 50, doc.y);
        doc.moveDown(0.8);

        // Determine question type for this group
        const firstQuestion = mainGroup.subQuestions[0];
        const isMCQ = firstQuestion.question_type === 'mcq';
        const isShortAnswer = firstQuestion.question_type === 'short_answer';
        const isLongAnswer = firstQuestion.question_type === 'long_answer';

        // Add instruction based on type
        if (isMCQ) {
          doc.fontSize(11).font('Helvetica-Bold').text('Select the correct alternative:', 60);
          doc.moveDown(0.5);
        } else if (isShortAnswer || isLongAnswer) {
          doc.fontSize(11).font('Helvetica-Bold').text('Answer the following:', 60);
          doc.moveDown(0.5);
        }

        // Sub-questions
        mainGroup.subQuestions.forEach((subQ, subIndex) => {
          if (doc.y > doc.page.height - 150) doc.addPage();

          // Sub-question number and text - ensure it's a letter
          const subLetter = subQ.subNumber.replace(/[^a-z]/gi, '') || String.fromCharCode(97 + subIndex);
          doc.fontSize(11).font('Helvetica-Bold').text(`      ${subLetter}) `, 50, doc.y, { continued: true });
          
          const hasUrduInQuestion = containsArabic(subQ.cleanText);
          detectLanguageAndSetFont(subQ.cleanText, 11);
          const printableQuestionText = hasUrduInQuestion ? processArabicForPdf(subQ.cleanText) : subQ.cleanText;
          doc.text(printableQuestionText, { width: doc.page.width - 140, lineGap: 3, align: hasUrduInQuestion ? 'right' : 'left' });
          
          doc.fontSize(10).font('Helvetica').fillColor('#555555').text(`(${subQ.marks} marks)`, { indent: 70 });
          doc.fillColor('#000000');
          doc.moveDown(0.6);

          // MCQ options
          if (subQ.question_type === 'mcq' && subQ.options && Array.isArray(subQ.options)) {
            subQ.options.forEach((opt, optIndex) => {
              const cleanOption = (opt || '').replace(/^[A-D][\)\.]\s*/, '');
              const optionLabel = String.fromCharCode(65 + optIndex);
              const hasUrduInOption = containsArabic(cleanOption);

              detectLanguageAndSetFont(cleanOption, 10);
              const printableOption = hasUrduInOption ? processArabicForPdf(cleanOption) : cleanOption;

              doc.text(`            ${optionLabel}) ${printableOption}`, { width: doc.page.width - 100, lineGap: 2, align: hasUrduInOption ? 'right' : 'left' });
              doc.moveDown(0.3);
            });
            doc.moveDown(0.6);
          }

          // Answer space for non-MCQ (no answer lines, just blank space)
          if (subQ.question_type !== 'mcq') {
            // Add blank space for students to write answers
            const spaceLines = subQ.marks <= 2 ? 4 : subQ.marks <= 5 ? 6 : 10;
            for (let i = 0; i < spaceLines; i++) {
              doc.moveDown(0.8);
            }
          }

          doc.moveDown(0.4);
        });
      });

      // ===== FOOTER =====
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.moveTo(50, doc.page.height - 60).lineTo(doc.page.width - 50, doc.page.height - 60).stroke();

        // If paper title contains Urdu, shape + bidi it for footer too, and align center still.
        const footerTitle = containsArabic(paper.paper_title) ? processArabicForPdf(paper.paper_title) : (paper.paper_title || '');
        doc.fontSize(8).fillColor('#666666').text(
          `${footerTitle} | Page ${i + 1} of ${range.count}`,
          50,
          doc.page.height - 45,
          { align: 'center', width: doc.page.width - 100 }
        );

        doc.fontSize(7).text(`Generated on ${new Date().toLocaleString()}`, 50, doc.page.height - 30, { align: 'center', width: doc.page.width - 100 });
        doc.fillColor('#000000');
      }

      doc.end();

      // Audit log (non-blocking if you prefer, but keeping await like original)
      await db.query(
        'INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [req.user.user_id, null, 'PAPER_DOWNLOADED', 'question_paper', paperId, `Downloaded ${paper.paper_category || 'uncategorized'} paper`, req.ip]
      );

    } catch (err) {
      console.error('Download paper error:', err);
      if (!res.headersSent) res.status(500).json({ success: false, message: 'Failed to generate PDF' });
    }
  });


// Moderator: Get categorization history
router.get('/my-categorizations', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const userId = req.user.user_id;

    const [categorizations] = await db.query(
      `SELECT mc.categorization_id, mc.request_id, mc.paper_id, mc.category, mc.notes, mc.categorized_at,
              pgr.subject, pgr.topic, qp.paper_title, qp.set_number
       FROM moderator_categorizations mc
       JOIN paper_generation_requests pgr ON mc.request_id = pgr.request_id
       JOIN question_papers qp ON mc.paper_id = qp.paper_id
       WHERE mc.moderator_id = ?
       ORDER BY mc.categorized_at DESC`,
      [userId]
    );

    res.json({ success: true, categorizations });
  } catch (err) {
    console.error('Get categorizations error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Moderator: Reject entire request (all 3 papers)
router.post('/request/:requestId/reject', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { requestId } = req.params;
    const { rejection_reason } = req.body;
    const userId = req.user.user_id;
    // Verify request
    const [requests] = await db.query(
      `SELECT * FROM paper_generation_requests 
       WHERE request_id = ? AND status = 'pending_moderator'`,
      [requestId]);

    if (requests.length === 0) {
      return res.status(404).json({ success: false, message: 'Request not found or already processed' });
    }

    // Update request status
    await db.query(
      'UPDATE paper_generation_requests SET status = ? WHERE request_id = ?',
      ['rejected', requestId]
    );

    // Update all selected papers status
    await db.query(
      `UPDATE question_papers qp
       JOIN sme_selections ss ON qp.paper_id = ss.paper_id
       SET qp.status = 'rejected'
       WHERE ss.request_id = ?`,
      [requestId]);

    // Log audit
    await db.query(
      'INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, null, 'MODERATOR_REJECTED_REQUEST', 'paper_generation_request', requestId, 
       `Rejected request. Reason: ${rejection_reason || 'Not specified'}`, req.ip]
    );

    res.json({ 
      success: true, 
      message: 'Request rejected successfully' 
    });

  } catch (err) {
    console.error('Reject request error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Moderator: Get all completed requests (with categorized papers)
router.get('/approved-requests', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    // Get all completed requests
    const [requests] = await db.query(
      `SELECT pgr.request_id, pgr.subject, pgr.topic, pgr.difficulty, pgr.num_questions, pgr.total_marks,
              pgr.status, pgr.created_at, pgr.updated_at,
              u.name as faculty_name,
              (SELECT u2.name FROM sme_selections ss2 
               JOIN users u2 ON ss2.sme_id = u2.user_id 
               WHERE ss2.request_id = pgr.request_id LIMIT 1) as sme_name,
              (SELECT COUNT(*) FROM moderator_categorizations WHERE request_id = pgr.request_id) as categorized_count,
              (SELECT MAX(categorized_at) FROM moderator_categorizations WHERE request_id = pgr.request_id) as completed_at
       FROM paper_generation_requests pgr
       JOIN users u ON pgr.faculty_id = u.user_id
       WHERE pgr.status = 'completed'
       ORDER BY completed_at DESC`,
      []
    );

    res.json({ success: true, requests });
  } catch (err) {
    console.error('Get approved requests error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Moderator: Get categorized papers for a specific request
router.get('/request/:requestId/approved-papers', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { requestId } = req.params;
    // Verify request belongs to moderator's college
    const [requests] = await db.query(
      `SELECT pgr.* 
       FROM paper_generation_requests pgr
       WHERE pgr.request_id = ?`,
      [requestId]);

    if (requests.length === 0) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }

    // Get categorized papers for this request
    const [papers] = await db.query(
      `SELECT qp.paper_id, qp.paper_title, qp.set_number, qp.total_marks, qp.paper_category,
              qp.status, qp.created_at,
              mc.category, mc.notes as moderator_notes, mc.categorized_at,
              ss.selection_reason,
              (SELECT COUNT(*) FROM paper_questions WHERE paper_id = qp.paper_id) as question_count
       FROM question_papers qp
       JOIN moderator_categorizations mc ON qp.paper_id = mc.paper_id
       JOIN sme_selections ss ON qp.paper_id = ss.paper_id
       WHERE ss.request_id = ? AND qp.status = 'approved'
       ORDER BY mc.categorized_at ASC`,
      [requestId]);

    res.json({ 
      success: true, 
      request: requests[0],
      papers 
    });
  } catch (err) {
    console.error('Get request approved papers error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Moderator: Generate 40 unique sets from variations
router.post('/paper/:paperId/generate-40-sets', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { paperId } = req.params;
    const userId = req.user.user_id;
    console.log(`🎯 Starting generation of 40 unique sets for paper ${paperId}`);

    // Get paper details
    const [papers] = await db.query(
      `SELECT * FROM question_papers WHERE paper_id = ?`,
      [paperId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found' });
    }

    const basePaper = papers[0];

    // Check if sets already exist for this paper
    const [existingSets] = await db.query(
      `SELECT COUNT(*) as count FROM paper_sets WHERE base_paper_id = ?`,
      [paperId]
    );

    if (existingSets[0].count > 0) {
      // Delete existing sets and their questions to regenerate
      console.log(`⚠️  Found ${existingSets[0].count} existing sets. Deleting them to regenerate...`);
      
      await db.query(
        `DELETE sq FROM set_questions sq 
         INNER JOIN paper_sets ps ON sq.set_id = ps.set_id 
         WHERE ps.base_paper_id = ?`,
        [paperId]
      );
      
      await db.query(
        `DELETE FROM paper_sets WHERE base_paper_id = ?`,
        [paperId]
      );
      
      console.log(`✅ Deleted existing sets. Proceeding with generation...`);
    }

    // Get all sub-questions for this paper
    const [subQuestions] = await db.query(
      `SELECT sq.*, q.question_id as parent_question_id
       FROM sub_questions sq
       JOIN questions q ON sq.parent_question_id = q.question_id
       WHERE sq.paper_id = ?
       ORDER BY sq.full_question_number`,
      [paperId]
    );

    if (subQuestions.length === 0) {
      return res.status(400).json({ success: false, message: 'No sub-questions found for this paper' });
    }

    console.log(`📋 Found ${subQuestions.length} sub-questions`);

    // Get all variations for each sub-question
    const subQuestionVariations = {};
    let hasInsufficientVariations = false;

    for (const subQ of subQuestions) {
      const [variations] = await db.query(
        `SELECT variation_id, sub_question_id, variation_number, question_text, 
                question_type, marks, difficulty, options, correct_answer, 
                quality_score, status, created_at
         FROM question_variations 
         WHERE sub_question_id = ? AND status IN ('draft', 'approved', 'sent_to_moderator')
         ORDER BY quality_score DESC, variation_number`,
        [subQ.sub_question_id]
      );

      if (variations.length < 40) {
        console.warn(`⚠️  Sub-question ${subQ.full_question_number} has only ${variations.length} variations (need 40)`);
        hasInsufficientVariations = true;
      }

      // Log first variation to check data structure
      if (variations.length > 0) {
        console.log(`📊 Sub-question ${subQ.full_question_number}: ${variations.length} variations available`);
        console.log(`   Sample variation:`, {
          id: variations[0].variation_id,
          has_text: !!variations[0].question_text,
          text_preview: variations[0].question_text ? variations[0].question_text.substring(0, 30) : 'NULL',
          type: variations[0].question_type,
          marks: variations[0].marks
        });
      }

      subQuestionVariations[subQ.sub_question_id] = variations;
    }

    if (hasInsufficientVariations) {
      // Provide detailed information about which sub-questions need more variations
      const insufficientDetails = [];
      for (const subQ of subQuestions) {
        const count = subQuestionVariations[subQ.sub_question_id].length;
        if (count < 40) {
          insufficientDetails.push({
            sub_question: subQ.full_question_number,
            current: count,
            needed: 40
          });
        }
      }
      
      return res.status(400).json({ 
        success: false, 
        message: 'Insufficient variations. Each sub-question needs at least 40 variations to generate 40 unique sets.',
        details: insufficientDetails
      });
    }

    // Generate 40 unique sets
    const generatedSets = [];
    const usedVariationCombinations = new Set();

    for (let setNum = 1; setNum <= 40; setNum++) {
      let attempts = 0;
      let validSet = false;
      let selectedVariations = {};

      // Try to create a unique combination
      while (!validSet && attempts < 100) {
        selectedVariations = {};
        
        // For each sub-question, select a variation
        for (const subQ of subQuestions) {
          const availableVariations = subQuestionVariations[subQ.sub_question_id];
          
          // Select variation based on quality score and uniqueness
          // Use round-robin with quality weighting
          const variationIndex = (setNum - 1 + attempts) % availableVariations.length;
          selectedVariations[subQ.sub_question_id] = availableVariations[variationIndex];
        }

        // Create a unique key for this combination
        const combinationKey = Object.values(selectedVariations)
          .map(v => v.variation_id)
          .sort()
          .join('-');

        if (!usedVariationCombinations.has(combinationKey)) {
          usedVariationCombinations.add(combinationKey);
          validSet = true;
        }

        attempts++;
      }

      if (!validSet) {
        console.error(`❌ Could not generate unique set ${setNum} after 100 attempts`);
        continue;
      }

      // Calculate average quality score for this set
      const qualityScores = Object.values(selectedVariations).map(v => {
        const score = v.quality_score;
        // Handle NULL, undefined, or NaN values
        return (score !== null && score !== undefined && !isNaN(score)) ? parseFloat(score) : 0.5;
      });
      
      let avgQualityScore = qualityScores.length > 0 
        ? qualityScores.reduce((sum, score) => sum + score, 0) / qualityScores.length 
        : 0.5;
      
      // Final validation: ensure it's a valid number
      if (isNaN(avgQualityScore) || avgQualityScore === null || avgQualityScore === undefined) {
        console.warn(`⚠️  Invalid quality score for set ${setNum}, using default 0.5`);
        avgQualityScore = 0.5;
      }
      
      // Round to 2 decimal places
      avgQualityScore = Math.round(avgQualityScore * 100) / 100;

      generatedSets.push({
        set_number: setNum,
        variations: selectedVariations,
        avg_quality_score: avgQualityScore
      });

      console.log(`✅ Generated Set ${setNum} with avg quality score: ${avgQualityScore.toFixed(2)}`);
    }

    // Save the 40 sets to database (NEW: using paper_sets table instead of question_papers)
    const savedSets = [];

    for (const set of generatedSets) {
      try {
        console.log(`Creating set ${set.set_number} in paper_sets table...`);
        
        // Validate avg_quality_score before insert
        let qualityScore = set.avg_quality_score;
        if (isNaN(qualityScore) || qualityScore === null || qualityScore === undefined) {
          console.warn(`⚠️  Invalid quality score for set ${set.set_number}, using default 0.5`);
          qualityScore = 0.5;
        }
        
        console.log(`  Quality score: ${qualityScore}`);
        
        // Insert into paper_sets table (NOT question_papers)
        const [setResult] = await db.query(
          `INSERT INTO paper_sets 
           (base_paper_id, set_number, avg_quality_score, created_by, status)
           VALUES (?, ?, ?, ?, ?)`,
          [
            paperId,
            set.set_number,
            qualityScore,
            userId,
            'draft'
          ]
        );

        const newSetId = setResult.insertId;
        console.log(`✅ Created set ${newSetId} for set number ${set.set_number}`);

        // Group sub-questions by main question number for proper structure
        const groupedByMainQuestion = {};
        for (const subQ of subQuestions) {
          // Extract main question number from full_question_number
          let mainQuestionNumber = 'Q1'; // default
          
          const match = subQ.full_question_number.match(/^Q\.(\d+)\./i);
          if (match) {
            mainQuestionNumber = `Q${match[1]}`;
          }
          
          if (!groupedByMainQuestion[mainQuestionNumber]) {
            groupedByMainQuestion[mainQuestionNumber] = [];
          }
          groupedByMainQuestion[mainQuestionNumber].push(subQ);
        }

        // Link variations to this set (NOT creating questions table entries)
        let questionOrder = 1;
        for (const mainQuestionNumber of Object.keys(groupedByMainQuestion).sort()) {
          const subQuestionsInGroup = groupedByMainQuestion[mainQuestionNumber];
          
          for (const subQ of subQuestionsInGroup) {
            const variation = set.variations[subQ.sub_question_id];
            
            // Validate variation data
            if (!variation) {
              console.error(`❌ No variation found for sub-question ${subQ.sub_question_id}`);
              throw new Error(`No variation found for sub-question ${subQ.full_question_number}`);
            }
            
            if (!variation.question_text) {
              console.error(`❌ Variation ${variation.variation_id} has no question_text`);
              throw new Error(`Variation for ${subQ.full_question_number} has no question text`);
            }
            
            // Insert into set_questions table (links variation to set)
            await db.query(
              `INSERT INTO set_questions 
               (set_id, variation_id, sub_question_id, question_order, main_question_number, sub_question_number)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [
                newSetId,
                variation.variation_id,
                subQ.sub_question_id,
                questionOrder++,
                mainQuestionNumber,
                subQ.full_question_number
              ]
            );
          }
        }

        savedSets.push({
          set_id: newSetId,
          set_number: set.set_number,
          avg_quality_score: set.avg_quality_score
        });
      } catch (error) {
        console.error(`Error creating set ${set.set_number}:`, error);
        throw error;
      }
    }

    // Mark the base paper as having generated sets
    await db.query(
      `UPDATE question_papers SET has_generated_sets = TRUE WHERE paper_id = ?`,
      [paperId]
    );

    // Log audit
    await db.query(
      `INSERT INTO audit_logs 
       (user_id, college_id, action, entity_type, entity_id, details, ip_address) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId, 
        null, 
        'GENERATED_40_SETS', 
        'question_paper', 
        paperId, 
        `Generated 40 unique sets from paper ${paperId}`, 
        req.ip
      ]
    );

    console.log(`🎉 Successfully generated 40 unique sets in paper_sets table`);

    res.json({ 
      success: true, 
      message: 'Successfully generated 40 unique question paper sets',
      sets: savedSets,
      total_sets: savedSets.length
    });

  } catch (err) {
    console.error('Generate 40 sets error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to generate sets', 
      error: err.message 
    });
  }
});

// Moderator: Save categorized sets (from 40 sets)
router.post('/save-categorized-sets', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { categorizations, base_paper_id } = req.body;
    const userId = req.user.user_id;
    console.log(`Saving ${categorizations.length} categorized sets`);

    if (!categorizations || categorizations.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'No categorizations provided' 
      });
    }

    // NEW: Update paper_sets table instead of question_papers
    // categorizations now contains set_id instead of paper_id
    for (const cat of categorizations) {
      await db.query(
        `UPDATE paper_sets 
         SET category = ?, status = 'categorized' 
         WHERE set_id = ?`,
        [cat.category, cat.set_id]
      );

      console.log(`✅ Updated set ${cat.set_id} with category ${cat.category}`);
    }

    // Update base paper status to finalized
    if (base_paper_id) {
      await db.query(
        `UPDATE question_papers 
         SET status = 'finalized' 
         WHERE paper_id = ?`,
        [base_paper_id]
      );
    }

    // Count by category
    const counts = {
      general: categorizations.filter(c => c.category === 'general').length,
      reexam: categorizations.filter(c => c.category === 'reexam').length,
      special: categorizations.filter(c => c.category === 'special').length
    };

    // Log audit
    await db.query(
      `INSERT INTO audit_logs 
       (user_id, college_id, action, entity_type, entity_id, details, ip_address) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId, 
        null, 
        'CATEGORIZED_40_SETS', 
        'question_paper', 
        base_paper_id, 
        `Categorized ${categorizations.length} sets: General=${counts.general}, Re-exam=${counts.reexam}, Special=${counts.special}`, 
        req.ip
      ]
    );

    console.log('🎉 Successfully saved categorized sets');

    res.json({ 
      success: true, 
      message: `Successfully categorized ${categorizations.length} sets (General: ${counts.general}, Re-Exam: ${counts.reexam}, Special: ${counts.special})`
    });

  } catch (err) {
    console.error('Save categorized sets error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to save categorization', 
      error: err.message 
    });
  }
});

// Moderator: Get categorized sets for a paper
router.get('/paper/:paperId/categorized-sets', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { paperId } = req.params;
    // Get original paper
    const [papers] = await db.query(
      `SELECT * FROM question_papers WHERE paper_id = ?`,
      [paperId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found' });
    }

    // NEW: Get categorized sets from paper_sets table
    // Map 'category' to 'paper_category' for frontend compatibility
    const [categorizedSets] = await db.query(
      `SELECT ps.set_id as paper_id, ps.set_number, ps.category as paper_category, 
              ps.avg_quality_score, ps.status,
              CONCAT(?, ' - Set ', ps.set_number) as paper_title,
              (SELECT COUNT(*) FROM set_questions WHERE set_id = ps.set_id) as question_count
       FROM paper_sets ps
       WHERE ps.base_paper_id = ? 
       AND ps.category IS NOT NULL
       ORDER BY ps.category, ps.set_number`,
      [papers[0].paper_title, paperId]
    );

    console.log(`📊 Found ${categorizedSets.length} categorized sets for paper ${paperId}`);
    console.log('Sample set:', categorizedSets[0]);

    res.json({
      success: true,
      original_paper: papers[0],
      categorized_papers: categorizedSets
    });

  } catch (err) {
    console.error('Get categorized sets error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// NEW: Get all 40 generated sets for a paper
router.get('/paper/:paperId/all-sets', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { paperId } = req.params;
    // Verify paper belongs to college
    const [papers] = await db.query(
      `SELECT * FROM question_papers WHERE paper_id = ?`,
      [paperId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found' });
    }

    // Get all sets from paper_sets table
    const [sets] = await db.query(
      `SELECT ps.set_id, ps.set_number, ps.category, ps.avg_quality_score, ps.status,
              (SELECT COUNT(*) FROM set_questions WHERE set_id = ps.set_id) as question_count
       FROM paper_sets ps
       WHERE ps.base_paper_id = ?
       ORDER BY ps.set_number`,
      [paperId]
    );

    res.json({
      success: true,
      base_paper: papers[0],
      sets: sets,
      total_sets: sets.length
    });

  } catch (err) {
    console.error('Get all sets error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// NEW: Get set details with questions (for preview/download)
router.get('/set/:setId/details', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { setId } = req.params;
    // Get set info
    const [sets] = await db.query(
      `SELECT ps.*, qp.paper_title, qp.total_marks
       FROM paper_sets ps
       JOIN question_papers qp ON ps.base_paper_id = qp.paper_id
       WHERE ps.set_id = ?`,
      [setId]
    );

    if (sets.length === 0) {
      return res.status(404).json({ success: false, message: 'Set not found' });
    }

    const setInfo = sets[0];

    // Get all questions for this set from set_questions + question_variations
    const [questions] = await db.query(
      `SELECT sq.question_order, sq.main_question_number, sq.sub_question_number,
              qv.variation_id, qv.question_text, qv.question_type, qv.marks, 
              qv.difficulty, qv.options, qv.correct_answer, qv.quality_score
       FROM set_questions sq
       JOIN question_variations qv ON sq.variation_id = qv.variation_id
       WHERE sq.set_id = ?
       ORDER BY sq.question_order`,
      [setId]
    );

    // Parse options JSON
    questions.forEach(q => {
      if (q.options && typeof q.options === 'string') {
        try {
          q.options = JSON.parse(q.options);
        } catch (e) {
          q.options = null;
        }
      }
    });

    res.json({
      success: true,
      set: setInfo,
      questions: questions,
      question_count: questions.length
    });

  } catch (err) {
    console.error('Get set details error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// NEW: Download PDF for a specific set (on-demand generation)
router.get('/set/:setId/download-pdf', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { setId } = req.params;
    // Get set details
    const { data: setDetails } = await axios.get(
      `${req.protocol}://${req.get('host')}/api/moderator-categorization/set/${setId}/details`,
      { headers: { Authorization: req.headers.authorization } }
    );

    if (!setDetails.success) {
      return res.status(404).json({ success: false, message: 'Set not found' });
    }

    const { set, questions } = setDetails;

    // Generate PDF on-demand
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Set_${set.set_number}.pdf"`);
    
    doc.pipe(res);

    // Add header
    doc.fontSize(16).font('Helvetica-Bold').text(set.paper_title, { align: 'center' });
    doc.fontSize(12).font('Helvetica').text(`Set ${set.set_number}`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).text(`Total Marks: ${set.total_marks}`, { align: 'center' });
    doc.moveDown(2);

    // Add questions
    questions.forEach((q, index) => {
      doc.fontSize(11).font('Helvetica-Bold').text(`${q.sub_question_number}`, { continued: true });
      doc.font('Helvetica').text(` ${q.question_text}`);
      doc.moveDown(0.5);

      // Add options for MCQ
      if (q.question_type === 'mcq' && q.options) {
        const options = typeof q.options === 'string' ? JSON.parse(q.options) : q.options;
        Object.entries(options).forEach(([key, value]) => {
          doc.fontSize(10).text(`   ${key}) ${value}`);
        });
        doc.moveDown(0.5);
      }

      doc.fontSize(9).fillColor('gray').text(`[${q.marks} marks]`, { align: 'right' });
      doc.fillColor('black');
      doc.moveDown(1);
    });

    doc.end();

  } catch (err) {
    console.error('Download set PDF error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate PDF' });
  }
});

module.exports = router;
