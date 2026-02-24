const express = require('express');
const db = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const axios = require('axios');

const router = express.Router();

// Helper function to call Gemini API
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
          temperature: 0.9, // Higher for more variety
          maxOutputTokens: 8192,
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 60000
      }
    );

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

// Generate question with multiple variations
router.post('/generate-with-variations', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { paper_id, subject, topic, question_number, question_type, marks, num_variations, section_name } = req.body;
    const userId = req.user.user_id;
    const subjectId = req.user.subject_id;

    if (!paper_id || !subject || !topic || !question_number || !num_variations) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    console.log(`📝 Generating ${num_variations} variations for ${question_number}...`);

    // Create parent question (subject-based system)
    const [parentResult] = await db.query(
      `INSERT INTO questions (question_text, question_type, marks, difficulty, created_by, subject_id, status, has_variations) 
       VALUES (?, ?, ?, ?, ?, ?, 'draft', TRUE)`,
      [
        `${question_number} - ${subject} - ${topic}`,
        question_type || 'short_answer',
        marks || 5,
        'medium',
        userId,
        subjectId
      ]
    );

    const parentQuestionId = parentResult.insertId;

    // Link to paper
    const [countResult] = await db.query(
      'SELECT COUNT(*) as count FROM paper_questions WHERE paper_id = ?',
      [paper_id]
    );
    const questionOrder = countResult[0].count + 1;

    await db.query(
      'INSERT INTO paper_questions (paper_id, question_id, question_order) VALUES (?, ?, ?)',
      [paper_id, parentQuestionId, questionOrder]
    );

    // Determine difficulty distribution for variety
    const getDifficultyForVariation = (index, total) => {
      const ratio = index / total;
      if (ratio < 0.3) return 'Easy';
      if (ratio < 0.7) return 'Medium';
      return 'Hard';
    };

    // Generate variations
    const variations = [];
    for (let i = 1; i <= num_variations; i++) {
      const suggestedDifficulty = getDifficultyForVariation(i, num_variations);
      
      const prompt = `Generate 1 NEW ${question_type || 'short_answer'} question for ${subject} - ${topic}.

Question Number: ${question_number}.${i}
Question Type: ${question_type || 'short_answer'}
Marks: ${marks || 5}
Suggested Difficulty: ${suggestedDifficulty} (adjust based on question complexity)
${section_name ? `Section: ${section_name}` : ''}

Generate a UNIQUE question (different from previous variations). 

**VARY THE DIFFICULTY**: Create a mix of Easy, Medium, and Hard questions across all variations.

**🔴 CRITICAL EQUATION FORMATTING REQUIREMENTS:**
When including mathematical equations or formulas in the question_text or correct_answer:
1. Use proper LaTeX notation with fractions, subscripts, and superscripts
2. Format fractions as: \\frac{numerator}{denominator}
3. Format subscripts as: variable_{subscript} (e.g., n_{1V}, K_{2})
4. Format superscripts as: variable^{superscript}
5. Wrap entire equations in dollar signs for inline math: $equation$
6. For display equations, use: $$equation$$

EXAMPLES OF CORRECT FORMATTING:
- Fraction: $\\frac{K_1}{K_2}$
- With subscripts: $\\frac{n_{2V} - n_{2R}}{n_{1V} - n_{1R}}$
- Complex equation: $\\frac{K_1}{K_2} = -\\frac{n_{2V} - n_{2R}}{n_{1V} - n_{1R}}$
- Subscript example: $v_{avg}$, $n_{1R}$, $K_{2}$

IMPORTANT: Provide detailed metadata for this question:

**🔴 CRITICAL ACCURACY REQUIREMENTS:**
1. Write ALL metadata fields in ENGLISH ONLY
2. Provide REAL, ACCURATE, VERIFIABLE references from actual textbooks
3. DO NOT make up fake chapter names, page numbers, or book editions
4. If you don't know the exact reference, use general but accurate information

1. **reference_source**: Provide ACCURATE reference from ANY STANDARD TEXTBOOK commonly used in schools/colleges (IN ENGLISH):
   
   **ACCURACY RULES:**
   - Use ANY well-known textbook that is commonly used in educational institutions
   - Can be NCERT, state board, university textbooks, or popular reference books
   - Provide ONLY book name and chapter name
   - DO NOT include chapter numbers or page numbers
   - DO NOT invent fake chapter names or fake books
   - Write in ENGLISH ONLY
   
   Format: "Book: [Real Textbook Title], Chapter: [Real Chapter Name]"
   
   **Examples of Standard Textbooks (use any appropriate one):**
   - Biology: NCERT Biology, Campbell Biology, Trueman's Biology, Pradeep's Biology
   - Physics: NCERT Physics, Concepts of Physics by H.C. Verma, Pradeep's Physics
   - Chemistry: NCERT Chemistry, Physical Chemistry by O.P. Tandon, Modern's ABC Chemistry
   - Mathematics: NCERT Mathematics, R.D. Sharma, RS Aggarwal, Higher Engineering Mathematics by B.S. Grewal
   - Computer Science: NCERT Computer Science, Sumita Arora, Let Us C by Yashavant Kanetkar
   
   **CORRECT FORMAT:**
   "Book: Campbell Biology, Chapter: Cell Structure and Function"
   "Book: Concepts of Physics by H.C. Verma, Chapter: Laws of Motion"
   
   **WRONG FORMAT (Don't use):**
   ❌ "Book: Biology Textbook, Chapter 5: Cells, Pages 97-122"

2. **difficulty_level**: Classify ACCURATELY as "Easy", "Medium", or "Hard" (IN ENGLISH) based on:
   - Easy: Basic recall, definitions, simple concepts
   - Medium: Understanding, application, comparison
   - Hard: Analysis, synthesis, complex problem-solving

3. **difficulty_reason**: Provide ACCURATE explanation WHY you classified it at this difficulty level (2-3 sentences IN ENGLISH ONLY)
   - Be specific about what cognitive skills are required
   - Explain what makes it easy/medium/hard

Return ONLY valid JSON:

{
  "question_text": "${question_number}.${i} Question text here (use LaTeX for equations: $\\frac{a}{b}$ or $$equation$$)",
  "correct_answer": "Answer here (use LaTeX for equations: $\\frac{a}{b}$ or $$equation$$)",
  ${question_type === 'mcq' ? '"options": ["A) Option 1", "B) Option 2", "C) Option 3", "D) Option 4"],' : ''}
  "marks": ${marks || 5},
  "reference_source": "Book: [Textbook Name], Chapter: [Chapter Name]",
  "difficulty_level": "Easy|Medium|Hard",
  "difficulty_reason": "Explanation in ENGLISH of why this difficulty level"
}`;

      try {
        const questionText = await callGeminiAPI(prompt);
        const cleanText = questionText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const questionData = JSON.parse(cleanText);

        const options = questionData.options ? JSON.stringify(questionData.options) : null;

        // Extract metadata from AI response
        const referenceSource = questionData.reference_source || null;
        const difficultyLevel = questionData.difficulty_level || 'Medium';
        const difficultyReason = questionData.difficulty_reason || null;

        const [variationResult] = await db.query(
          `INSERT INTO question_variations 
           (parent_question_id, paper_id, variation_number, question_text, question_type, options, correct_answer, marks, difficulty, section_name, created_by, subject_id, status, reference_source, difficulty_level, difficulty_reason) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
          [
            parentQuestionId,
            paper_id,
            i,
            questionData.question_text,
            question_type || 'short_answer',
            options,
            questionData.correct_answer,
            marks || 5,
            'medium',
            section_name || null,
            userId,
            subjectId,
            referenceSource,
            difficultyLevel,
            difficultyReason
          ]
        );

        variations.push({
          variation_id: variationResult.insertId,
          variation_number: i,
          question_text: questionData.question_text,
          correct_answer: questionData.correct_answer,
          options: questionData.options,
          marks: marks || 5,
          status: 'draft',
          reference_source: referenceSource,
          difficulty_level: difficultyLevel,
          difficulty_reason: difficultyReason
        });

        console.log(`✅ Generated variation ${i}/${num_variations}`);
      } catch (err) {
        console.error(`❌ Failed to generate variation ${i}:`, err.message);
      }
    }

    // Update paper to use variations mode
    await db.query(
      'UPDATE question_papers SET uses_variations = TRUE WHERE paper_id = ?',
      [paper_id]
    );

    console.log(`✅ Generated ${variations.length} variations for ${question_number}`);

    res.status(201).json({
      success: true,
      message: `Generated ${variations.length} variations`,
      parent_question_id: parentQuestionId,
      question_number,
      variations
    });

  } catch (err) {
    console.error('Generate variations error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate variations', error: err.message });
  }
});

// Get all variations for a question
router.get('/questions/:question_id/variations', authMiddleware, async (req, res) => {
  try {
    const { question_id } = req.params;

    const [variations] = await db.query(
      `SELECT v.*, u.name as created_by_name
       FROM question_variations v
       LEFT JOIN users u ON v.created_by = u.user_id
       WHERE v.parent_question_id = ?
       ORDER BY v.variation_number`,
      [question_id]
    );

    res.json({ success: true, variations });
  } catch (err) {
    console.error('Get variations error:', err);
    res.status(500).json({ success: false, message: 'Failed to get variations' });
  }
});

// Send variations to SME
router.post('/variations/send-to-sme', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { variation_ids, sme_id } = req.body;
    const examinerId = req.user.user_id;

    if (!variation_ids || !Array.isArray(variation_ids) || variation_ids.length === 0) {
      return res.status(400).json({ success: false, message: 'No variations selected' });
    }

    if (!sme_id) {
      return res.status(400).json({ success: false, message: 'SME not specified' });
    }

    // Update variation status
    await db.query(
      `UPDATE question_variations SET status = 'sent_to_sme' WHERE variation_id IN (?)`,
      [variation_ids]
    );

    // Create review records
    for (const variationId of variation_ids) {
      await db.query(
        `INSERT INTO sme_variation_reviews (variation_id, sme_id, examiner_id, status) 
         VALUES (?, ?, ?, 'pending')`,
        [variationId, sme_id, examinerId]
      );
    }

    console.log(`✅ Sent ${variation_ids.length} variations to SME ${sme_id}`);

    res.json({
      success: true,
      message: `Sent ${variation_ids.length} variations to SME for review`
    });

  } catch (err) {
    console.error('Send to SME error:', err);
    res.status(500).json({ success: false, message: 'Failed to send variations to SME' });
  }
});

// SME: Get pending variation reviews
router.get('/sme/pending-reviews', authMiddleware, requireRole('subject_matter_expert'), async (req, res) => {
  try {
    const smeId = req.user.user_id;

    const [reviews] = await db.query(
      `SELECT r.*, v.*, q.question_text as parent_question, u.name as examiner_name
       FROM sme_variation_reviews r
       JOIN question_variations v ON r.variation_id = v.variation_id
       JOIN questions q ON v.parent_question_id = q.question_id
       JOIN users u ON r.examiner_id = u.user_id
       WHERE r.sme_id = ? AND r.status = 'pending'
       ORDER BY r.created_at DESC`,
      [smeId]
    );

    res.json({ success: true, reviews });
  } catch (err) {
    console.error('Get pending reviews error:', err);
    res.status(500).json({ success: false, message: 'Failed to get pending reviews' });
  }
});

// // SME: Review variation
// router.post('/variations/:variation_id/review', authMiddleware, requireRole('subject_matter_expert'), async (req, res) => {
//   try {
//     const { variation_id } = req.params;
//     const { status, comments } = req.body;
//     const smeId = req.user.user_id;

//     if (!['approved', 'rejected'].includes(status)) {
//       return res.status(400).json({ success: false, message: 'Invalid status' });
//     }

//     // Update review
//     await db.query(
//       `UPDATE sme_variation_reviews 
//        SET status = ?, comments = ?, reviewed_at = NOW() 
//        WHERE variation_id = ? AND sme_id = ?`,
//       [status, comments, variation_id, smeId]
//     );

//     // Update variation status
//     await db.query(
//       `UPDATE question_variations SET status = ? WHERE variation_id = ?`,
//       [status, variation_id]
//     );

//     console.log(`✅ SME reviewed variation ${variation_id}: ${status}`);

//     res.json({ success: true, message: 'Review submitted successfully' });

//   } catch (err) {
//     console.error('Review variation error:', err);
//     res.status(500).json({ success: false, message: 'Failed to submit review' });
//   }
// });

// Finalize variation (make it the official question)
router.post('/variations/:variation_id/finalize', authMiddleware, async (req, res) => {
  try {
    const { variation_id } = req.params;

    // Get variation details
    const [variations] = await db.query(
      'SELECT * FROM question_variations WHERE variation_id = ?',
      [variation_id]
    );

    if (variations.length === 0) {
      return res.status(404).json({ success: false, message: 'Variation not found' });
    }

    const variation = variations[0];

    // Mark this variation as selected and finalized
    await db.query(
      `UPDATE question_variations 
       SET is_selected = TRUE, status = 'finalized' 
       WHERE variation_id = ?`,
      [variation_id]
    );

    // Unselect other variations of the same parent
    await db.query(
      `UPDATE question_variations 
       SET is_selected = FALSE 
       WHERE parent_question_id = ? AND variation_id != ?`,
      [variation.parent_question_id, variation_id]
    );

    console.log(`✅ Finalized variation ${variation_id}`);

    res.json({ success: true, message: 'Variation finalized successfully' });

  } catch (err) {
    console.error('Finalize variation error:', err);
    res.status(500).json({ success: false, message: 'Failed to finalize variation' });
  }
});

module.exports = router;
