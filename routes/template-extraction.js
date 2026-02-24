// Extract paper structure from uploaded PDF
const express = require('express');
const multer = require('multer');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('../config/db');

const router = express.Router();

// Configure multer for PDF uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const { getModelSelector } = require('../utils/modelSelector');

// Extract structure from PDF
router.post('/extract-structure', authMiddleware, requireRole('examiner'), upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No PDF file uploaded' });
    }

    // Get model selector and select best available model
    const modelSelector = getModelSelector();
    const selectedModel = await modelSelector.selectBestModel();
    
    console.log(`📤 Extracting structure from ${req.file.originalname} using model: ${selectedModel}...`);

    // Always use vision API for better Unicode/multilingual support
    console.log('🖼️ Using Gemini Vision API to read PDF directly...');

    // Use Gemini to analyze the structure
    const model = genAI.getGenerativeModel({ 
      model: selectedModel,
      systemInstruction: 'You are a text extraction assistant. Your ONLY job is to copy text EXACTLY as it appears. NEVER translate, convert, or modify any text. Preserve all languages, scripts, and characters exactly as they are in the source.'
    });

    const prompt = `⚠️⚠️⚠️ ABSOLUTE CRITICAL RULE - READ THIS FIRST ⚠️⚠️⚠️

YOU ARE A COPY MACHINE - NOT A TRANSLATOR!
YOUR JOB: Copy text EXACTLY character-by-character from the PDF image
FORBIDDEN: Translation, conversion, interpretation, or modification of ANY text

If you translate ANYTHING, you have FAILED this task completely.

⚠️⚠️⚠️ MOST IMPORTANT RULES ⚠️⚠️⚠️
1. DO NOT TRANSLATE ANYTHING - Keep ALL text in its ORIGINAL LANGUAGE
2. If the PDF shows Hindi/Urdu/Arabic/Marathi text - keep it in that SAME language
3. Copy question numbers and sub-question numbers EXACTLY as they appear
4. DO NOT convert characters, numbers, or formats
5. PRESERVE the original script and language for EVERYTHING

Analyze this question paper IMAGE and extract its complete structure including ALL sub-questions. Return ONLY a valid JSON object (no markdown, no code blocks, no extra text).

Look at the image carefully and copy ALL text EXACTLY as you see it.

📊 INTELLIGENT MARKS INFERENCE FROM HEADER:
Look at the PDF header/title section for clues about marks distribution:

**SCENARIO 1: Total Questions = Total Marks (e.g., "200 Questions, 200 Marks")**
→ Each question is 1 mark

**SCENARIO 2: PCM Exam (Physics, Chemistry, Mathematics)**
→ Physics: 50 questions × 1 mark = 50 marks
→ Chemistry: 50 questions × 1 mark = 50 marks  
→ Mathematics: 50 questions × 2 marks = 100 marks
→ Total: 150 questions, 200 marks

**SCENARIO 3: Subject-wise breakdown mentioned in header**
→ Use the specified marks per subject/section

**SCENARIO 4: Marks shown per question in PDF**
→ Copy the exact marks shown

**SCENARIO 5: No marks information visible**
→ Default to 1 mark per question

🔍 HEADER ANALYSIS STEPS:
1. Read the PDF header/title carefully
2. Look for patterns like "X Questions, Y Marks" or "PCM" or subject names
3. Calculate marks per question based on the pattern
4. If Mathematics is mentioned with Physics/Chemistry, assume Math questions are 2 marks each
5. Apply the calculated marks to ALL questions in that section

**CRITICAL EXAMPLES - WHAT TO DO AND WHAT NOT TO DO:**

Example - PDF shows "प्र.१ अ) ब) क)":
✅ CORRECT: {"question_number":"प्र.१", "subquestions":[{"sub_number":"अ)"},{"sub_number":"ब)"},{"sub_number":"क)"}]}
❌ WRONG: {"question_number":"A-1", "subquestions":[{"sub_number":"v½"},{"sub_number":"c½"},{"sub_number":"d½"}]}
❌ WRONG: {"question_number":"Q.1", "subquestions":[{"sub_number":"a)"},{"sub_number":"b)"},{"sub_number":"c)"}]}

Example - PDF shows "M.A. (Pali) परीक्षा: ऑक्टोबर २०२५":
✅ CORRECT: {"template_name": "M.A. (Pali) परीक्षा: ऑक्टोबर २०२५"}
❌ WRONG: {"template_name": "M.A. (Pali) Exam: October 2025"}

🎯 DIFFICULTY ASSIGNMENT RULES:
Analyze the DEPTH OF UNDERSTANDING and COGNITIVE COMPLEXITY required to answer each question:

**Easy Questions (30-40% of total marks):**
COGNITIVE LEVEL: Remember/Recall
- Requires only memorization and retrieval of information
- No understanding or application needed
- Student can answer by directly recalling facts
- Examples:
  * "What is the capital of France?" (Simple fact)
  * "Define photosynthesis" (Memorized definition)
  * "List the planets in order" (Recalled list)
  * "State Newton's first law" (Memorized law)

**Medium Questions (40-50% of total marks):**
COGNITIVE LEVEL: Understand/Apply/Analyze
- Requires understanding concepts and applying them
- Student must comprehend relationships and connections
- Involves interpretation, comparison, or problem-solving
- Examples:
  * "Why does ice float on water?" (Understanding molecular structure)
  * "How would increasing temperature affect reaction rate?" (Apply concept)
  * "Compare mitosis and meiosis" (Analyze differences)
  * "Calculate the force given mass and acceleration" (Apply formula with understanding)

**Hard Questions (20-30% of total marks):**
COGNITIVE LEVEL: Evaluate/Create/Synthesize
- Requires deep conceptual understanding and critical thinking
- Student must integrate multiple concepts or create new solutions
- Involves evaluation, justification, or complex reasoning
- Examples:
  * "Why is the sky blue? Explain using wave theory" (Deep understanding + synthesis)
  * "Evaluate the effectiveness of renewable energy policies" (Critical evaluation)
  * "Derive the equation for projectile motion" (Create/synthesize)
  * "Design an experiment to test enzyme activity" (Create with reasoning)

⚠️ CRITICAL RULES:
1. IGNORE answer length - A one-word answer can be hard if it requires deep understanding
2. IGNORE question type - MCQ, short, or long answer doesn't determine difficulty
3. FOCUS ON: What level of understanding does the student need to answer correctly?
4. ASK YOURSELF: Can a student answer this by just memorizing, or do they need to truly understand?

EXAMPLES OF COMMON MISTAKES TO AVOID:
❌ WRONG: "Long answer = Hard" → A long descriptive answer can be easy if it's just recall
❌ WRONG: "MCQ = Easy" → An MCQ testing deep concepts is hard
❌ WRONG: "Calculate = Medium" → Simple arithmetic is easy; complex derivation is hard
✅ CORRECT: Judge by the DEPTH OF THINKING required, not the format or length

The difficulty_weightage percentages MUST total exactly 100.
Assign each question/subquestion a difficulty level: "easy", "medium", or "hard" based on COGNITIVE DEPTH

Return JSON in this format:
{
  "template_name": "[Copy EXACT title from PDF - DO NOT TRANSLATE]",
  "description": "[Copy EXACT description from PDF - DO NOT TRANSLATE]",
  "total_marks": 100,
  "difficulty_weightage": {
    "easy": 35,
    "medium": 45,
    "hard": 20
  },
  "questions": [
    {
      "question_number": "[EXACT number from PDF]",
      // "question_text": "[EXACT question text from PDF - DO NOT TRANSLATE]",
      "question_type": "mcq",
      // "difficulty": "easy",
      // "difficulty_reason": "Simple recall question",
      "has_subquestions": true,
      "marks": 0,
      "subquestions": [
        {
          "sub_number": "[EXACT sub-number from PDF]",
          "sub_question_text": "[EXACT text from PDF]",
          "marks": 1,
          "difficulty": "medium",
          "difficulty_reason": "Requires application of concept"
        }
      ]
    }
  ]
}

🎯 MARKS ASSIGNMENT LOGIC:
1. If header says "200 Questions, 200 Marks" → Each question/subquestion = 1 mark
2. If header mentions "PCM" or lists Physics/Chemistry/Mathematics:
   - Physics questions = 1 mark each
   - Chemistry questions = 1 mark each
   - Mathematics questions = 2 marks each
3. If marks are shown next to questions in PDF → Use those exact marks
4. If no marks info → Default to 1 mark per question
5. Calculate total_marks by summing all question/subquestion marks
6. For questions with subquestions: parent marks = 0, all marks go to subquestions

CRITICAL STEPS:
1. **READ THE HEADER FIRST** - Look for total questions, total marks, subject names (PCM = Physics, Chemistry, Math)
2. **INFER MARKS PATTERN** - Calculate marks per question based on header info
3. Copy ALL text EXACTLY as shown in the PDF. DO NOT translate, convert, or modify anything.
4. READ each question's content carefully
5. For EACH question, ask: "What depth of understanding is needed to answer this?"
   - Can they answer by just recalling facts? → Easy
   - Do they need to understand and apply concepts? → Medium
   - Do they need deep understanding and critical thinking? → Hard
6. IGNORE the answer length, question type, or format
7. Assign difficulty based ONLY on cognitive depth required
8. **ASSIGN MARKS** based on the pattern you inferred from the header
9. Calculate difficulty_weightage based on marks distribution (must total 100%)
10. Provide brief difficulty_reason explaining the cognitive level required
11. Assign difficulty level to EVERY question and subquestion based on their individual cognitive depth

📋 COMPLETE EXAMPLE - PCM EXAM:

PDF Header shows: "JEE Main 2025 - PCM Exam - 150 Questions, 200 Marks"

Your analysis:
- Total: 150 questions, 200 marks
- PCM = Physics + Chemistry + Mathematics
- Pattern: 50 Physics (1 mark each) + 50 Chemistry (1 mark each) + 50 Math (2 marks each)
- Physics: 50 questions × 1 mark = 50 marks
- Chemistry: 50 questions × 1 mark = 50 marks
- Mathematics: 50 questions × 2 marks = 100 marks

Your JSON output:
{
  "template_name": "JEE Main 2025 - PCM Exam",
  "total_marks": 200,
  "questions": [
    // Physics Section (Questions 1-50, 1 mark each)
    {"question_number": "1", "question_type": "mcq", "has_subquestions": false, "marks": 1, "difficulty": "medium"},
    {"question_number": "2", "question_type": "mcq", "has_subquestions": false, "marks": 1, "difficulty": "easy"},
    // ... more physics questions with 1 mark each
    
    // Chemistry Section (Questions 51-100, 1 mark each)
    {"question_number": "51", "question_type": "mcq", "has_subquestions": false, "marks": 1, "difficulty": "medium"},
    // ... more chemistry questions with 1 mark each
    
    // Mathematics Section (Questions 101-150, 2 marks each)
    {"question_number": "101", "question_type": "mcq", "has_subquestions": false, "marks": 2, "difficulty": "hard"},
    {"question_number": "102", "question_type": "mcq", "has_subquestions": false, "marks": 2, "difficulty": "medium"},
    // ... more math questions with 2 marks each
  ]
}

EXAMPLE ANALYSIS TO GUIDE YOUR THINKING:

Question: "What is photosynthesis?"
→ Easy (Student can answer by recalling memorized definition - no understanding needed)

Question: "Why do plants need sunlight for photosynthesis?"
→ Medium (Student must understand the relationship between light energy and chemical reactions)

Question: "Explain why C4 plants are more efficient than C3 plants in hot climates"
→ Hard (Student must deeply understand biochemical pathways, environmental factors, and evolutionary adaptation)

Question: "Write 1000 words on the history of computers from 1940-2000"
→ Easy (Long answer, but just listing historical facts - pure recall)

Question: "Why?"
→ Could be Hard! (One word question, but if asking "Why is quantum entanglement possible?" requires deep physics understanding)

REMEMBER: Judge by "How deeply must the student understand to answer correctly?"
NOT by "How long is the answer?" or "What type of question is it?"`;

    const imagePart = {
      inlineData: {
        data: req.file.buffer.toString('base64'),
        mimeType: 'application/pdf'
      }
    };
    
    console.log('🤖 Sending PDF to Gemini Vision API...');
    const result = await model.generateContent([prompt, imagePart]);
    const response = result.response.text();

    console.log('📊 AI Response (full):', response);
    console.log('📊 AI Response length:', response.length);

    // Clean the response - remove markdown code blocks if present
    let cleanedResponse = response.trim();
    if (cleanedResponse.startsWith('```json')) {
      cleanedResponse = cleanedResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    } else if (cleanedResponse.startsWith('```')) {
      cleanedResponse = cleanedResponse.replace(/```\n?/g, '');
    }

    // Parse the JSON
    let structure;
    try {
      structure = JSON.parse(cleanedResponse);
    } catch (parseError) {
      console.error('JSON Parse Error:', parseError);
      console.error('Response was:', cleanedResponse);
      return res.status(500).json({
        success: false,
        message: 'Failed to parse AI response. Please try again or create template manually.',
        debug: cleanedResponse.substring(0, 500)
      });
    }

    // Validate structure
    if (!structure.questions || !Array.isArray(structure.questions)) {
      return res.status(500).json({
        success: false,
        message: 'Invalid structure extracted. Please try again or create template manually.'
      });
    }

    // Validate and fix difficulty weightage
    if (!structure.difficulty_weightage) {
      console.log('⚠️ No difficulty weightage provided by AI, using default');
      structure.difficulty_weightage = { easy: 30, medium: 50, hard: 20 };
    } else {
      const total = (structure.difficulty_weightage.easy || 0) + 
                    (structure.difficulty_weightage.medium || 0) + 
                    (structure.difficulty_weightage.hard || 0);
      
      if (total !== 100) {
        console.log(`⚠️ Difficulty weightage total is ${total}%, normalizing to 100%`);
        // Normalize to 100% - ensure integers only
        const factor = 100 / total;
        structure.difficulty_weightage.easy = Math.round((structure.difficulty_weightage.easy || 0) * factor);
        structure.difficulty_weightage.medium = Math.round((structure.difficulty_weightage.medium || 0) * factor);
        structure.difficulty_weightage.hard = 100 - structure.difficulty_weightage.easy - structure.difficulty_weightage.medium;
      }
      
      // Ensure all values are integers (no decimals)
      structure.difficulty_weightage.easy = Math.round(structure.difficulty_weightage.easy || 0);
      structure.difficulty_weightage.medium = Math.round(structure.difficulty_weightage.medium || 0);
      structure.difficulty_weightage.hard = Math.round(structure.difficulty_weightage.hard || 0);
    }

    // Ensure all questions have difficulty assigned
    structure.questions = structure.questions.map(q => {
      if (!q.difficulty) {
        q.difficulty = 'medium'; // Default if not assigned
      }
      
      // Ensure subquestions have difficulty
      if (q.has_subquestions && q.subquestions) {
        q.subquestions = q.subquestions.map(sq => {
          if (!sq.difficulty) {
            sq.difficulty = q.difficulty; // Inherit from parent
          }
          return sq;
        });
      }
      
      return q;
    });

    console.log(`✅ Successfully extracted ${structure.questions.length} questions`);
    console.log(`📊 Difficulty weightage: Easy ${structure.difficulty_weightage.easy}%, Medium ${structure.difficulty_weightage.medium}%, Hard ${structure.difficulty_weightage.hard}%`);

    res.json({
      success: true,
      message: 'Structure extracted successfully',
      structure: structure
    });

  } catch (error) {
    console.error('Structure extraction error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to extract structure from PDF'
    });
  }
});

// Save extracted structure as template
router.post('/save-extracted-template', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { template_name, description, questions, difficulty_weightage, class_weightage } = req.body;
    const userId = req.user.user_id;
    if (!template_name || !questions || questions.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Template name and questions are required'
      });
    }

    // Validate and normalize difficulty weightage - ensure integers only
    let finalWeightage = difficulty_weightage || { easy: 30, medium: 50, hard: 20 };
    
    const total = (finalWeightage.easy || 0) + (finalWeightage.medium || 0) + (finalWeightage.hard || 0);
    if (total !== 100) {
      console.log(`⚠️ Difficulty weightage total is ${total}%, normalizing to 100%`);
      
      if (total === 0) {
        // No weightage provided, use default
        finalWeightage = { easy: 30, medium: 50, hard: 20 };
      } else {
        // Normalize to 100% - ensure integers
        const factor = 100 / total;
        finalWeightage = {
          easy: Math.round((finalWeightage.easy || 0) * factor),
          medium: Math.round((finalWeightage.medium || 0) * factor),
          hard: 0
        };
        finalWeightage.hard = 100 - finalWeightage.easy - finalWeightage.medium;
      }
    }
    
    // Final check: ensure all values are integers (no decimals)
    finalWeightage.easy = Math.round(finalWeightage.easy || 0);
    finalWeightage.medium = Math.round(finalWeightage.medium || 0);
    finalWeightage.hard = Math.round(finalWeightage.hard || 0);

    // Ensure all questions have difficulty assigned
    const questionsWithDifficulty = questions.map(q => {
      const question = { ...q };
      
      // Assign difficulty if missing
      if (!question.difficulty) {
        question.difficulty = 'medium';
      }
      
      // Handle subquestions
      if (question.has_subquestions && question.subquestions) {
        question.subquestions = question.subquestions.map(sq => ({
          ...sq,
          difficulty: sq.difficulty || question.difficulty
        }));
      }
      
      return question;
    });

    // Calculate total marks
    const totalMarks = questionsWithDifficulty.reduce((sum, q) => {
      if (q.has_subquestions && q.subquestions) {
        return sum + q.subquestions.reduce((subSum, sq) => subSum + (parseInt(sq.marks) || 0), 0);
      }
      return sum + (parseInt(q.marks) || 0);
    }, 0);

    // Calculate actual difficulty distribution from questions
    let easyMarks = 0, mediumMarks = 0, hardMarks = 0;
    questionsWithDifficulty.forEach(q => {
      if (q.has_subquestions && q.subquestions) {
        q.subquestions.forEach(sq => {
          const marks = parseInt(sq.marks) || 0;
          if (sq.difficulty === 'easy') easyMarks += marks;
          else if (sq.difficulty === 'hard') hardMarks += marks;
          else mediumMarks += marks;
        });
      } else {
        const marks = parseInt(q.marks) || 0;
        if (q.difficulty === 'easy') easyMarks += marks;
        else if (q.difficulty === 'hard') hardMarks += marks;
        else mediumMarks += marks;
      }
    });

    // Calculate actual percentages - ensure integers only
    if (totalMarks > 0) {
      const actualWeightage = {
        easy: Math.round((easyMarks / totalMarks) * 100),
        medium: Math.round((mediumMarks / totalMarks) * 100),
        hard: Math.round((hardMarks / totalMarks) * 100)
      };
      
      // Adjust to ensure total is 100% and all values are integers
      const actualTotal = actualWeightage.easy + actualWeightage.medium + actualWeightage.hard;
      if (actualTotal !== 100) {
        actualWeightage.medium += (100 - actualTotal);
      }
      
      // Final check: ensure all are integers
      actualWeightage.easy = Math.round(actualWeightage.easy);
      actualWeightage.medium = Math.round(actualWeightage.medium);
      actualWeightage.hard = Math.round(actualWeightage.hard);
      
      finalWeightage = actualWeightage;
      console.log(`📊 Calculated difficulty distribution: Easy ${easyMarks}m (${finalWeightage.easy}%), Medium ${mediumMarks}m (${finalWeightage.medium}%), Hard ${hardMarks}m (${finalWeightage.hard}%)`);
    }

    // Store difficulty and class weightage with questions
    const questionsWithWeightage = questionsWithDifficulty.map(q => ({
      ...q,
      difficulty_weightage: finalWeightage,
      class_weightage: class_weightage || { class_11: 50, class_12: 50 }
    }));

    // Insert template - save questions directly like manual templates
    const [result] = await db.query(
      `INSERT INTO paper_templates (created_by, template_name, description, total_marks, questions, question_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, template_name, description || '', totalMarks, JSON.stringify(questionsWithWeightage), questions.length]
    );

    const templateId = result.insertId;

    console.log(`✅ Template created from extraction (ID: ${templateId}) with difficulty weightage: Easy ${finalWeightage.easy}%, Medium ${finalWeightage.medium}%, Hard ${finalWeightage.hard}%`);

    res.status(201).json({
      success: true,
      message: 'Template created successfully from extracted structure',
      template_id: templateId,
      difficulty_weightage: finalWeightage
    });
  } catch (err) {
    console.error('Save extracted template error:', err);
    res.status(500).json({ success: false, message: 'Failed to save template' });
  }
});

module.exports = router;