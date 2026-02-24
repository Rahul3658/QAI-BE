const express = require('express');
const db = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const axios = require('axios');

const router = express.Router();

// Helper function to normalize question types
function normalizeQuestionType(type) {
  if (!type) return 'short_answer';

  const typeStr = type.toLowerCase().trim();

  // Map various formats to standard types
  if (typeStr.includes('mcq') || typeStr.includes('multiple choice') || typeStr.includes('multiple-choice')) {
    return 'mcq';
  }
  if (typeStr.includes('short') || typeStr.includes('brief')) {
    return 'short_answer';
  }
  if (typeStr.includes('long') || typeStr.includes('essay') || typeStr.includes('descriptive')) {
    return 'long_answer';
  }
  if (typeStr.includes('true') || typeStr.includes('false')) {
    return 'true_false';
  }
  if (typeStr.includes('fill') || typeStr.includes('blank')) {
    return 'fill_blank';
  }
  if (typeStr.includes('match')) {
    return 'matching';
  }

  // Default to short_answer for structured or unknown types
  return 'short_answer';
}

// Helper to format class level labels consistently in prompts
function formatClassLevelLabel(classLevel) {
  if (classLevel && classLevel.trim() !== '') {
    return `Class Level: ${classLevel}`;
  }
  return 'Class Level: Not Specified';
}

function formatTemplateQuestionSpec(question, index) {
  const typeLabel = question.type ? question.type.toUpperCase() : 'QUESTION';
  const difficultyLabel = question.difficulty || 'medium';
  const classLabel = formatClassLevelLabel(question.class_level);
  return `Question ${index + 1}: ${typeLabel} - ${question.marks} marks - ${difficultyLabel} difficulty - ${classLabel}`;
}

function formatTemplateQuestionJson(question, index, topic, totalCount) {
  const parts = [
    '    {',
    `      "type": "${question.type}",`,
    `      "question_text": "Your question about ${topic} here",`
  ];

  if (question.type === 'mcq') {
    parts.push('      "options": ["Option A", "Option B", "Option C", "Option D"],');
  }

  parts.push(`      "correct_answer": "${question.type === 'mcq' ? 'Option A' : 'Your answer here'}",`);
  parts.push(`      "marks": ${question.marks},`);

  if (question.class_level) {
    parts.push(`      "difficulty": "${question.difficulty || 'medium'}",`);
    parts.push(`      "class_level": "${question.class_level}"`);
  } else {
    parts.push(`      "difficulty": "${question.difficulty || 'medium'}"`);
  }

  parts.push('    }' + (index < totalCount - 1 ? ',' : ''));
  return parts.join('\n');
}

// Helper function to call Gemini API using REST
async function callGeminiAPI(prompt) {
  try {
    const systemInstruction = 'You are an expert educational question paper generator. Generate high-quality, well-structured questions in valid JSON format only. Do not include any markdown formatting or extra text.';
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
          temperature: 0.9,
          maxOutputTokens: 8192,
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 90000
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

    return candidate.content.parts[0].text;
  } catch (error) {
    console.error('Gemini API Error:', error.response?.data || error.message);
    throw error;
  }
}

// Helper function to calculate AI quality score for a paper
function calculateQualityScore(questions) {
  let score = 0;
  let factors = 0;

  // Factor 1: Question diversity (0-0.3)
  const types = new Set(questions.map(q => q.type));
  score += (types.size / 3) * 0.3; // Max 3 types
  factors++;

  // Factor 2: Difficulty distribution (0-0.2)
  const difficulties = questions.map(q => q.difficulty);
  const hasVariety = new Set(difficulties).size > 1;
  score += hasVariety ? 0.2 : 0.1;
  factors++;

  // Factor 3: Answer completeness (0-0.3)
  const withAnswers = questions.filter(q => q.correct_answer && q.correct_answer.length > 10).length;
  score += (withAnswers / questions.length) * 0.3;
  factors++;

  // Factor 4: Question length/detail (0-0.2)
  const avgLength = questions.reduce((sum, q) => sum + q.question_text.length, 0) / questions.length;
  score += Math.min(avgLength / 500, 1) * 0.2; // Normalize to 500 chars
  factors++;

  return Math.min(score, 1).toFixed(2); // Cap at 1.00
}

// Faculty/Examiner: Generate 10 sets of question papers
router.post('/generate-sets', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { subject, topic, difficulty, num_questions, total_marks, question_types, marks_distribution, reference_pdf_id, template_id } = req.body;
    const userId = req.user.user_id;
    if (!subject || !topic) {
      return res.status(400).json({ success: false, message: 'Subject and topic are required' });
    }

    // Get template if provided
    let template = null;
    if (template_id) {
      console.log(`📋 Loading template ID: ${template_id} for college: ${collegeId}`);

      const [templates] = await db.query(
        'SELECT * FROM paper_templates WHERE template_id = ?',
        [template_id]
      );

      console.log(`Found ${templates.length} templates`);

      if (templates.length > 0) {
        template = templates[0];
        console.log('Template raw data:', {
          template_id: template.template_id,
          template_name: template.template_name,
          question_count: template.question_count,
          total_marks: template.total_marks,
          questions_type: typeof template.questions,
          questions_value: template.questions
        });

        // Parse template questions
        if (typeof template.questions === 'string') {
          try {
            template.questions = JSON.parse(template.questions);
            console.log('✅ Parsed template questions:', template.questions.length, 'questions');
          } catch (e) {
            console.error('❌ Failed to parse template questions:', e);
            template.questions = [];
          }
        }

        // Ensure questions is an array
        if (!Array.isArray(template.questions)) {
          console.error('❌ Template questions is not an array:', template.questions);
          template.questions = [];
        }

        // If template has no questions, don't use it
        if (template.questions.length === 0) {
          console.error('❌ Template has no questions, falling back to manual mode');
          template = null;
        } else {
          console.log('✅ Template loaded successfully with', template.questions.length, 'questions');
          console.log('Template structure:', template.questions.map((q, i) => `Q${i + 1}:${q.type}(${q.marks}m)`).join(', '));
        }
      } else {
        console.error('❌ No template found with ID:', template_id);
      }
    }

    // Create generation request with safe defaults
    let finalNumQuestions = 10;
    let finalTotalMarks = 50;
    let finalDifficulty = 'medium';
    let finalQuestionTypes = {};
    let finalMarksDistribution = {};

    if (template) {
      // Use template values
      finalNumQuestions = template.question_count || template.questions?.length || 10;
      finalTotalMarks = template.total_marks || 50;
      finalDifficulty = 'medium';
      finalQuestionTypes = {};
      finalMarksDistribution = {};
    } else {
      // Use manual values
      finalNumQuestions = num_questions || 10;
      finalTotalMarks = total_marks || 50;
      finalDifficulty = difficulty || 'medium';
      finalQuestionTypes = question_types || {};
      finalMarksDistribution = marks_distribution || {};
    }

    console.log('Generation values:', {
      finalNumQuestions,
      finalTotalMarks,
      finalDifficulty,
      template: template ? 'yes' : 'no'
    });

    const [requestResult] = await db.query(
      `INSERT INTO paper_generation_requests 
       (faculty_id, subject, topic, difficulty, num_questions, total_marks, question_types, marks_distribution, reference_pdf_id, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'generating')`,
      [userId, collegeId, subject, topic,
        finalDifficulty,
        finalNumQuestions,
        finalTotalMarks,
        JSON.stringify(finalQuestionTypes),
        JSON.stringify(finalMarksDistribution),
        reference_pdf_id]
    );

    const requestId = requestResult.insertId;

    // Get reference PDF context if provided
    let referenceContext = '';
    let referencePdfName = null;
    if (reference_pdf_id) {
      const [pdfs] = await db.query(
        'SELECT * FROM uploaded_pdfs WHERE pdf_id = ?',
        [reference_pdf_id]
      );
      if (pdfs.length > 0 && pdfs[0].extracted_text) {
        const maxContextLength = 15000;
        referenceContext = pdfs[0].extracted_text.length > maxContextLength
          ? pdfs[0].extracted_text.substring(0, maxContextLength) + '...[truncated]'
          : pdfs[0].extracted_text;
        referencePdfName = pdfs[0].file_name;
      }
    }

    // Build base prompt based on template or manual configuration
    let basePrompt;

    if (template && template.questions && template.questions.length > 0) {
      // Use template structure - STRICT MODE
      basePrompt = `You are generating a question paper that MUST follow this EXACT template structure.

${referenceContext ? `REFERENCE CONTEXT (use as inspiration for topics and style):\n${referenceContext}\n\n` : ''}

SUBJECT: ${subject}
TOPIC: ${topic}

⚠️ MANDATORY TEMPLATE STRUCTURE - DO NOT DEVIATE:
${template.questions.map((q, idx) => `\n${formatTemplateQuestionSpec(q, idx)}`).join('')}

TOTAL MARKS MUST BE: ${template.total_marks}

🔴 CRITICAL RULES (FAILURE TO FOLLOW = INVALID):
1. Generate EXACTLY ${template.questions.length} questions
2. Each question MUST match the type, marks, and difficulty specified above
3. Question types: ${template.questions.map((q, i) => `Q${i + 1}=${q.type}`).join(', ')}
4. Marks per question: ${template.questions.map((q, i) => `Q${i + 1}=${q.marks}`).join(', ')}
5. Total marks MUST equal ${template.total_marks}
6. For MCQ: MUST have exactly 4 options as array, correct_answer must match one option
7. For Short Answer: provide 2-3 sentence answers
8. For Long Answer: provide 1-2 paragraph answers
9. ALL questions MUST have "correct_answer" field
10. Generate UNIQUE questions - no repetition
11. The wording, syllabus coverage, and conceptual depth MUST match the class level specified for each question

Return ONLY valid JSON (no markdown, no explanation):
{
  "questions": [
${template.questions.map((q, idx) => formatTemplateQuestionJson(q, idx, topic, template.questions.length)).join('\n')}
  ],
  "total_marks": ${template.total_marks}
}`;
    } else {
      // Manual configuration
      const selectedTypes = Object.keys(question_types).filter(type => question_types[type]);

      basePrompt = `Generate a comprehensive question paper with the following specifications:

${referenceContext ? `REFERENCE CONTEXT (use as inspiration for topics and style):\n${referenceContext}\n\n` : ''}

SPECIFICATIONS:
Subject: ${subject}
Topic: ${topic}
Difficulty Level: ${difficulty}
Total Questions: ${num_questions}
Total Marks: ${total_marks || 50}
Question Types: ${selectedTypes.join(', ')}

MARKS DISTRIBUTION:
- MCQ: ${marks_distribution.mcq || 1} marks each
- Short Answer: ${marks_distribution.short_answer || 2} marks each (2-3 sentence answers)
- Long Answer: ${marks_distribution.long_answer || 5} marks each (1-2 paragraph answers)

CRITICAL INSTRUCTIONS:
1. Generate UNIQUE questions - avoid repetition
2. Ensure variety in question topics and approaches
3. Distribute ${total_marks || 50} marks across all ${num_questions} questions
4. ALL questions MUST have "correct_answer" field
5. For MCQ: "options" MUST be array of 4 strings, "correct_answer" must match one option exactly

Return ONLY valid JSON (no markdown):
{
  "questions": [
    {
      "type": "mcq",
      "question_text": "Question text here...",
      "options": ["Option 1", "Option 2", "Option 3", "Option 4"],
      "correct_answer": "Option 1",
      "marks": ${marks_distribution.mcq || 1},
      "difficulty": "${difficulty}"
    }
  ],
  "total_marks": ${total_marks || 50}
}`;
    }

    // Generate 10 sets
    const generatedSets = [];
    const universityId = 1; // Default university in subject-based system

    for (let setNum = 1; setNum <= 10; setNum++) {
      try {
        // Add variation instruction for each set
        const setPrompt = basePrompt + `\n\nIMPORTANT: This is SET ${setNum} of 10. Generate DIFFERENT questions from previous sets while maintaining quality and relevance.`;

        let generatedText = await callGeminiAPI(setPrompt);
        generatedText = generatedText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        // Try to parse JSON with better error handling
        let generatedData;
        try {
          generatedData = JSON.parse(generatedText);
        } catch (parseError) {
          console.error(`❌ JSON Parse Error for Set ${setNum}:`, parseError.message);
          console.log('Attempting to fix common JSON issues...');

          // Try to fix common JSON issues
          let fixedText = generatedText
            // Fix unescaped quotes in strings
            .replace(/([^\\])"([^"]*)":/g, '$1\\"$2":')
            // Fix unescaped backslashes
            .replace(/\\/g, '\\\\')
            // Fix newlines in strings
            .replace(/\n/g, '\\n')
            // Fix tabs
            .replace(/\t/g, '\\t');

          try {
            generatedData = JSON.parse(fixedText);
            console.log('✅ JSON fixed and parsed successfully');
          } catch (secondError) {
            console.error(`❌ Still failed after fixes. Skipping Set ${setNum}`);
            throw new Error(`Failed to parse JSON for Set ${setNum}: ${parseError.message}`);
          }
        }

        // STRICT TEMPLATE ENFORCEMENT
        if (template && template.questions) {
          console.log(`\n🔍 Set ${setNum} - Template Enforcement:`);
          console.log(`Template structure:`, template.questions.map((q, i) => `Q${i + 1}:${q.type}(${q.marks}m)`).join(', '));
          console.log(`AI generated:`, generatedData.questions.map((q, i) => `Q${i + 1}:${q.type}(${q.marks}m)`).join(', '));

          // FORCE exact template structure - ignore AI output structure
          const correctedQuestions = [];

          for (let i = 0; i < template.questions.length; i++) {
            const templateQ = template.questions[i];
            const aiQ = generatedData.questions[i];

            // Use AI question text if available, otherwise create placeholder
            const questionText = aiQ?.question_text || `Question ${i + 1} about ${topic}`;
            const correctAnswer = aiQ?.correct_answer || (templateQ.type === 'mcq' ? 'Option A' : 'Answer here');

            // Build question with EXACT template structure
            const correctedQ = {
              type: templateQ.type,  // FORCE template type
              question_text: questionText,
              marks: templateQ.marks,  // FORCE template marks
              difficulty: templateQ.difficulty || 'medium',  // FORCE template difficulty
              correct_answer: correctAnswer
            };

            if (templateQ.class_level) {
              correctedQ.class_level = templateQ.class_level;
            }

            // Add options for MCQ
            if (templateQ.type === 'mcq') {
              if (aiQ?.options && Array.isArray(aiQ.options) && aiQ.options.length >= 4) {
                correctedQ.options = aiQ.options.slice(0, 4);
              } else {
                correctedQ.options = ['Option A', 'Option B', 'Option C', 'Option D'];
              }
            }

            correctedQuestions.push(correctedQ);
          }

          // Replace with corrected questions
          generatedData.questions = correctedQuestions;

          // FORCE template total marks
          generatedData.total_marks = template.total_marks;

          console.log(`✅ Corrected to:`, generatedData.questions.map((q, i) => `Q${i + 1}:${q.type}(${q.marks}m)`).join(', '));
          console.log(`Total marks: ${generatedData.total_marks}\n`);
        }

        // Ensure MCQ questions have proper options
        generatedData.questions = generatedData.questions.map(q => {
          if (q.type === 'mcq') {
            if (!q.options || !Array.isArray(q.options) || q.options.length === 0) {
              const correctAns = q.correct_answer || 'Correct Answer';
              q.options = [correctAns, 'Option B', 'Option C', 'Option D'];
              q.options.sort(() => Math.random() - 0.5);
            }
            while (q.options.length < 4) q.options.push(`Option ${String.fromCharCode(65 + q.options.length)}`);
            if (q.options.length > 4) q.options = q.options.slice(0, 4);
          }
          return q;
        });

        // Calculate quality score
        const qualityScore = calculateQualityScore(generatedData.questions);

        // Insert question paper with 'draft' status so examiner can review/edit
        const paperTitle = `${subject} - ${topic} (Set ${setNum})`;
        const [paperResult] = await db.query(
          `INSERT INTO question_papers 
           (generated_by, paper_title, total_marks, status, parent_request_id, set_number, ai_quality_score, reference_pdf_id, reference_pdf_name) 
           VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
          [userId, collegeId, paperTitle, generatedData.total_marks, requestId, setNum, qualityScore, reference_pdf_id, referencePdfName]
        );

        const paperId = paperResult.insertId;

        // Insert questions
        let questionOrder = 0;
        for (const q of generatedData.questions) {
          const [questionResult] = await db.query(
            `INSERT INTO questions 
             (university_id, created_by, question_text, question_type, difficulty, marks, options, correct_answer, status) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
            [universityId, userId, q.question_text, q.type, q.difficulty, q.marks,
              q.options ? JSON.stringify(q.options) : null, q.correct_answer || null]
          );

          await db.query(
            'INSERT INTO paper_questions (paper_id, question_id, question_order) VALUES (?, ?, ?)',
            [paperId, questionResult.insertId, questionOrder++]
          );
        }

        generatedSets.push({
          set_number: setNum,
          paper_id: paperId,
          quality_score: qualityScore,
          total_questions: generatedData.questions.length
        });

        console.log(`✅ Generated Set ${setNum}/10 (Quality: ${qualityScore})`);

        // Small delay to avoid rate limiting
        if (setNum < 10) await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (err) {
        console.error(`❌ Failed to generate Set ${setNum}:`, err.message);

        // Retry once for failed sets
        console.log(`🔄 Retrying Set ${setNum}...`);
        try {
          const retryPrompt = basePrompt + `\n\nIMPORTANT: This is SET ${setNum} of 10. Generate DIFFERENT questions from previous sets. ENSURE all JSON is properly formatted with escaped quotes and special characters.`;

          let retryText = await callGeminiAPI(retryPrompt);
          retryText = retryText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

          const retryData = JSON.parse(retryText);

          // Apply same template enforcement as before
          if (template && template.questions) {
            const correctedQuestions = [];
            for (let i = 0; i < template.questions.length; i++) {
              const templateQ = template.questions[i];
              const aiQ = retryData.questions[i];
              const questionText = aiQ?.question_text || `Question ${i + 1} about ${topic}`;

              const enforcedQuestion = {
                type: templateQ.type,
                question_text: questionText,
                options: templateQ.type === 'mcq' ? (aiQ?.options || ['Option A', 'Option B', 'Option C', 'Option D']) : null,
                correct_answer: aiQ?.correct_answer || (templateQ.type === 'mcq' ? 'Option A' : 'Sample answer'),
                marks: templateQ.marks,
                difficulty: templateQ.difficulty
              };

              if (templateQ.class_level) {
                enforcedQuestion.class_level = templateQ.class_level;
              }

              correctedQuestions.push(enforcedQuestion);
            }
            retryData.questions = correctedQuestions;
          }

          // Save the retried set
          const [paperResult] = await db.query(
            `INSERT INTO question_papers (university_id, parent_request_id, paper_title, total_marks, set_number, status) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [universityId, collegeId, requestId, `${subject} - ${topic} (Set ${setNum})`, retryData.total_marks || total_marks, setNum, 'pending']
          );

          const paperId = paperResult.insertId;

          for (let i = 0; i < retryData.questions.length; i++) {
            const q = retryData.questions[i];
            const [questionResult] = await db.query(
              `INSERT INTO questions (question_text, question_type, difficulty, marks, options, correct_answer) 
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [q.question_text, q.type, q.difficulty, q.marks, q.options ? JSON.stringify(q.options) : null, q.correct_answer, collegeId]
            );

            await db.query(
              'INSERT INTO paper_questions (paper_id, question_id, question_order) VALUES (?, ?, ?)',
              [paperId, questionResult.insertId, i + 1]
            );
          }

          generatedSets.push({ set_number: setNum, paper_id: paperId });
          console.log(`✅ Retry successful for Set ${setNum}`);

        } catch (retryErr) {
          console.error(`❌ Retry also failed for Set ${setNum}:`, retryErr.message);
          // Continue with other sets
        }
      }
    }

    // Keep request status as 'generating' until examiner sends to SME
    await db.query(
      'UPDATE paper_generation_requests SET status = ? WHERE request_id = ?',
      ['draft', requestId]
    );

    // Log audit
    await db.query(
      'INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, null, 'PAPER_SETS_GENERATED', 'paper_generation_request', requestId,
        `Generated ${generatedSets.length} sets for ${subject} - ${topic}`, req.ip]
    );

    res.status(201).json({
      success: true,
      message: `Successfully generated ${generatedSets.length} question paper sets`,
      request_id: requestId,
      sets: generatedSets
    });

  } catch (err) {
    console.error('Generate sets error:', err);

    if (err.status === 429) {
      return res.status(429).json({
        success: false,
        message: 'AI service rate limit reached. Please wait and try again.',
        error: 'Rate limit exceeded'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to generate question paper sets',
      error: err.message
    });
  }
});

// Faculty/Examiner: Get their generation requests
router.get('/my-requests', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const userId = req.user.user_id;

    const [requests] = await db.query(
      `SELECT request_id, subject, topic, difficulty, num_questions, total_marks, status, created_at,
              (SELECT COUNT(*) FROM question_papers WHERE parent_request_id = request_id) as sets_generated,
              (SELECT COUNT(*) FROM sme_selections WHERE request_id = paper_generation_requests.request_id) as sets_selected
       FROM paper_generation_requests 
       WHERE faculty_id = ? 
       ORDER BY created_at DESC`,
      [userId]
    );

    res.json({ success: true, requests });
  } catch (err) {
    console.error('Fetch requests error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Faculty/Examiner: Get all 10 sets for a specific request
router.get('/request/:requestId/sets', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { requestId } = req.params;
    const userId = req.user.user_id;

    // Verify request belongs to this faculty
    const [requests] = await db.query(
      `SELECT * FROM paper_generation_requests WHERE request_id = ? AND faculty_id = ?`,
      [requestId, userId]
    );

    if (requests.length === 0) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }

    // Get all 10 sets
    const [sets] = await db.query(
      `SELECT qp.paper_id, qp.paper_title, qp.total_marks, qp.set_number, qp.ai_quality_score,
              qp.selected_by_sme, qp.paper_category, qp.created_at, qp.status,
              (SELECT COUNT(*) FROM paper_questions WHERE paper_id = qp.paper_id) as question_count
       FROM question_papers qp
       WHERE qp.parent_request_id = ?
       ORDER BY qp.set_number ASC`,
      [requestId]
    );

    res.json({
      success: true,
      request: requests[0],
      sets
    });
  } catch (err) {
    console.error('Get request sets error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Faculty/Examiner: Delete request (only if status is 'draft')
router.delete('/request/:requestId', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { requestId } = req.params;
    const userId = req.user.user_id;
    // Verify request belongs to this faculty
    const [requests] = await db.query(
      `SELECT * FROM paper_generation_requests WHERE request_id = ? AND faculty_id = ?`,
      [requestId, userId]
    );

    if (requests.length === 0) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }

    if (requests[0].status !== 'draft') {
      return res.status(400).json({ success: false, message: 'Can only delete draft requests. This request has already been sent to SME.' });
    }

    // Delete all papers associated with this request
    const [papers] = await db.query(
      'SELECT paper_id FROM question_papers WHERE parent_request_id = ?',
      [requestId]
    );

    for (const paper of papers) {
      // Delete paper_questions
      await db.query('DELETE FROM paper_questions WHERE paper_id = ?', [paper.paper_id]);

      // Delete questions (if not used elsewhere)
      await db.query(
        `DELETE FROM questions WHERE question_id IN (
          SELECT question_id FROM paper_questions WHERE paper_id = ?
        )`,
        [paper.paper_id]
      );
    }

    // Delete all papers
    await db.query('DELETE FROM question_papers WHERE parent_request_id = ?', [requestId]);

    // Delete the request
    await db.query('DELETE FROM paper_generation_requests WHERE request_id = ?', [requestId]);

    // Log audit
    await db.query(
      'INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, null, 'DELETED_REQUEST', 'paper_generation_request', requestId,
        `Deleted request with ${papers.length} sets`, req.ip]
    );

    res.json({
      success: true,
      message: 'Request and all associated papers deleted successfully'
    });
  } catch (err) {
    console.error('Delete request error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Faculty/Examiner: Send request to SME for selection
router.post('/request/:requestId/send-to-sme', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { requestId } = req.params;
    const userId = req.user.user_id;
    // Verify request belongs to this faculty
    const [requests] = await db.query(
      `SELECT * FROM paper_generation_requests WHERE request_id = ? AND faculty_id = ?`,
      [requestId, userId]
    );

    if (requests.length === 0) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }

    if (requests[0].status !== 'draft') {
      return res.status(400).json({ success: false, message: 'Request already sent to SME' });
    }

    // Check if all 10 sets are generated
    const [sets] = await db.query(
      `SELECT COUNT(*) as count FROM question_papers WHERE parent_request_id = ?`,
      [requestId]
    );

    if (sets[0].count < 10) {
      return res.status(400).json({ success: false, message: 'All 10 sets must be generated before sending to SME' });
    }

    // Update request status to pending_sme_selection
    await db.query(
      'UPDATE paper_generation_requests SET status = ? WHERE request_id = ?',
      ['pending_sme_selection', requestId]
    );

    // Update all papers status to pending
    await db.query(
      'UPDATE question_papers SET status = ? WHERE parent_request_id = ?',
      ['pending', requestId]
    );

    // Log audit
    await db.query(
      'INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, null, 'SENT_TO_SME', 'paper_generation_request', requestId,
        `Sent 10 sets to SME for selection`, req.ip]
    );

    res.json({
      success: true,
      message: 'Successfully sent 10 sets to SME for selection'
    });
  } catch (err) {
    console.error('Send to SME error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// New endpoint: Generate question paper from PDF reference with variations for each sub-question
router.post('/generate-from-pdf', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { paper_name, subject, topic, num_variations, pdf_id } = req.body;
    const userId = req.user.user_id;
    // SOCKET.IO COMMENTED OUT - Not currently in use
    // const io = req.app.get('io');

    // Validate inputs
    if (!paper_name || !subject || !topic || !num_variations || !pdf_id) {
      return res.status(400).json({
        success: false,
        message: 'Paper name, subject, topic, number of variations, and PDF are required'
      });
    }

    if (num_variations < 4 || num_variations > 50) {
      return res.status(400).json({
        success: false,
        message: 'Number of variations must be between 4 and 50'
      });
    }

    // Get PDF content
    const [pdfs] = await db.query(
      'SELECT * FROM uploaded_pdfs WHERE pdf_id = ?',
      [pdf_id]
    );

    if (pdfs.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'PDF not found'
      });
    }

    const pdfData = pdfs[0];
    const pdfContent = pdfData.extracted_text || '';

    if (!pdfContent) {
      return res.status(400).json({
        success: false,
        message: 'PDF has no extractable text content'
      });
    }

    // Get university ID
    const universityId = 1; // Default university in subject-based system

    // Truncate PDF content if too long
    const maxContextLength = 20000;
    const truncatedContent = pdfContent.length > maxContextLength
      ? pdfContent.substring(0, maxContextLength) + '...[truncated]'
      : pdfContent;

    // Step 1: Analyze PDF and generate question paper structure
    console.log('📄 Analyzing PDF structure...');

    const structurePrompt = `You are an expert question paper analyzer. Analyze the following reference PDF and extract its STRUCTURE.

REFERENCE PDF CONTENT:
${truncatedContent}

TASK: Extract the question paper structure with main questions and sub-questions.

INSTRUCTIONS:
1. Identify all main questions (Q1, Q2, Q3, etc.)
2. For each main question, identify sub-questions (a, b, c, etc.)
3. Extract marks for each sub-question
4. Identify question types and difficulty levels
5. Note the overall structure and pattern

IMPORTANT - Use ONLY these question types:
- "mcq" for Multiple Choice Questions
- "short_answer" for Short Answer Questions (2-3 sentences)
- "long_answer" for Long Answer/Essay Questions (paragraphs)
- "true_false" for True/False Questions
- "fill_blank" for Fill in the Blanks
- "matching" for Matching Questions

Return ONLY valid JSON (no markdown):
{
  "questions": [
    {
      "question_number": 1,
      "question_type": "short_answer",
      "total_marks": 10,
      "sub_questions": [
        {
          "sub_number": "a",
          "marks": 2,
          "question_type": "short_answer",
          "difficulty": "medium",
          "description": "Brief description of what this sub-question asks"
        },
        {
          "sub_number": "b",
          "marks": 3,
          "question_type": "mcq",
          "difficulty": "easy",
          "description": "Brief description"
        }
      ]
    }
  ],
  "total_marks": 100
}`;

    let structureText = await callGeminiAPI(structurePrompt);
    structureText = structureText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    let paperStructure;
    try {
      paperStructure = JSON.parse(structureText);
    } catch (parseError) {
      console.error('JSON Parse Error:', parseError.message);
      let fixedText = structureText.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
      paperStructure = JSON.parse(fixedText);
    }

    console.log(`✅ Extracted structure: ${paperStructure.questions.length} main questions`);

    // Step 2: Create the paper record
    const [paperResult] = await db.query(
      `INSERT INTO question_papers 
       (generated_by, paper_title, total_marks, status, reference_pdf_id, reference_pdf_name) 
       VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
      [userId, collegeId, paper_name, paperStructure.total_marks, pdf_id, pdfData.file_name]
    );

    const paperId = paperResult.insertId;

    // Step 3: For each main question with sub-questions, create questions and sub_questions, then generate variations
    for (const mainQ of paperStructure.questions) {
      if (!mainQ.sub_questions || mainQ.sub_questions.length === 0) continue;

      // Normalize question type
      const normalizedMainType = normalizeQuestionType(mainQ.question_type);

      // Create main question (parent question)
      const [questionResult] = await db.query(
        `INSERT INTO questions 
         (university_id, created_by, question_text, question_type, difficulty, marks, status) 
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
        [universityId, userId,
          `Question ${mainQ.question_number}`,
          normalizedMainType,
          'medium',
          mainQ.total_marks]
      );

      const parentQuestionId = questionResult.insertId;

      // Link question to paper
      await db.query(
        'INSERT INTO paper_questions (paper_id, question_id, question_order) VALUES (?, ?, ?)',
        [paperId, parentQuestionId, mainQ.question_number - 1]
      );

      // For each sub-question, create sub_questions and generate variations
      for (const subQ of mainQ.sub_questions) {
        const fullQuestionNumber = `${mainQ.question_number}${subQ.sub_number}`;

        // Normalize sub-question type
        const normalizedSubType = normalizeQuestionType(subQ.question_type);

        // Truncate description to fit section_name column (max 100 chars)
        const truncatedDescription = (subQ.description || '').substring(0, 100);

        // Create sub_question record
        const [subQuestionResult] = await db.query(
          `INSERT INTO sub_questions 
           (parent_question_id, paper_id, sub_question_number, full_question_number, question_type, marks, section_name, created_by) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [parentQuestionId, paperId, subQ.sub_number, fullQuestionNumber,
            normalizedSubType, subQ.marks,
            truncatedDescription, userId, collegeId]
        );

        const subQuestionId = subQuestionResult.insertId;

        console.log(`Generating ${num_variations} variations for Q${mainQ.question_number}(${subQ.sub_number})...`);

        // Generate variations for this sub-question
        const variationPrompt = `Generate ${num_variations} DIFFERENT variations of a question based on this specification:

SUBJECT: ${subject}
TOPIC: ${topic}
QUESTION TYPE: ${subQ.question_type}
MARKS: ${subQ.marks}
DIFFICULTY: ${subQ.difficulty}
DESCRIPTION: ${subQ.description}

CRITICAL JSON FORMATTING RULES:
1. Return ONLY valid JSON - no markdown, no extra text
2. Use double quotes for all strings
3. Escape special characters properly:
   - Use \\" for quotes inside strings
   - Use \\n for line breaks
   - Use \\\\ for backslashes
4. Complete ALL fields for ALL ${num_variations} variations
5. Do NOT truncate any field - complete all answers fully

INSTRUCTIONS:
1. Generate ${num_variations} UNIQUE questions
2. Each question should test: ${topic}
3. Match difficulty: ${subQ.difficulty}
4. Worth ${subQ.marks} marks each
5. Type: ${subQ.question_type}
${subQ.question_type === 'mcq' ? '6. For MCQ: provide exactly 4 options and mark the correct one' : ''}
${subQ.question_type === 'long_answer' ? '6. For long answers: provide comprehensive 2-3 paragraph answers' : ''}
${subQ.question_type === 'short_answer' ? '6. For short answers: provide 2-3 sentence answers' : ''}

Return in this EXACT JSON format (no markdown):
{
  "variations": [
    {
      "question_text": "Q${mainQ.question_number}.${subQ.sub_number}.1 Your complete question here",
      ${subQ.question_type === 'mcq' ? '"options": ["Option A text", "Option B text", "Option C text", "Option D text"],' : ''}
      "correct_answer": "Your complete answer here - can be as long as needed",
      "marks": ${subQ.marks},
      "difficulty": "${subQ.difficulty}"
    }
  ]
}

IMPORTANT: 
- Generate ALL ${num_variations} variations
- Complete every field fully - no truncation
- Ensure valid JSON structure
- Test different aspects of ${topic}`;

        // In your backend generate-variations endpoint, improve the JSON parsing:

        let variationsText = await callGeminiAPI(variationPrompt);
        variationsText = variationsText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        let variationsData;
        try {
          variationsData = JSON.parse(variationsText);
        } catch (parseError) {
          console.error(`JSON Parse Error for variation: ${parseError.message}`);
          console.error(`Raw text: ${variationsText.substring(0, 500)}`);

          // Try multiple fix strategies
          let fixedText = variationsText;

          // Strategy 1: Fix common escape issues
          fixedText = fixedText
            .replace(/\\"/g, '\\"')  // Ensure quotes are properly escaped
            .replace(/\n/g, '\\n')   // Escape newlines
            .replace(/\t/g, '\\t')   // Escape tabs
            .replace(/\r/g, '\\r');  // Escape carriage returns

          try {
            variationsData = JSON.parse(fixedText);
            console.log('✅ Fixed JSON successfully with strategy 1');
          } catch (secondError) {
            console.error('Strategy 1 failed, trying strategy 2...');

            // Strategy 2: Try to extract valid JSON using regex
            try {
              const jsonMatch = fixedText.match(/\{[\s\S]*"variations"[\s\S]*\[[\s\S]*\][\s\S]*\}/);
              if (jsonMatch) {
                variationsData = JSON.parse(jsonMatch[0]);
                console.log('✅ Fixed JSON successfully with strategy 2');
              } else {
                throw new Error('Could not extract valid JSON');
              }
            } catch (thirdError) {
              console.error('All JSON fix strategies failed. Skipping this batch.');

              // Return empty variations array instead of crashing
              variationsData = { variations: [] };

              // Log the error for debugging
              await db.query(
                'INSERT INTO error_logs (error_type, error_message, error_details) VALUES (?, ?, ?)',
                ['JSON_PARSE_ERROR', parseError.message, variationsText.substring(0, 1000)]
              );
            }
          }
        }

        // Validate that variations array exists
        if (!variationsData || !variationsData.variations || !Array.isArray(variationsData.variations)) {
          console.error(`Invalid variations data structure. Expected {variations: [...]} but got:`, variationsData);
          variationsData = { variations: [] };
        }

        // Filter out invalid variations
        variationsData.variations = variationsData.variations.filter(v => {
          // Check if variation has required fields
          if (!v.question_text || !v.correct_answer) {
            console.warn('Skipping invalid variation:', v);
            return false;
          }
          return true;
        });

        if (variationsData.variations.length === 0) {
          console.error(`No valid variations generated. Retrying with simpler prompt...`);
          // You could retry here with a simpler prompt
        }

        // Validate that variations array exists
        if (!variationsData || !variationsData.variations || !Array.isArray(variationsData.variations)) {
          console.error(`Invalid variations data structure for Q${mainQ.question_number}(${subQ.sub_number}). Expected {variations: [...]} but got:`, variationsData);
          console.log(`Skipping Q${mainQ.question_number}(${subQ.sub_number}) - will retry later if needed`);
          continue; // Skip this sub-question
        }

        // Ensure we have at least some variations
        if (variationsData.variations.length === 0) {
          console.error(`No variations generated for Q${mainQ.question_number}(${subQ.sub_number})`);
          continue; // Skip this sub-question
        }

        // Insert variations into question_variations table
        for (let i = 0; i < variationsData.variations.length && i < num_variations; i++) {
          const variation = variationsData.variations[i];

          // Ensure MCQ has proper options
          if (normalizedSubType === 'mcq') {
            if (!variation.options || !Array.isArray(variation.options) || variation.options.length === 0) {
              variation.options = ['Option A', 'Option B', 'Option C', 'Option D'];
            }
            while (variation.options.length < 4) variation.options.push(`Option ${String.fromCharCode(65 + variation.options.length)}`);
            if (variation.options.length > 4) variation.options = variation.options.slice(0, 4);
          }

          await db.query(
            `INSERT INTO question_variations 
             (parent_question_id, sub_question_id, paper_id, variation_number, question_text, question_type, options, correct_answer, marks, difficulty, section_name, created_by, status) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
            [
              parentQuestionId,
              subQuestionId,
              paperId,
              i + 1,
              variation.question_text,
              normalizedSubType,
              variation.options ? JSON.stringify(variation.options) : null,
              variation.correct_answer,
              subQ.marks,
              subQ.difficulty || 'medium',
              truncatedDescription,
              userId,
              collegeId
            ]
          );
        }

        const actualVariationsInserted = Math.min(variationsData.variations.length, num_variations);
        console.log(`✅ Generated ${actualVariationsInserted} variations for Q${mainQ.question_number}(${subQ.sub_number})`);
        
        // SOCKET.IO COMMENTED OUT - Not currently in use
        // // Emit real-time update to frontend
        // if (io) {
        //   io.emit('variation-progress', {
        //     paperId: paperId,
        //     questionNumber: mainQ.question_number,
        //     subQuestionNumber: subQ.sub_number,
        //     variationsGenerated: actualVariationsInserted,
        //     totalVariations: num_variations,
        //     message: `Generated ${actualVariationsInserted} variations for Q${mainQ.question_number}(${subQ.sub_number})`
        //   });
        // }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    console.log(`\n✅ Paper generation completed for paper ID: ${paperId}`);

    // Log audit
    await db.query(
      'INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, null, 'GENERATED_FROM_PDF', 'question_paper', paperId,
        `Generated paper from PDF: ${pdfData.file_name} with ${num_variations} variations per sub-question`, req.ip]
    );

    res.status(201).json({
      success: true,
      message: `Successfully generated question paper with ${num_variations} variations per sub-question`,
      paper_id: paperId,
      paper_title: paper_name,
      total_questions: paperStructure.questions.length,
      reference_pdf: {
        pdf_id: pdfData.pdf_id,
        file_name: pdfData.file_name
      }
    });

  } catch (err) {
    console.error('Generate from PDF error:', err);

    if (err.status === 429) {
      return res.status(429).json({
        success: false,
        message: 'AI service rate limit reached. Please wait and try again.',
        error: 'Rate limit exceeded'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to generate question paper from PDF',
      error: err.message
    });
  }
});

module.exports = router;
