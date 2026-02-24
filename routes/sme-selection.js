const express = require('express');
const db = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const axios = require('axios');

const router = express.Router();

// SME: Get pending requests with 10 sets for selection
router.get('/pending-requests', authMiddleware, requireRole('subject_matter_expert'), async (req, res) => {
  try {
    const userId = req.user.user_id;
    
    // Get SME's subject
    const [smeData] = await db.query(
      'SELECT subject_id FROM users WHERE user_id = ?',
      [userId]
    );

    if (smeData.length === 0 || !smeData[0].subject_id) {
      return res.status(400).json({ success: false, message: 'Subject not found for SME. Please contact administrator.' });
    }

    const subjectId = smeData[0].subject_id;

    // Get all requests from faculty in the same subject (not just pending)
    const [requests] = await db.query(
      `SELECT pgr.request_id, pgr.subject, pgr.topic, pgr.difficulty, pgr.num_questions, pgr.total_marks, 
              pgr.status, pgr.created_at, u.name as faculty_name, s.subject_name,
              (SELECT COUNT(*) FROM question_papers WHERE parent_request_id = pgr.request_id) as total_sets,
              (SELECT COUNT(*) FROM sme_selections WHERE request_id = pgr.request_id) as selected_count
       FROM paper_generation_requests pgr
       JOIN users u ON pgr.faculty_id = u.user_id
       LEFT JOIN subjects s ON u.subject_id = s.subject_id
       WHERE u.subject_id = ?
         AND pgr.status IN ('pending_sme_selection', 'pending_moderator', 'pending_hod', 'approved', 'rejected')
       ORDER BY 
         CASE 
           WHEN pgr.status = 'pending_sme_selection' THEN 1
           WHEN pgr.status = 'pending_moderator' THEN 2
           WHEN pgr.status = 'pending_hod' THEN 3
           ELSE 4
         END,
         pgr.created_at DESC`,
      [subjectId]
    );

    res.json({ success: true, requests });
  } catch (err) {
    console.error('Get pending requests error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// SME: Get all 10 sets for a specific request
router.get('/request/:requestId/sets', authMiddleware, requireRole('subject_matter_expert'), async (req, res) => {
  try {
    const { requestId } = req.params;
    
    // Verify request belongs to SME's subject
    const [requests] = await db.query(
      `SELECT pgr.* 
       FROM paper_generation_requests pgr
       JOIN users u ON pgr.faculty_id = u.user_id
       JOIN users sme ON sme.user_id = ?
       WHERE pgr.request_id = ? 
         AND u.subject_id = sme.subject_id`,
      [req.user.user_id, requestId]
    );

    if (requests.length === 0) {
      return res.status(404).json({ success: false, message: 'Request not found or unauthorized' });
    }

    // Get all 10 sets with their questions
    const [papers] = await db.query(
      `SELECT qp.paper_id, qp.paper_title, qp.total_marks, qp.set_number, qp.ai_quality_score,
              qp.created_at, qp.selected_by_sme,
              (SELECT COUNT(*) FROM paper_questions WHERE paper_id = qp.paper_id) as question_count
       FROM question_papers qp
       WHERE qp.parent_request_id = ?
       ORDER BY qp.set_number ASC`,
      [requestId]
    );

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
      sets: papers 
    });
  } catch (err) {
    console.error('Get request sets error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// SME: Get AI recommendation for best 3 sets
router.post('/request/:requestId/ai-recommend', authMiddleware, requireRole('subject_matter_expert'), async (req, res) => {
  try {
    const { requestId } = req.params;
    // Get all 10 sets with questions
    const [papers] = await db.query(
      `SELECT qp.paper_id, qp.set_number, qp.ai_quality_score, qp.total_marks
       FROM question_papers qp
       WHERE qp.parent_request_id = ?
       ORDER BY qp.set_number ASC`,
      [requestId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'No sets found' });
    }

    // Get questions for analysis
    const setsAnalysis = [];
    for (let paper of papers) {
      const [questions] = await db.query(
        `SELECT question_text, question_type, difficulty, marks, correct_answer
         FROM questions q
         JOIN paper_questions pq ON q.question_id = pq.question_id
         WHERE pq.paper_id = ?`,
        [paper.paper_id]
      );

      setsAnalysis.push({
        set_number: paper.set_number,
        paper_id: paper.paper_id,
        quality_score: paper.ai_quality_score,
        total_marks: paper.total_marks,
        question_count: questions.length,
        type_distribution: questions.reduce((acc, q) => {
          acc[q.question_type] = (acc[q.question_type] || 0) + 1;
          return acc;
        }, {}),
        difficulty_distribution: questions.reduce((acc, q) => {
          acc[q.difficulty] = (acc[q.difficulty] || 0) + 1;
          return acc;
        }, {}),
        avg_question_length: questions.reduce((sum, q) => sum + q.question_text.length, 0) / questions.length,
        answer_completeness: questions.filter(q => q.correct_answer && q.correct_answer.length > 20).length / questions.length
      });
    }

    // Build AI prompt for recommendation
    const prompt = `You are an expert educational assessment evaluator. Analyze these 10 question paper sets and recommend the BEST 3 sets.

SETS ANALYSIS:
${setsAnalysis.map(s => `
Set ${s.set_number} (paper_id: ${s.paper_id}):
- Quality Score: ${s.quality_score}
- Total Marks: ${s.total_marks}
- Questions: ${s.question_count}
- Type Distribution: ${JSON.stringify(s.type_distribution)}
- Difficulty Distribution: ${JSON.stringify(s.difficulty_distribution)}
- Avg Question Length: ${Math.round(s.avg_question_length)} chars
- Answer Completeness: ${(s.answer_completeness * 100).toFixed(0)}%
`).join('\n')}

EVALUATION CRITERIA:
1. Question quality and clarity
2. Balanced difficulty distribution
3. Variety in question types
4. Comprehensive answer coverage
5. Appropriate question length and detail

IMPORTANT: You MUST use the exact paper_id values from the analysis above. Do not make up paper IDs.

Return ONLY valid JSON with your top 3 recommendations using the EXACT paper_id from the sets above:
{
  "recommended_sets": [
    {
      "set_number": <actual set number from analysis>,
      "paper_id": <exact paper_id from analysis>,
      "rank": 1,
      "reason": "Detailed reason for selection"
    },
    {
      "set_number": <actual set number from analysis>,
      "paper_id": <exact paper_id from analysis>,
      "rank": 2,
      "reason": "Detailed reason for selection"
    },
    {
      "set_number": <actual set number from analysis>,
      "paper_id": <exact paper_id from analysis>,
      "rank": 3,
      "reason": "Detailed reason for selection"
    }
  ],
  "overall_analysis": "Brief summary of the evaluation"
}`;

    // Call Gemini API using REST
    const systemInstruction = 'You are an expert educational assessment evaluator.';
    const fullPrompt = `${systemInstruction}\n\n${prompt}`;
    
    // Use model selector to get best available model
    const { getModelSelector } = require('../utils/modelSelector');
    const modelSelector = getModelSelector();
    const selectedModel = await modelSelector.selectBestModel();
    
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [{
            text: fullPrompt
          }]
        }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 8192,
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 30000
      }
    );
    
    // Validate response structure
    if (!response.data || !response.data.candidates || !response.data.candidates[0]) {
      throw new Error('Invalid response structure from Gemini API');
    }

    const candidate = response.data.candidates[0];
    if (!candidate.content || !candidate.content.parts || !candidate.content.parts[0]) {
      throw new Error('Invalid content structure in Gemini API response');
    }
    
    let aiResponse = candidate.content.parts[0].text;
    aiResponse = aiResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const recommendation = JSON.parse(aiResponse);

    // Validate that AI returned valid paper_ids from our analysis
    const validPaperIds = setsAnalysis.map(s => s.paper_id);
    const recommendedIds = recommendation.recommended_sets.map(s => s.paper_id);
    
    const invalidIds = recommendedIds.filter(id => !validPaperIds.includes(id));
    if (invalidIds.length > 0) {
      console.error('AI returned invalid paper IDs:', invalidIds);
      console.error('Valid paper IDs:', validPaperIds);
      console.error('AI response:', recommendation);
      
      // Try to fix by matching set_number to paper_id
      recommendation.recommended_sets = recommendation.recommended_sets.map(rec => {
        const matchingSet = setsAnalysis.find(s => s.set_number === rec.set_number);
        if (matchingSet) {
          return { ...rec, paper_id: matchingSet.paper_id };
        }
        return rec;
      });
    }

    res.json({ 
      success: true, 
      recommendation,
      sets_analyzed: setsAnalysis.length
    });

  } catch (err) {
    console.error('AI recommendation error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to get AI recommendation',
      error: err.message 
    });
  }
});

// SME: Select 3 sets from the 10 generated
router.post('/request/:requestId/select', authMiddleware, requireRole('subject_matter_expert'), async (req, res) => {
  try {
    const { requestId } = req.params;
    const { selected_paper_ids, selection_reasons, ai_assisted } = req.body;
    const userId = req.user.user_id;
    const subjectId = req.user.subject_id;
    
    // Validate exactly 3 selections
    if (!selected_paper_ids || selected_paper_ids.length !== 3) {
      return res.status(400).json({ success: false, message: 'You must select exactly 3 sets' });
    }

    // Verify request exists and belongs to SME's department
    const [requests] = await db.query(
      `SELECT pgr.* 
       FROM paper_generation_requests pgr
       JOIN users u ON pgr.faculty_id = u.user_id
       JOIN users sme ON sme.user_id = ?
       WHERE pgr.request_id = ? 
         AND pgr.college_id = ? 
         AND u.subject_id = sme.subject_id
         AND pgr.status = 'pending_sme_selection'`,
      [userId, requestId]
    );

    if (requests.length === 0) {
      return res.status(404).json({ success: false, message: 'Request not found or already processed' });
    }

    // Verify all selected papers belong to this request
    console.log('Validating paper selections:', {
      requestId,
      selected_paper_ids,
      userId,
      subjectId
    });

    // Check what papers actually exist for this request
    const [requestPapers] = await db.query(
      `SELECT paper_id, set_number, status, parent_request_id FROM question_papers 
       WHERE parent_request_id = ?`,
      [requestId]
    );
    console.log('Papers for request', requestId, ':', requestPapers);

    // First, check if these papers exist at all
    const placeholders = selected_paper_ids.map(() => '?').join(',');
    const [allPapers] = await db.query(
      `SELECT paper_id, parent_request_id, status FROM question_papers 
       WHERE paper_id IN (${placeholders})`,
      selected_paper_ids
    );
    console.log('Selected papers in database:', allPapers);

    // Now check if they belong to this request
    const [papers] = await db.query(
      `SELECT paper_id FROM question_papers 
       WHERE parent_request_id = ? AND paper_id IN (${placeholders})`,
      [requestId, ...selected_paper_ids]
    );

    console.log('Found papers for request:', papers.length, 'Expected: 3');

    if (papers.length !== 3) {
      console.error('Paper validation failed:', {
        found: papers.length,
        expected: 3,
        foundPapers: papers.map(p => p.paper_id),
        requestedPapers: selected_paper_ids,
        allPapersInDb: allPapers
      });
      return res.status(400).json({ 
        success: false, 
        message: `Invalid paper selections. Found ${papers.length} valid papers out of 3 requested. Papers may belong to a different request.` 
      });
    }

    // Delete any existing selections for this request (in case of re-selection)
    await db.query('DELETE FROM sme_selections WHERE request_id = ?', [requestId]);

    // Insert selections
    for (let i = 0; i < selected_paper_ids.length; i++) {
      const paperId = selected_paper_ids[i];
      const reason = selection_reasons?.[i] || 'Selected by SME';
      
      await db.query(
        `INSERT INTO sme_selections (request_id, paper_id, sme_id, selection_reason, ai_assisted) 
         VALUES (?, ?, ?, ?, ?)`,
        [requestId, paperId, userId, reason, ai_assisted || false]
      );

      // Mark paper as selected
      await db.query(
        'UPDATE question_papers SET selected_by_sme = TRUE WHERE paper_id = ?',
        [paperId]
      );
    }

    // Update request status
    await db.query(
      'UPDATE paper_generation_requests SET status = ? WHERE request_id = ?',
      ['pending_moderator', requestId]
    );

    // Log audit
    await db.query(
      'INSERT INTO audit_logs (user_id, college_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, null, 'SME_SELECTED_PAPERS', 'paper_generation_request', requestId, 
       `Selected 3 sets: ${selected_paper_ids.join(', ')}`, req.ip]
    );

    res.json({ 
      success: true, 
      message: 'Successfully selected 3 question paper sets. Sent to Moderator for categorization.' 
    });

  } catch (err) {
    console.error('SME selection error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// SME: Reject entire request (all 10 sets)
router.post('/request/:requestId/reject', authMiddleware, requireRole('subject_matter_expert'), async (req, res) => {
  try {
    const { requestId } = req.params;
    const { rejection_reason } = req.body;
    const userId = req.user.user_id;
    if (!rejection_reason || !rejection_reason.trim()) {
      return res.status(400).json({ success: false, message: 'Rejection reason is required' });
    }

    // Verify request exists and belongs to SME's department
    const [requests] = await db.query(
      `SELECT pgr.* 
       FROM paper_generation_requests pgr
       JOIN users u ON pgr.faculty_id = u.user_id
       JOIN users sme ON sme.user_id = ?
       WHERE pgr.request_id = ? 
         AND pgr.college_id = ? 
         AND u.subject_id = sme.subject_id
         AND pgr.status = 'pending_sme_selection'`,
      [userId, requestId]
    );

    if (requests.length === 0) {
      return res.status(404).json({ success: false, message: 'Request not found or already processed' });
    }

    // Update request status to rejected
    await db.query(
      'UPDATE paper_generation_requests SET status = ? WHERE request_id = ?',
      ['rejected', requestId]
    );

    // Update all papers status to rejected
    await db.query(
      'UPDATE question_papers SET status = ? WHERE parent_request_id = ?',
      ['rejected', requestId]
    );

    // Log audit with rejection reason
    await db.query(
      'INSERT INTO audit_logs (user_id, college_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, null, 'SME_REJECTED_REQUEST', 'paper_generation_request', requestId, 
       `Rejected all 10 sets. Reason: ${rejection_reason}`, req.ip]
    );

    res.json({ 
      success: true, 
      message: 'Request rejected successfully. Faculty will be notified.' 
    });
  } catch (err) {
    console.error('Reject request error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// SME: Get their selection history
router.get('/my-selections', authMiddleware, requireRole('subject_matter_expert'), async (req, res) => {
  try {
    const userId = req.user.user_id;

    const [selections] = await db.query(
      `SELECT ss.selection_id, ss.request_id, ss.paper_id, ss.selection_reason, ss.ai_assisted, ss.selected_at,
              pgr.subject, pgr.topic, qp.paper_title, qp.set_number
       FROM sme_selections ss
       JOIN paper_generation_requests pgr ON ss.request_id = pgr.request_id
       JOIN question_papers qp ON ss.paper_id = qp.paper_id
       WHERE ss.sme_id = ?
       ORDER BY ss.selected_at DESC`,
      [userId]
    );

    res.json({ success: true, selections });
  } catch (err) {
    console.error('Get selections error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// SME: Update questions for a paper
router.put('/paper/:paperId/questions', authMiddleware, requireRole('subject_matter_expert'), async (req, res) => {
  try {
    const { paperId } = req.params;
    const { questions } = req.body;
    const userId = req.user.user_id;
    // Verify paper belongs to SME's department and is pending selection
    const [papers] = await db.query(
      `SELECT qp.*, pgr.status, u.subject_id as faculty_subject
       FROM question_papers qp
       JOIN paper_generation_requests pgr ON qp.parent_request_id = pgr.request_id
       JOIN users u ON pgr.faculty_id = u.user_id
       JOIN users sme ON sme.user_id = ?
       WHERE qp.paper_id = ? 
        
         AND u.subject_id = sme.subject_id
         AND pgr.status = 'pending_sme_selection'`,
      [userId, paperId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found or cannot be edited' });
    }

    // Update each question
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      
      // Get the question_id for this paper and order
      const [existingQuestions] = await db.query(
        `SELECT q.question_id 
         FROM questions q
         JOIN paper_questions pq ON q.question_id = pq.question_id
         WHERE pq.paper_id = ? AND pq.question_order = ?`,
        [paperId, i + 1]
      );

      if (existingQuestions.length > 0) {
        const questionId = existingQuestions[0].question_id;
        
        // Update the question with all fields
        await db.query(
          `UPDATE questions 
           SET question_text = ?, question_type = ?, marks = ?, options = ?, correct_answer = ?
           WHERE question_id = ?`,
          [
            q.question_text, 
            q.question_type, 
            q.marks, 
            q.options ? JSON.stringify(q.options) : null,
            q.correct_answer || null,
            questionId
          ]
        );
      }
    }

    // Recalculate total marks
    const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 0), 0);
    await db.query(
      'UPDATE question_papers SET total_marks = ? WHERE paper_id = ?',
      [totalMarks, paperId]
    );

    // Log audit
    await db.query(
      'INSERT INTO audit_logs (user_id, college_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, null, 'SME_EDITED_PAPER', 'question_paper', paperId, 
       `Edited ${questions.length} questions`, req.ip]
    );

    res.json({ 
      success: true, 
      message: 'Questions updated successfully',
      total_marks: totalMarks
    });

  } catch (err) {
    console.error('Update questions error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
