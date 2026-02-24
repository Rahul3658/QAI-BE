const express = require('express');
const db = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const axios = require('axios');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const router = express.Router();

// Helper function to call Gemini API using REST
async function callGeminiAPI(prompt) {
  try {
    const systemInstruction = 'You are an expert educational question paper generator. Generate high-quality, well-structured questions in valid JSON format only. Do not include any markdown formatting or extra text.';
    const fullPrompt = `${systemInstruction}\n\n${prompt}`;

    // Use model selector to get best available model
    const { getModelSelector } = require('../utils/modelSelector');
    const modelSelector = getModelSelector();
    const selectedModel = await modelSelector.selectBestModel();
    
    // Use v1beta API with selected model (v1 doesn't support all models)
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [{
            text: fullPrompt
          }]
        }],
        generationConfig: {
          temperature: 0.7,
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

// Helper function to analyze PDF structure and extract question pattern
async function analyzePDFStructure(pdfText) {
  // Use more text for better analysis (up to 25000 chars)
  const textToAnalyze = pdfText.substring(0, 25000);

  const prompt = `Analyze this COMPLETE question paper and extract its EXACT structure including ALL sections and sub-questions. Return ONLY valid JSON.

IMPORTANT: This is a COMPLETE question paper. Extract ALL sections from Q.1 to the last question.

QUESTION PAPER TEXT:
${textToAnalyze}

Extract and return in this JSON format:
{
  "structure": {
    "sections": [
      {
        "section_name": "Q.1 / Section A / Part 1",
        "question_type": "mcq / short_answer / long_answer / true_false / fill_blank",
        "has_subquestions": false,
        "subquestions": [],
        "num_questions_total": 15,
        "num_questions_to_answer": 15,
        "marks_per_question": 1,
        "total_marks": 15,
        "instructions": "Instructions like 'Answer any 5 out of 7'"
      },
      {
        "section_name": "Q.2",
        "question_type": "short_answer",
        "has_subquestions": true,
        "subquestions": [
          {"sub_number": "a", "marks": 2},
          {"sub_number": "b", "marks": 2}
        ],
        "num_questions_total": 7,
        "num_questions_to_answer": 5,
        "marks_per_question": 4,
        "total_marks": 20,
        "instructions": "Answer any 5 questions"
      }
    ],
    "total_questions": 50,
    "total_marks": 100,
    "time_duration": "3 hours",
    "general_instructions": "General instructions if any"
  }
}

CRITICAL INSTRUCTIONS:
1. Scan the ENTIRE document and identify ALL sections/parts (Q.1, Q.2, Q.3, Q.4, Q.5, etc.)
2. Do NOT stop at partial sections - extract the complete paper structure
3. For each section, detect if it has sub-questions (like Q.1(a), Q.1(b), Q.2(i), Q.2(ii))
4. If "Answer any X" is mentioned, set num_questions_total to the total available and num_questions_to_answer to X
5. For sub-questions, list each sub-question with its marks
6. Calculate marks_per_question as the sum of all sub-question marks
7. Set total_questions to the sum of all questions across all sections
8. Set total_marks to the sum of all section marks
9. Preserve the original structure exactly

VALIDATION:
- If you only see partial sections (like "Questions 12-15"), look for Q.1, Q.2, etc. in the text
- A typical exam paper has 4-6 sections with 50-100 total marks
- Make sure you've captured the COMPLETE paper, not just a fragment`;

  const structureText = await callGeminiAPI(prompt);
  const cleanText = structureText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleanText);
}

// Helper function to generate paper matching PDF structure exactly
async function generateFromPDFStructure(req, res, params) {
  const { reference_pdf_id, subject, userId, subjectId } = params;

  try {
    console.log('📋 Generating paper from PDF structure...');

    // Get reference PDF with extracted text
    const [pdfs] = await db.query(
      'SELECT * FROM uploaded_pdfs WHERE pdf_id = ?',
      [reference_pdf_id]
    );

    if (pdfs.length === 0) {
      return res.status(404).json({ success: false, message: 'Reference PDF not found' });
    }

    const referencePdf = pdfs[0];

    if (!referencePdf.extracted_text || referencePdf.extracted_text.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No text content found in reference PDF.'
      });
    }

    console.log('🔍 Analyzing PDF structure...');
    console.log(`📄 PDF text length: ${referencePdf.extracted_text.length} characters`);

    // Step 1: Analyze the PDF structure
    let structureAnalysis = await analyzePDFStructure(referencePdf.extracted_text);
    let structure = structureAnalysis.structure;

    console.log('📊 Structure extracted:', JSON.stringify(structure, null, 2));

    // Validate structure
    if (!structure.sections || structure.sections.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Could not extract question structure from PDF. The PDF might be scanned or have poor text quality.'
      });
    }

    // If structure seems incomplete, try with more context
    if (structure.sections.length < 3 || !structure.total_marks || structure.total_marks < 20) {
      console.log('⚠️ Structure seems incomplete. Retrying with full document...');

      // Try again with even more text
      const retryPrompt = `This is a COMPLETE exam question paper. Previous analysis was incomplete. 
      
Re-analyze and find ALL questions from Q.1 to the last question. Return ONLY valid JSON.

FULL DOCUMENT TEXT:
${referencePdf.extracted_text.substring(0, 40000)}

Extract ALL sections in the same JSON format as before. Do not miss any sections.`;

      try {
        const retryText = await callGeminiAPI(retryPrompt);
        const cleanRetryText = retryText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const retryAnalysis = JSON.parse(cleanRetryText);

        if (retryAnalysis.structure && retryAnalysis.structure.sections &&
          retryAnalysis.structure.sections.length > structure.sections.length) {
          console.log('✅ Retry successful! Found', retryAnalysis.structure.sections.length, 'sections');
          structure = retryAnalysis.structure;
        }
      } catch (retryErr) {
        console.log('⚠️ Retry failed, using original structure');
      }
    }

    // Step 2: Generate questions for each section matching the structure
    const allQuestions = [];
    let totalMarks = 0;

    for (const section of structure.sections) {
      const numToGenerate = section.num_questions_total || section.num_questions;
      console.log(`📝 Generating ${numToGenerate} questions for ${section.section_name}...`);

      // For sections with sub-questions, each letter (a, b, c) is a separate question
      const sectionPrompt = `Generate ${numToGenerate} NEW ${section.question_type} questions for ${subject}.

SECTION: ${section.section_name}
Question Type: ${section.question_type}
Marks per Question: ${section.marks_per_question}
${section.num_questions_to_answer !== numToGenerate ? `Students Answer: ${section.num_questions_to_answer} out of ${numToGenerate}` : ''}
Instructions: ${section.instructions || 'None'}

${section.has_subquestions && section.subquestions && section.subquestions.length > 0 ?
          `IMPORTANT: This section has ${section.subquestions.length} separate questions labeled ${section.subquestions.map(sq => sq.sub_number).join(', ')}.
Generate ${numToGenerate} SEPARATE questions, each labeled with its letter (a, b, c, etc.).
Each question is worth ${section.marks_per_question} marks.` : ''}

Generate COMPLETELY NEW questions (not from reference). Return ONLY valid JSON:

{
  "questions": [
    ${section.has_subquestions && section.subquestions && section.subquestions.length > 0 ?
          section.subquestions.map(sq => `{
      "type": "${section.question_type}",
      "question_text": "${section.section_name}(${sq.sub_number}) Question text here",
      "correct_answer": "Answer here",
      "marks": ${sq.marks},
      "sub_number": "${sq.sub_number}",
      "section": "${section.section_name}"
    }`).join(',\n    ')
          : section.question_type === 'mcq' ? `{
      "type": "mcq",
      "question_text": "Question here?",
      "options": ["A) Option 1", "B) Option 2", "C) Option 3", "D) Option 4"],
      "correct_answer": "A) Option 1",
      "marks": ${section.marks_per_question},
      "section": "${section.section_name}"
    }` : section.question_type === 'true_false' ? `{
      "type": "true_false",
      "question_text": "Statement here",
      "correct_answer": "True / False",
      "marks": ${section.marks_per_question},
      "section": "${section.section_name}"
    }` : section.question_type === 'fill_blank' ? `{
      "type": "fill_blank",
      "question_text": "Question with _____ blank",
      "correct_answer": "Answer for blank",
      "marks": ${section.marks_per_question},
      "section": "${section.section_name}"
    }` : section.question_type === 'short_answer' ? `{
      "type": "short_answer",
      "question_text": "Question here?",
      "correct_answer": "2-3 sentence answer",
      "marks": ${section.marks_per_question},
      "section": "${section.section_name}"
    }` : `{
      "type": "long_answer",
      "question_text": "Question here?",
      "correct_answer": "Detailed paragraph answer",
      "marks": ${section.marks_per_question},
      "section": "${section.section_name}"
    }`}
  ]
}

Generate exactly ${numToGenerate} questions.`;

      const sectionText = await callGeminiAPI(sectionPrompt);
      const cleanSectionText = sectionText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

      let sectionData;
      try {
        sectionData = JSON.parse(cleanSectionText);
      } catch (parseErr) {
        console.error(`❌ Failed to parse JSON for ${section.section_name}:`, cleanSectionText.substring(0, 200));
        throw new Error(`Failed to parse questions for ${section.section_name}`);
      }

      // Validate response structure
      if (!sectionData.questions || !Array.isArray(sectionData.questions)) {
        console.error(`❌ Invalid response structure for ${section.section_name}:`, sectionData);
        throw new Error(`Invalid response structure for ${section.section_name} - no questions array found`);
      }

      if (sectionData.questions.length === 0) {
        console.error(`❌ No questions generated for ${section.section_name}`);
        throw new Error(`No questions generated for ${section.section_name}`);
      }

      // Add section info to each question
      sectionData.questions.forEach(q => {
        q.section_name = section.section_name;
        q.has_subquestions = section.has_subquestions || false;
      });

      console.log(`✅ Generated ${sectionData.questions.length} questions for ${section.section_name}`);

      allQuestions.push(...sectionData.questions);
      totalMarks += section.total_marks;
    }

    console.log(`✅ Generated ${allQuestions.length} questions, Total marks: ${totalMarks}`);

    // Step 3: Save to database
    const paperTitle = `${subject} - ${referencePdf.file_name.replace('.pdf', '')} (Structure Match)`;
    const [paperResult] = await db.query(
      `INSERT INTO question_papers (generated_by, paper_title, total_marks, status, reference_pdf_id, reference_pdf_name) 
       VALUES (?, ?, ?, 'draft', ?, ?)`,
      [userId, paperTitle, totalMarks, reference_pdf_id, referencePdf.file_name]
    );

    const paperId = paperResult.insertId;

    // Insert questions
    let questionOrder = 1;
    for (const question of allQuestions) {
      const options = question.options ? JSON.stringify(question.options) : null;

      // Use question text as-is (already formatted with sub-question label if needed)
      const fullQuestionText = question.question_text;
      const fullCorrectAnswer = question.correct_answer || '';

      // Insert question (subject-based system)
      const [questionResult] = await db.query(
        `INSERT INTO questions (question_text, question_type, options, correct_answer, marks, difficulty, created_by, subject_id, status) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [
          fullQuestionText.trim(),
          question.type,
          options,
          fullCorrectAnswer,
          question.marks,
          'medium',
          userId,
          subjectId
        ]
      );

      // Link question to paper with section info
      await db.query(
        'INSERT INTO paper_questions (paper_id, question_id, question_order) VALUES (?, ?, ?)',
        [paperId, questionResult.insertId, questionOrder++]
      );
    }

    // Log audit
    await db.query(
      'INSERT INTO audit_logs (user_id, college_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, null, 'PAPER_GENERATED_FROM_PDF_STRUCTURE', 'question_paper', paperId, `Subject: ${subject}, Reference: ${referencePdf.file_name}`, req.ip]
    );

    // Check if structure might be incomplete
    const isIncomplete = structure.sections.length < 3 || totalMarks < 30;
    const warningMessage = isIncomplete
      ? ' Note: The extracted structure seems incomplete. Please verify the generated paper matches your original PDF.'
      : '';

    return res.status(201).json({
      success: true,
      message: 'Question paper generated successfully matching PDF structure' + warningMessage,
      warning: isIncomplete ? 'Structure may be incomplete - please review' : null,
      paper: {
        paper_id: paperId,
        title: paperTitle,
        total_questions: allQuestions.length,
        total_marks: totalMarks,
        status: 'draft',
        reference_pdf: referencePdf.file_name,
        structure: structure,
        sections_found: structure.sections.length
      },
      questions: allQuestions
    });

  } catch (err) {
    console.error('Generate from PDF structure error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to generate paper from PDF structure',
      error: err.message
    });
  }
}

// Helper function to generate questions incrementally matching PDF structure
async function generateFromPDFStructureIncremental(req, res, params) {
  const { reference_pdf_id, subject, topic, paper_id, num_questions_to_generate, userId, subjectId } = params;

  try {
    console.log('📋 Generating questions incrementally from PDF structure...');

    // Get reference PDF
    const [pdfs] = await db.query(
      'SELECT * FROM uploaded_pdfs WHERE pdf_id = ?',
      [reference_pdf_id]
    );

    if (pdfs.length === 0) {
      return res.status(404).json({ success: false, message: 'Reference PDF not found' });
    }

    const referencePdf = pdfs[0];

    if (!referencePdf.extracted_text || referencePdf.extracted_text.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No text content found in reference PDF.'
      });
    }

    // Analyze PDF structure (cache this if possible)
    console.log('🔍 Analyzing PDF structure...');
    const structureAnalysis = await analyzePDFStructure(referencePdf.extracted_text);
    const structure = structureAnalysis.structure;

    console.log('📊 Structure:', structure.sections.length, 'sections found');

    // Get or create paper
    let currentPaperId = paper_id;
    let existingQuestionCount = 0;

    if (!currentPaperId) {
      // Create new paper
      const paperTitle = `${subject} - ${topic} (PDF Structure Match)`;
      const [paperResult] = await db.query(
        `INSERT INTO question_papers (generated_by, paper_title, total_marks, status, reference_pdf_id, reference_pdf_name) 
         VALUES (?, ?, ?, 'draft', ?, ?)`,
        [userId, paperTitle, structure.total_marks || 0, reference_pdf_id, referencePdf.file_name]
      );
      currentPaperId = paperResult.insertId;
      console.log('✅ Created new paper:', currentPaperId);
    } else {
      // Get existing question count
      const [countResult] = await db.query(
        'SELECT COUNT(*) as count FROM paper_questions WHERE paper_id = ?',
        [currentPaperId]
      );
      existingQuestionCount = countResult[0].count;
      console.log('📝 Adding to existing paper with', existingQuestionCount, 'questions');
    }

    // Generate questions from random sections
    const generatedQuestions = [];
    let questionsGenerated = 0;

    while (questionsGenerated < num_questions_to_generate && structure.sections.length > 0) {
      // Pick a random section
      const randomSection = structure.sections[Math.floor(Math.random() * structure.sections.length)];

      console.log(`📝 Generating 1 question from ${randomSection.section_name}...`);

      // Generate 1 question from this section
      const questionPrompt = `Generate 1 NEW ${randomSection.question_type} question for ${subject} - ${topic}.

SECTION: ${randomSection.section_name}
Question Type: ${randomSection.question_type}
Marks: ${randomSection.marks_per_question}

Generate a COMPLETELY NEW question. Return ONLY valid JSON:

{
  "questions": [
    {
      "type": "${randomSection.question_type}",
      "question_text": "${randomSection.section_name} Question text here",
      "correct_answer": "Answer here",
      ${randomSection.question_type === 'mcq' ? '"options": ["A) Option 1", "B) Option 2", "C) Option 3", "D) Option 4"],' : ''}
      "marks": ${randomSection.marks_per_question},
      "section": "${randomSection.section_name}"
    }
  ]
}`;

      try {
        const questionText = await callGeminiAPI(questionPrompt);
        const cleanQuestionText = questionText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const questionData = JSON.parse(cleanQuestionText);

        if (questionData.questions && questionData.questions.length > 0) {
          generatedQuestions.push(questionData.questions[0]);
          questionsGenerated++;
        }
      } catch (err) {
        console.error('Error generating question:', err.message);
      }
    }

    // Insert generated questions
    let questionOrder = existingQuestionCount + 1;
    for (const question of generatedQuestions) {
      const options = question.options ? JSON.stringify(question.options) : null;

      const [questionResult] = await db.query(
        `INSERT INTO questions (question_text, question_type, options, correct_answer, marks, difficulty, created_by, subject_id, status) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [
          question.question_text.trim(),
          question.type,
          options,
          question.correct_answer,
          question.marks,
          'medium',
          userId,
          subjectId
        ]
      );

      await db.query(
        'INSERT INTO paper_questions (paper_id, question_id, question_order) VALUES (?, ?, ?)',
        [currentPaperId, questionResult.insertId, questionOrder++]
      );
    }

    // Get updated question count and total marks
    const [paperQuestions] = await db.query(
      `SELECT q.marks FROM questions q
       JOIN paper_questions pq ON q.question_id = pq.question_id
       WHERE pq.paper_id = ?`,
      [currentPaperId]
    );

    const totalMarks = paperQuestions.reduce((sum, q) => sum + q.marks, 0);
    const totalQuestions = paperQuestions.length;

    // Update paper total marks
    await db.query(
      'UPDATE question_papers SET total_marks = ? WHERE paper_id = ?',
      [totalMarks, currentPaperId]
    );

    console.log(`✅ Generated ${generatedQuestions.length} questions. Total: ${totalQuestions} questions, ${totalMarks} marks`);

    return res.status(201).json({
      success: true,
      message: `Generated ${generatedQuestions.length} new questions`,
      paper: {
        paper_id: currentPaperId,
        total_questions: totalQuestions,
        total_marks: totalMarks,
        questions_added: generatedQuestions.length,
        status: 'draft'
      },
      questions: generatedQuestions,
      structure: structure
    });

  } catch (err) {
    console.error('Generate incremental error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to generate questions',
      error: err.message
    });
  }
}

// Helper function to generate paper from reference PDF (using extracted text)
async function generateFromReferencePDF(req, res, params) {
  const { reference_pdf_id, subject, topic, difficulty, num_questions, total_marks, question_types, marks_distribution, userId, subjectId } = params;

  try {
    // Get reference PDF with extracted text
    const [pdfs] = await db.query(
      'SELECT * FROM uploaded_pdfs WHERE pdf_id = ?',
      [reference_pdf_id]
    );

    if (pdfs.length === 0) {
      return res.status(404).json({ success: false, message: 'Reference PDF not found' });
    }

    const referencePdf = pdfs[0];

    // Check if extracted text exists
    if (!referencePdf.extracted_text || referencePdf.extracted_text.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No text content found in reference PDF. Please upload a different PDF.'
      });
    }

    // Use the extracted text directly as context
    const context = referencePdf.extracted_text;

    // Limit context length if too long (Gemini has token limits)
    const maxContextLength = 15000; // ~3000-4000 tokens
    const truncatedContext = context.length > maxContextLength
      ? context.substring(0, maxContextLength) + '...[truncated]'
      : context;

    console.log(`📚 Using extracted text from reference PDF (${truncatedContext.length} characters)`);

    // Build prompt with reference context
    const selectedTypes = Object.keys(question_types).filter(type => question_types[type]);

    const prompt = `You are an expert question paper generator. Generate a NEW question paper SIMILAR to the reference paper provided below, but with DIFFERENT questions on the same topics.

REFERENCE PAPER CONTEXT (for pattern and structure reference only):
${truncatedContext}

NEW PAPER SPECIFICATIONS:
Subject: ${subject}
Topic: ${topic}
Difficulty Level: ${difficulty}
Total Questions: ${num_questions}
Total Marks: ${total_marks || 50}
Question Types: ${selectedTypes.join(', ')}

CRITICAL INSTRUCTIONS:
1. Study the PATTERN, STRUCTURE, and STYLE of the reference paper
2. Generate COMPLETELY NEW questions on similar topics/concepts
3. DO NOT copy questions from the reference - create original questions
4. Match the difficulty level and question style of the reference
5. Ensure questions test similar concepts but with different scenarios/examples
6. Distribute ${total_marks || 50} marks across all ${num_questions} questions

MARKS DISTRIBUTION:
- MCQ: ${marks_distribution.mcq || 1} marks each
- Short Answer: ${marks_distribution.short_answer || 2} marks each (2-3 sentence answers)
- Long Answer: ${marks_distribution.long_answer || 5} marks each (1-2 paragraph answers)

Return ONLY valid JSON in this exact structure (no markdown, no comments):
{
  "questions": [
    {
      "type": "mcq",
      "question_text": "NEW question inspired by reference pattern...",
      "options": ["Option 1", "Option 2", "Option 3", "Option 4"],
      "correct_answer": "Option 1",
      "marks": ${marks_distribution.mcq || 1},
      "difficulty": "${difficulty}"
    },
    {
      "type": "short_answer",
      "question_text": "NEW question on similar concept...",
      "correct_answer": "Complete 2-3 sentence answer...",
      "marks": ${marks_distribution.short_answer || 2},
      "difficulty": "${difficulty}"
    },
    {
      "type": "long_answer",
      "question_text": "NEW detailed question on similar topic...",
      "correct_answer": "Comprehensive 1-2 paragraph answer...",
      "marks": ${marks_distribution.long_answer || 5},
      "difficulty": "${difficulty}"
    }
  ],
  "total_marks": ${total_marks || 50}
}

REMEMBER: Create NEW questions inspired by the reference pattern, NOT copies!`;

    // Call Gemini API
    let generatedText = await callGeminiAPI(prompt);

    // Extract JSON from response
    generatedText = generatedText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    console.log('Generated questions from reference PDF pattern');

    const generatedData = JSON.parse(generatedText);

    // Ensure MCQ questions have proper options array
    generatedData.questions = generatedData.questions.map(q => {
      if (q.type === 'mcq') {
        if (!q.options || !Array.isArray(q.options) || q.options.length === 0) {
          console.warn('MCQ question missing options, generating defaults:', q.question_text);
          const correctAns = q.correct_answer || 'Correct Answer';
          q.options = [correctAns, 'Option B', 'Option C', 'Option D'];
          q.options.sort(() => Math.random() - 0.5);
        }
        while (q.options.length < 4) {
          q.options.push(`Option ${String.fromCharCode(65 + q.options.length)}`);
        }
        if (q.options.length > 4) {
          q.options = q.options.slice(0, 4);
        }
      }
      return q;
    });

    // Insert question paper with reference PDF info
    const paperTitle = `${subject} - ${topic} (${difficulty})`;
    const [paperResult] = await db.query(
      `INSERT INTO question_papers (generated_by, paper_title, total_marks, status, reference_pdf_id, reference_pdf_name) 
       VALUES (?, ?, ?, 'draft', ?, ?)`,
      [userId, paperTitle, generatedData.total_marks, reference_pdf_id, referencePdf.file_name]
    );

    const paperId = paperResult.insertId;

    // Insert questions and link to paper (subject-based system)
    let questionOrder = 0;
    for (const q of generatedData.questions) {
      const [questionResult] = await db.query(
        `INSERT INTO questions (subject_id, created_by, question_text, question_type, difficulty, marks, options, correct_answer, status) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [
          subjectId,
          userId,
          q.question_text,
          q.type,
          q.difficulty,
          q.marks,
          q.options ? JSON.stringify(q.options) : null,
          q.correct_answer || null
        ]
      );

      // Link question to paper
      await db.query(
        'INSERT INTO paper_questions (paper_id, question_id, question_order) VALUES (?, ?, ?)',
        [paperId, questionResult.insertId, questionOrder++]
      );
    }

    // Log audit
    await db.query(
      'INSERT INTO audit_logs (user_id, college_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, null, 'PAPER_GENERATED_FROM_REFERENCE', 'question_paper', paperId, `Subject: ${subject}, Topic: ${topic}, Reference: ${referencePdf.file_name}`, req.ip]
    );

    return res.status(201).json({
      success: true,
      message: 'Question paper generated successfully using reference pattern',
      paper: {
        paper_id: paperId,
        paper_title: paperTitle,
        total_questions: generatedData.questions.length,
        total_marks: generatedData.total_marks,
        status: 'draft',
        reference_pdf: referencePdf.file_name
      },
      questions: generatedData.questions
    });
  } catch (err) {
    console.error('Generate from reference PDF error:', err);

    if (err.status === 429) {
      return res.status(429).json({
        success: false,
        message: 'AI service rate limit reached. Please wait a few minutes and try again.',
        error: 'Rate limit exceeded'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to generate question paper from reference',
      error: err.message
    });
  }
}

// Get available PDFs for reference (for examiner)
router.get('/reference-pdfs', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    // Get all PDFs from the college that can be used as reference
    const [pdfs] = await db.query(
      `SELECT pdf_id, file_name, subject, topic, description, uploaded_at as upload_date 
       FROM uploaded_pdfs 
       WHERE status IN ('ready', 'processed')
       ORDER BY uploaded_at DESC`,
      []); // No college filter in subject-based system

    res.json({ success: true, pdfs });
  } catch (err) {
    console.error('Fetch reference PDFs error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Create a new empty paper (or return existing one with same name)
router.post('/create', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { subject, topic, language, total_marks, uses_variations, template_id, reference_pdf_id } = req.body;
    const userId = req.user.user_id;
    // Create paper title - use topic as the paper name
    const paperTitle = topic || 'Untitled Paper';

    // Check if a paper with the same title already exists for this user
    const [existingPapers] = await db.query(
      `SELECT paper_id, paper_title, total_marks, status, uses_variations 
       FROM question_papers 
       WHERE paper_title = ? AND generated_by = ? AND status = 'draft'
       ORDER BY created_at DESC
       LIMIT 1`,
      [paperTitle, userId]
    );

    // If paper exists, return it instead of creating a new one
    if (existingPapers.length > 0) {
      const existingPaper = existingPapers[0];
      return res.status(200).json({
        success: true,
        message: 'Using existing paper with the same name',
        paper: {
          paper_id: existingPaper.paper_id,
          paper_title: existingPaper.paper_title,
          total_marks: existingPaper.total_marks,
          status: existingPaper.status,
          uses_variations: existingPaper.uses_variations,
          is_existing: true
        }
      });
    }

    // If no existing paper, create a new one
    const [result] = await db.query(
      `INSERT INTO question_papers 
       (paper_title, total_marks, generated_by, subject_id, status, uses_variations, reference_pdf_id, language, template_id) 
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
      [
        paperTitle,
        total_marks || 100,
        userId,
        req.user.subject_id || null,
        uses_variations ? 1 : 0,
        reference_pdf_id || null,
        language || 'english',
        template_id || null
      ]
    );

    const paperId = result.insertId;

    res.status(201).json({
      success: true,
      message: 'Paper created successfully',
      paper: {
        paper_id: paperId,
        paper_title: paperTitle,
        total_marks: total_marks || 100,
        status: 'draft',
        uses_variations: uses_variations ? 1 : 0,
        is_existing: false
      }
    });

  } catch (err) {
    console.error('Create paper error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to create paper',
      error: err.message
    });
  }
});

// Generate question paper using Gemini AI
router.post('/generate', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { subject, topic, difficulty, num_questions, total_marks, question_types, marks_distribution, reference_pdf_id } = req.body;
    const userId = req.user.user_id;
    const subjectId = req.user.subject_id;
    
    if (!subject || !topic) {
      return res.status(400).json({ success: false, message: 'Subject and topic are required' });
    }

    // If reference PDF is provided, use it to generate similar paper
    if (reference_pdf_id) {
      return await generateFromReferencePDF(req, res, {
        reference_pdf_id,
        subject,
        topic,
        difficulty,
        num_questions,
        total_marks,
        question_types,
        marks_distribution,
        userId,
        subjectId
      });
    }

    // Build prompt for Gemini
    const selectedTypes = Object.keys(question_types).filter(type => question_types[type]);

    const prompt = `Generate a comprehensive question paper with the following specifications:

Subject: ${subject}
Topic: ${topic}
Difficulty Level: ${difficulty}
Total Questions: ${num_questions}
Total Marks for Entire Paper: ${total_marks || 50}
Question Types: ${selectedTypes.join(', ')}

IMPORTANT: Distribute the ${total_marks || 50} marks across all ${num_questions} questions appropriately based on question type.

Please generate questions in the following format for each type:

For MCQ (Multiple Choice Questions):
- Question text
- EXACTLY 4 options as an array of strings (the actual option text, NOT labels like A/B/C/D)
- Correct answer (must be one of the 4 options, exact text match)
- Marks: ${marks_distribution.mcq || 1}
- Example: "options": ["React", "Angular", "Vue", "Svelte"]

For Short Answer Questions:
- Question text
- Expected answer (2-3 sentences providing the correct answer)
- Marks: ${marks_distribution.short_answer || 2}

For Long Answer Questions:
- Question text
- Expected answer (1-2 paragraphs providing the comprehensive answer)
- Marks: ${marks_distribution.long_answer || 5}

CRITICAL REQUIREMENTS:
1. Return ONLY valid JSON (no markdown, no comments, no extra text)
2. For MCQ questions: "options" MUST be an array of EXACTLY 4 strings
3. For MCQ questions: "correct_answer" MUST be one of the 4 options (exact match)
4. For ALL question types: MUST include "correct_answer" field with the actual answer
5. Do NOT use option labels (A, B, C, D) - use the actual answer text

EXACT JSON STRUCTURE:
{
  "questions": [
    {
      "type": "mcq",
      "question_text": "What is 2+2?",
      "options": ["2", "3", "4", "5"],
      "correct_answer": "4",
      "marks": 1,
      "difficulty": "${difficulty}"
    },
    {
      "type": "mcq",
      "question_text": "Which is a programming language?",
      "options": ["Python", "HTML", "CSS", "JSON"],
      "correct_answer": "Python",
      "marks": 1,
      "difficulty": "${difficulty}"
    },
    {
      "type": "short_answer",
      "question_text": "Explain the concept of variables in programming.",
      "correct_answer": "Variables are named storage locations in memory that hold data values. They allow programs to store, retrieve, and manipulate data during execution. Variables have a name, data type, and value that can change during program runtime.",
      "marks": 2,
      "difficulty": "${difficulty}"
    },
    {
      "type": "long_answer",
      "question_text": "Discuss the importance of object-oriented programming.",
      "correct_answer": "Object-oriented programming (OOP) is a programming paradigm that organizes code around objects and classes. It provides several key benefits: encapsulation allows bundling data and methods together, inheritance enables code reuse through hierarchical relationships, polymorphism allows objects to take multiple forms, and abstraction helps manage complexity by hiding implementation details. These principles make code more modular, maintainable, and scalable, which is crucial for large software projects.",
      "marks": 5,
      "difficulty": "${difficulty}"
    }
  ],
  "total_marks": 25
}

Make sure questions are relevant, clear, and appropriate for ${difficulty} difficulty level.`;

    // Call Gemini API
    let generatedText = await callGeminiAPI(prompt);

    // Extract JSON from response
    generatedText = generatedText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    // Log the raw response for debugging
    console.log('Gemini Response:', generatedText.substring(0, 500));

    const generatedData = JSON.parse(generatedText);

    // Ensure MCQ questions have proper options array
    generatedData.questions = generatedData.questions.map(q => {
      if (q.type === 'mcq') {
        // Ensure options exist and are an array
        if (!q.options || !Array.isArray(q.options) || q.options.length === 0) {
          console.warn('MCQ question missing options, generating defaults:', q.question_text);
          // Generate options based on the correct answer
          const correctAns = q.correct_answer || 'Correct Answer';
          q.options = [
            correctAns,
            'Option B',
            'Option C',
            'Option D'
          ];
          // Shuffle to randomize correct answer position
          q.options.sort(() => Math.random() - 0.5);
        }
        // Ensure we have exactly 4 options
        while (q.options.length < 4) {
          q.options.push(`Option ${String.fromCharCode(65 + q.options.length)}`);
        }
        if (q.options.length > 4) {
          q.options = q.options.slice(0, 4);
        }
      }
      return q;
    });

    // Insert question paper
    const paperTitle = `${subject} - ${topic} (${difficulty})`;
    const [paperResult] = await db.query(
      `INSERT INTO question_papers (generated_by, paper_title, total_marks, status) 
       VALUES (?, ?, ?, 'draft')`,
      [userId, paperTitle, generatedData.total_marks]
    );

    const paperId = paperResult.insertId;

    // Insert questions and link to paper (subject-based system)
    let questionOrder = 0;
    for (const q of generatedData.questions) {
      const [questionResult] = await db.query(
        `INSERT INTO questions (subject_id, created_by, question_text, question_type, difficulty, marks, options, correct_answer, status) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [
          subjectId,
          userId,
          q.question_text,
          q.type,
          q.difficulty,
          q.marks,
          q.options ? JSON.stringify(q.options) : null,
          q.correct_answer || null
        ]
      );

      // Link question to paper
      await db.query(
        'INSERT INTO paper_questions (paper_id, question_id, question_order) VALUES (?, ?, ?)',
        [paperId, questionResult.insertId, questionOrder++]
      );
    }

    // Log audit
    await db.query(
      'INSERT INTO audit_logs (user_id, college_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, null, 'PAPER_GENERATED', 'question_paper', paperId, `Subject: ${subject}, Topic: ${topic}`, req.ip]
    );

    res.status(201).json({
      success: true,
      message: 'Question paper and questions generated successfully',
      paper: {
        paper_id: paperId,
        paper_title: paperTitle,
        total_questions: generatedData.questions.length,
        total_marks: generatedData.total_marks,
        status: 'draft'
      },
      questions: generatedData.questions
    });
  } catch (err) {
    console.error('Generate paper error:', err);

    // Handle rate limiting
    if (err.status === 429) {
      return res.status(429).json({
        success: false,
        message: 'AI service rate limit reached. Please wait a few minutes and try again.',
        error: 'Rate limit exceeded'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to generate question paper',
      error: err.message
    });
  }
});

// Generate question paper from template
router.post('/generate-from-template', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { subject, topic, template_id, template_questions } = req.body;
    const userId = req.user.user_id;
    if (!subject || !topic || !template_questions || template_questions.length === 0) {
      return res.status(400).json({ success: false, message: 'Subject, topic, and template questions are required' });
    }

    // Build prompt for Gemini based on template structure
    let promptQuestions = '';
    let totalMarks = 0;

    template_questions.forEach((tq, index) => {
      totalMarks += tq.marks;
      const questionNum = index + 1;
      promptQuestions += `\nQuestion ${questionNum}: ${tq.question_type} | ${tq.difficulty} difficulty | ${tq.marks} marks`;
    });

    const prompt = `Generate a comprehensive question paper with the following specifications:

Subject: ${subject}
Topic: ${topic}
Total Questions: ${template_questions.length}
Total Marks: ${totalMarks}

QUESTION STRUCTURE (MUST FOLLOW EXACTLY):
${promptQuestions}

IMPORTANT INSTRUCTIONS:
1. Generate EXACTLY ${template_questions.length} questions following the structure above
2. Each question MUST match the specified type, difficulty, and marks
3. For ALL question types: MUST include "correct_answer" field with the actual answer
4. Return ONLY valid JSON (no markdown, no comments, no extra text)

For MCQ questions:
- "options" MUST be an array of EXACTLY 4 strings (actual option text)
- "correct_answer" MUST be one of the 4 options (exact match)

For Short Answer questions:
- "correct_answer" must be 2-3 sentences providing the complete answer

For Long Answer questions:
- "correct_answer" must be 1-2 paragraphs providing the comprehensive answer

EXACT JSON STRUCTURE:
{
  "questions": [
${template_questions.map((tq, i) => {
      if (tq.question_type === 'mcq') {
        return `    {
      "type": "mcq",
      "question_text": "Question about ${topic}...",
      "options": ["Option 1", "Option 2", "Option 3", "Option 4"],
      "correct_answer": "Option 1",
      "marks": ${tq.marks},
      "difficulty": "${tq.difficulty}"
    }`;
      } else if (tq.question_type === 'short_answer') {
        return `    {
      "type": "short_answer",
      "question_text": "Explain...",
      "correct_answer": "2-3 sentence answer here...",
      "marks": ${tq.marks},
      "difficulty": "${tq.difficulty}"
    }`;
      } else {
        return `    {
      "type": "long_answer",
      "question_text": "Discuss in detail...",
      "correct_answer": "1-2 paragraph comprehensive answer here...",
      "marks": ${tq.marks},
      "difficulty": "${tq.difficulty}"
    }`;
      }
    }).join(',\n')}
  ],
  "total_marks": ${totalMarks}
}

Make sure questions are relevant, clear, and appropriate for the specified difficulty levels.`;

    // Call Gemini API
    let generatedText = await callGeminiAPI(prompt);

    // Extract JSON from response
    generatedText = generatedText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    console.log('Gemini Response (template-based):', generatedText.substring(0, 500));

    const generatedData = JSON.parse(generatedText);

    // Ensure MCQ questions have proper options array
    generatedData.questions = generatedData.questions.map(q => {
      if (q.type === 'mcq') {
        if (!q.options || !Array.isArray(q.options) || q.options.length === 0) {
          console.warn('MCQ question missing options, generating defaults:', q.question_text);
          const correctAns = q.correct_answer || 'Correct Answer';
          q.options = [correctAns, 'Option B', 'Option C', 'Option D'];
          q.options.sort(() => Math.random() - 0.5);
        }
        while (q.options.length < 4) {
          q.options.push(`Option ${String.fromCharCode(65 + q.options.length)}`);
        }
        if (q.options.length > 4) {
          q.options = q.options.slice(0, 4);
        }
      }
      return q;
    });

    // Insert question paper
    const paperTitle = `${subject} - ${topic}`;
    const [paperResult] = await db.query(
      `INSERT INTO question_papers (generated_by, paper_title, total_marks, status) 
       VALUES (?, ?, ?, 'draft')`,
      [userId, paperTitle, generatedData.total_marks]
    );

    const paperId = paperResult.insertId;

    // Subject-based system
    let questionOrder = 0;
    for (const q of generatedData.questions) {
      const [questionResult] = await db.query(
        `INSERT INTO questions (subject_id, created_by, question_text, question_type, difficulty, marks, options, correct_answer, status) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [
          subjectId,
          userId,
          q.question_text,
          q.type,
          q.difficulty,
          q.marks,
          q.options ? JSON.stringify(q.options) : null,
          q.correct_answer || null
        ]
      );

      // Link question to paper
      await db.query(
        'INSERT INTO paper_questions (paper_id, question_id, question_order) VALUES (?, ?, ?)',
        [paperId, questionResult.insertId, questionOrder++]
      );
    }

    // Log audit
    await db.query(
      'INSERT INTO audit_logs (user_id, college_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, null, 'PAPER_GENERATED_FROM_TEMPLATE', 'question_paper', paperId, `Subject: ${subject}, Topic: ${topic}, Template ID: ${template_id}`, req.ip]
    );

    res.status(201).json({
      success: true,
      message: 'Question paper generated successfully from template',
      paper: {
        paper_id: paperId,
        paper_title: paperTitle,
        total_questions: generatedData.questions.length,
        total_marks: generatedData.total_marks,
        status: 'draft'
      },
      questions: generatedData.questions
    });
  } catch (err) {
    console.error('Generate paper from template error:', err);

    if (err.status === 429) {
      return res.status(429).json({
        success: false,
        message: 'AI service rate limit reached. Please wait a few minutes and try again.',
        error: 'Rate limit exceeded'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to generate question paper',
      error: err.message
    });
  }
});

// Get papers for examiner
router.get('/', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const userId = req.user.user_id;

    const [papers] = await db.query(
      `SELECT qp.paper_id, qp.paper_title, qp.total_marks, qp.status, qp.created_at, qp.updated_at,
              (SELECT COUNT(DISTINCT svr.variation_id) 
               FROM sme_variation_reviews svr
               JOIN question_variations v ON svr.variation_id = v.variation_id
               JOIN sub_questions sq ON v.sub_question_id = sq.sub_question_id
               WHERE sq.paper_id = qp.paper_id) as variations_sent_to_sme,
              (SELECT COUNT(*) 
               FROM question_variations v
               WHERE v.paper_id = qp.paper_id 
               AND v.status = 'examiner_approved') as variations_confirmed
       FROM question_papers qp
       WHERE qp.generated_by = ? 
       AND qp.paper_title NOT LIKE '% - General Exam'
       AND qp.paper_title NOT LIKE '% - Re-Exam'
       AND qp.paper_title NOT LIKE '% - Special Case'
       ORDER BY qp.created_at DESC`,
      [userId]
    );

    // Check if each paper can be confirmed (all sub-questions have at least 40 variations sent to SME)
    for (const paper of papers) {
      const [subQuestions] = await db.query(
        `SELECT sq.sub_question_id,
                (SELECT COUNT(*) 
                 FROM question_variations v
                 LEFT JOIN sme_variation_reviews svr ON v.variation_id = svr.variation_id
                 WHERE v.sub_question_id = sq.sub_question_id
                 AND (v.status = 'sent_to_sme' OR v.status = 'selected_by_sme' OR v.status = 'approved' OR v.status = 'unselected_by_sme')
                ) as sent_to_sme_count
         FROM sub_questions sq
         WHERE sq.paper_id = ?`,
        [paper.paper_id]
      );

      // Check if all sub-questions have at least 40 variations sent to SME
      const allMeetRequirement = subQuestions.length > 0 && subQuestions.every(sq => sq.sent_to_sme_count >= 40);
      paper.can_confirm = allMeetRequirement;
    }

    res.json({ success: true, papers });
  } catch (err) {
    console.error('Fetch papers error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// SME: Get pending papers for review in their department (MUST be before /:paperId route)
router.get('/pending-review', authMiddleware, requireRole('subject_matter_expert'), async (req, res) => {
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

    // Get pending papers from examiners in the same subject
    const [papers] = await db.query(
      `SELECT qp.paper_id, qp.paper_title, qp.total_marks, qp.status, qp.created_at, qp.updated_at,
              u.name as examiner_name, u.email as examiner_email, s.subject_name
       FROM question_papers qp
       JOIN users u ON qp.generated_by = u.user_id
       LEFT JOIN subjects s ON u.subject_id = s.subject_id
       WHERE u.subject_id = ? 
         AND qp.status = 'pending'
       ORDER BY qp.created_at ASC`,
      [subjectId]
    );

    res.json({ success: true, papers });
  } catch (err) {
    console.error('Get pending papers error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// SME: Approve or reject paper (MUST be before /:paperId route)
router.put('/:paperId/sme-review', authMiddleware, requireRole('subject_matter_expert'), async (req, res) => {
  try {
    const { paperId } = req.params;
    const { action, feedback } = req.body;
    const userId = req.user.user_id;

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Invalid action. Use approve or reject' });
    }

    // Get SME's subject
    const [smeData] = await db.query(
      'SELECT subject_id FROM users WHERE user_id = ?',
      [userId]
    );

    if (smeData.length === 0 || !smeData[0].subject_id) {
      return res.status(400).json({ success: false, message: 'Subject not found for SME' });
    }

    const subjectId = smeData[0].subject_id;

    // Verify paper exists, is pending, and belongs to an examiner in SME's subject
    const [papers] = await db.query(
      `SELECT qp.paper_id, qp.paper_title, qp.status, u.subject_id
       FROM question_papers qp
       JOIN users u ON qp.generated_by = u.user_id
       LEFT JOIN subjects s ON u.subject_id = s.subject_id
       WHERE qp.paper_id = ? 
         AND u.subject_id = ?
         AND qp.status = 'pending'`,
      [paperId, subjectId]
    );

    if (papers.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Paper not found or not available for review'
      });
    }

    const paper = papers[0];
    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    // Update paper status
    await db.query(
      'UPDATE question_papers SET status = ?, updated_at = NOW() WHERE paper_id = ?',
      [newStatus, paperId]
    );

    // Log audit (collegeId can be null in subject-based system)
    await db.query(
      'INSERT INTO audit_logs (user_id, college_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        userId,
        null,
        action === 'approve' ? 'PAPER_APPROVED_BY_SME' : 'PAPER_REJECTED_BY_SME',
        'question_paper',
        paperId,
        `${action === 'approve' ? 'Approved' : 'Rejected'} paper: ${paper.paper_title}${feedback ? '. Feedback: ' + feedback : ''}`,
        req.ip
      ]
    );

    res.json({
      success: true,
      message: `Paper ${action === 'approve' ? 'approved' : 'rejected'} successfully`
    });
  } catch (err) {
    console.error('SME review error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get paper with all questions, sub-questions, and variations
router.get('/:paperId/details', authMiddleware, async (req, res) => {
  try {
    const { paperId } = req.params;
    const subjectId = req.user.subject_id;

    // Get paper (subject-based system)
    const [papers] = await db.query(
      `SELECT qp.*, u.name as generated_by_name, s.subject_name
       FROM question_papers qp
       JOIN users u ON qp.generated_by = u.user_id
       LEFT JOIN subjects s ON u.subject_id = s.subject_id
       WHERE qp.paper_id = ? AND u.subject_id = ?`,
      [paperId, subjectId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found' });
    }

    const paper = papers[0];

    // Get all main questions for this paper
    const [questions] = await db.query(
      `SELECT q.* 
       FROM questions q
       JOIN paper_questions pq ON q.question_id = pq.question_id
       WHERE pq.paper_id = ?
       ORDER BY pq.question_order`,
      [paperId]
    );

    console.log(`📄 Paper ${paperId}: Found ${questions.length} main questions`);

    // If no questions found via paper_questions, try to find questions directly linked to paper via sub_questions
    if (questions.length === 0) {
      console.log(`⚠️ No questions in paper_questions table. Checking sub_questions table...`);

      // Get questions that have sub-questions linked to this paper
      const [directQuestions] = await db.query(
        `SELECT DISTINCT q.* 
         FROM questions q
         JOIN sub_questions sq ON q.question_id = sq.parent_question_id
         WHERE sq.paper_id = ?
         ORDER BY q.question_id`,
        [paperId]
      );

      console.log(`📋 Found ${directQuestions.length} questions via sub_questions table`);
      questions.push(...directQuestions);
    }

    // For each question, get its sub-questions and variations
    for (let question of questions) {
      // Get sub-questions
      const [subQuestions] = await db.query(
        `SELECT * FROM sub_questions 
         WHERE parent_question_id = ?
         ORDER BY sub_question_number`,
        [question.question_id]
      );

      // For each sub-question, get its variations
      for (let subQuestion of subQuestions) {
        const [variations] = await db.query(
          `SELECT * FROM question_variations 
           WHERE sub_question_id = ?
           ORDER BY variation_number`,
          [subQuestion.sub_question_id]
        );

        // Parse options if they're strings
        variations.forEach(v => {
          if (v.options && typeof v.options === 'string') {
            try {
              v.options = JSON.parse(v.options);
            } catch (e) {
              v.options = null;
            }
          }
        });

        subQuestion.variations = variations;
        subQuestion.variation_count = variations.length;
      }

      question.sub_questions = subQuestions;
      question.sub_question_count = subQuestions.length;
    }

    res.json({
      success: true,
      paper: {
        ...paper,
        questions
      }
    });
  } catch (err) {
    console.error('Get paper details error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get questions for a paper (used for checking existing questions)
router.get('/:paperId/questions', authMiddleware, async (req, res) => {
  try {
    const { paperId } = req.params;
    const userId = req.user.user_id;
    const subjectId = req.user.subject_id;

    // Verify paper belongs to user's subject (subject-based system)
    const [papers] = await db.query(
      'SELECT paper_id FROM question_papers WHERE paper_id = ? AND subject_id = ?',
      [paperId, subjectId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found' });
    }

    // Get questions linked to this paper
    const [questions] = await db.query(
      `SELECT q.question_id, q.question_text, q.question_type, q.difficulty, q.marks, q.options, q.correct_answer, pq.question_order
       FROM questions q
       JOIN paper_questions pq ON q.question_id = pq.question_id
       WHERE pq.paper_id = ?
       ORDER BY pq.question_order`,
      [paperId]
    );

    // Parse options JSON (if it's a string)
    questions.forEach(q => {
      if (q.options && typeof q.options === 'string') {
        try {
          q.options = JSON.parse(q.options);
        } catch (e) {
          console.error('Failed to parse options:', e);
          q.options = null;
        }
      }
    });

    res.json({
      success: true,
      questions
    });
  } catch (err) {
    console.error('Get paper questions error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get paper info with questions, sub-questions, and variation counts (for info modal)
router.get('/:paperId/info', authMiddleware, async (req, res) => {
  try {
    const { paperId } = req.params;
    // Verify paper belongs to user's college
    const [papers] = await db.query(
      `SELECT paper_id, paper_title, status 
       FROM question_papers 
       WHERE paper_id = ?`,
      [paperId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found' });
    }

    const paper = papers[0];

    // Get all main questions for this paper
    const [questions] = await db.query(
      `SELECT q.question_id, q.question_text, q.question_type, q.marks
       FROM questions q
       JOIN paper_questions pq ON q.question_id = pq.question_id
       WHERE pq.paper_id = ?
       ORDER BY pq.question_order`,
      [paperId]
    );

    // If no questions found via paper_questions, try sub_questions table
    if (questions.length === 0) {
      const [directQuestions] = await db.query(
        `SELECT DISTINCT q.question_id, q.question_text, q.question_type, q.marks
         FROM questions q
         JOIN sub_questions sq ON q.question_id = sq.parent_question_id
         WHERE sq.paper_id = ?
         ORDER BY q.question_id`,
        [paperId]
      );
      questions.push(...directQuestions);
    }

    // For each question, get sub-questions with variation counts
    for (let question of questions) {
      // Get sub-questions with variation count
      const [subQuestions] = await db.query(
        `SELECT 
          sq.sub_question_id,
          sq.sub_question_number,
          sq.marks,
          COUNT(qv.variation_id) as variation_count
         FROM sub_questions sq
         LEFT JOIN question_variations qv ON sq.sub_question_id = qv.sub_question_id
         WHERE sq.parent_question_id = ?
         GROUP BY sq.sub_question_id, sq.sub_question_number, sq.marks
         ORDER BY sq.sub_question_number`,
        [question.question_id]
      );

      question.sub_questions = subQuestions;
      
      // Calculate total variation count for the question
      question.variation_count = subQuestions.reduce((sum, sq) => sum + sq.variation_count, 0);
    }

    res.json({
      success: true,
      paper: {
        paper_id: paper.paper_id,
        paper_title: paper.paper_title,
        questions
      }
    });
  } catch (err) {
    console.error('Get paper info error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get paper details with questions
router.get('/:paperId', authMiddleware, async (req, res) => {
  try {
    const { paperId} = req.params;
    const userId = req.user.user_id;
    const subjectId = req.user.subject_id;

    // Get paper (subject-based system)
    const [papers] = await db.query(
      `SELECT qp.*, u.name as generated_by_name 
       FROM question_papers qp
       JOIN users u ON qp.generated_by = u.user_id
       LEFT JOIN subjects s ON u.subject_id = s.subject_id
       WHERE qp.paper_id = ? AND qp.subject_id = ?`,
      [paperId, subjectId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found' });
    }

    const paper = papers[0];

    // Get questions linked to this paper
    const [questions] = await db.query(
      `SELECT q.question_id, q.question_text, q.question_type, q.difficulty, q.marks, q.options, q.correct_answer, pq.question_order
       FROM questions q
       JOIN paper_questions pq ON q.question_id = pq.question_id
       WHERE pq.paper_id = ?
       ORDER BY pq.question_order`,
      [paperId]
    );

    // Parse options JSON (if it's a string)
    questions.forEach(q => {
      if (q.options) {
        // If options is already an array/object, keep it as is
        if (typeof q.options === 'string') {
          try {
            q.options = JSON.parse(q.options);
          } catch (e) {
            console.error('Failed to parse options:', e);
            q.options = null;
          }
        }
        // If it's already an object/array, MySQL has already parsed it
      }
    });

    res.json({
      success: true,
      paper: {
        ...paper,
        questions
      }
    });
  } catch (err) {
    console.error('Fetch paper error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Submit paper for approval (draft -> pending_sme_review)
router.put('/:paperId/submit', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { paperId } = req.params;
    const userId = req.user.user_id;
    // Verify paper belongs to this user and is in draft status
    const [papers] = await db.query(
      'SELECT paper_id, status, paper_title FROM question_papers WHERE paper_id = ? AND generated_by = ?',
      [paperId, userId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found or unauthorized' });
    }

    const paper = papers[0];

    // Only allow submission of draft papers
    if (paper.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: 'Only draft papers can be submitted for approval.'
      });
    }

    // Update status to pending (for SME review)
    await db.query(
      'UPDATE question_papers SET status = ?, updated_at = NOW() WHERE paper_id = ?',
      ['pending', paperId]
    );

    // Log audit
    await db.query(
      'INSERT INTO audit_logs (user_id, college_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, null, 'PAPER_SUBMITTED', 'question_paper', paperId, `Submitted paper for SME review: ${paper.paper_title}`, req.ip]
    );

    res.json({
      success: true,
      message: 'Paper submitted for approval successfully'
    });
  } catch (err) {
    console.error('Submit paper error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Examiner confirms all variations (no more can be sent after this)
router.post('/:paperId/confirm-all', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { paperId } = req.params;
    const userId = req.user.user_id;
    // Verify paper belongs to this user
    const [papers] = await db.query(
      'SELECT paper_id, status, paper_title FROM question_papers WHERE paper_id = ? AND generated_by = ?',
      [paperId, userId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found or unauthorized' });
    }

    const paper = papers[0];

    // Check if already confirmed
    if (paper.status === 'confirmed_by_examiner') {
      return res.status(400).json({
        success: false,
        message: 'Paper is already confirmed. No more variations can be sent.'
      });
    }

    // Check if paper is in draft status (can only confirm draft papers)
    if (paper.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: `Cannot confirm paper with status '${paper.status}'. Only draft papers can be confirmed.`
      });
    }

    // Count variations sent to SME
    const [variationCheck] = await db.query(
      `SELECT COUNT(*) as sent_count 
       FROM question_variations 
       WHERE paper_id = ? AND status IN ('sent_to_sme', 'sme_approved', 'selected_by_sme')`,
      [paperId]
    );

    if (variationCheck[0].sent_count === 0) {
      return res.status(400).json({
        success: false,
        message: 'No variations have been sent to SME yet. Please send at least some variations before confirming.'
      });
    }

    // Update paper status to confirmed_by_examiner
    await db.query(
      'UPDATE question_papers SET status = ?, updated_at = NOW() WHERE paper_id = ?',
      ['confirmed_by_examiner', paperId]
    );

    console.log(`✅ Examiner confirmed paper ${paperId}. No more variations can be sent.`);

    // Log audit
    await db.query(
      'INSERT INTO audit_logs (user_id, college_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, null, 'EXAMINER_CONFIRMED_PAPER', 'question_paper', paperId, `Examiner confirmed paper (no more variations can be sent): ${paper.paper_title}`, req.ip]
    );

    res.json({
      success: true,
      message: 'Paper confirmed successfully. No more variations can be sent. SME can now review and send to moderator.',
      variations_sent: variationCheck[0].sent_count
    });
  } catch (err) {
    console.error('Confirm paper error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Mark paper as completed (examiner is done adding questions/variations) - DEPRECATED, use confirm-all instead
router.put('/:paperId/mark-complete', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { paperId } = req.params;
    const userId = req.user.user_id;

    // Verify paper belongs to this user (subject-based - no college check)
    const [papers] = await db.query(
      'SELECT paper_id, status, paper_title FROM question_papers WHERE paper_id = ? AND generated_by = ?',
      [paperId, userId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found or unauthorized' });
    }

    const paper = papers[0];

    // Check if already confirmed
    if (paper.status === 'confirmed_by_examiner') {
      return res.status(400).json({
        success: false,
        message: 'Paper is already confirmed.'
      });
    }

    // Validate that all sub-questions have at least 40 variations sent to SME
    const [subQuestions] = await db.query(
      `SELECT sq.sub_question_id, sq.full_question_number,
              (SELECT COUNT(*) 
               FROM question_variations v
               LEFT JOIN sme_variation_reviews svr ON v.variation_id = svr.variation_id
               WHERE v.sub_question_id = sq.sub_question_id
               AND (v.status = 'sent_to_sme' OR v.status = 'selected_by_sme' OR v.status = 'approved' OR v.status = 'unselected_by_sme')
              ) as sent_to_sme_count
       FROM sub_questions sq
       WHERE sq.paper_id = ?`,
      [paperId]
    );

    const insufficientSubQuestions = subQuestions.filter(sq => sq.sent_to_sme_count < 40);
    
    if (insufficientSubQuestions.length > 0) {
      const details = insufficientSubQuestions
        .map(sq => `${sq.full_question_number} (${sq.sent_to_sme_count}/40)`)
        .join(', ');
      
      return res.status(400).json({
        success: false,
        message: `Cannot confirm paper. Each sub-question must have at least 40 variations sent to SME. Insufficient: ${details}`
      });
    }

    // Update paper status to confirmed_by_examiner
    await db.query(
      'UPDATE question_papers SET status = ?, updated_at = NOW() WHERE paper_id = ?',
      ['confirmed_by_examiner', paperId]
    );

    console.log(`✅ Examiner marked paper ${paperId} as complete`);

    // Log audit (collegeId can be null in subject-based system)
    await db.query(
      'INSERT INTO audit_logs (user_id, college_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, null, 'EXAMINER_CONFIRMED_PAPER', 'question_paper', paperId, `Examiner confirmed paper: ${paper.paper_title}`, req.ip]
    );

    res.json({
      success: true,
      message: 'Paper confirmed successfully. SME can now review and send to moderator.'
    });
  } catch (err) {
    console.error('Mark paper complete error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// SME: Send selected variations to moderator
router.post('/:paperId/send-to-moderator', authMiddleware, requireRole('subject_matter_expert'), async (req, res) => {
  try {
    const { paperId } = req.params;
    const smeId = req.user.user_id;

    // Get SME's subject
    const [smeData] = await db.query(
      'SELECT subject_id FROM users WHERE user_id = ?',
      [smeId]
    );

    if (!smeData || smeData.length === 0 || !smeData[0].subject_id) {
      return res.status(400).json({ 
        success: false, 
        message: 'No subject assigned to your account. Please contact administrator.' 
      });
    }

    const subjectId = smeData[0].subject_id;

    // Verify paper exists and belongs to examiner in same subject
    const [papers] = await db.query(
      `SELECT qp.paper_id, qp.status, qp.paper_title, qp.generated_by 
       FROM question_papers qp
       JOIN users u ON qp.generated_by = u.user_id
       LEFT JOIN subjects s ON u.subject_id = s.subject_id
       WHERE qp.paper_id = ? AND u.subject_id = ?`,
      [paperId, subjectId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found or not in your subject' });
    }

    const paper = papers[0];

    // Check if paper has been confirmed by examiner
    if (paper.status !== 'confirmed_by_examiner') {
      return res.status(400).json({
        success: false,
        message: 'Paper must be confirmed by examiner before sending to moderator. Please wait for examiner to confirm.'
      });
    }

    // Check if paper has already been sent to moderator
    if (paper.status === 'pending_moderator' || paper.status === 'approved') {
      return res.status(400).json({
        success: false,
        message: 'Paper has already been sent to moderator.'
      });
    }

    // Get all selected variations (selected_by_sme status)
    const [selectedVariations] = await db.query(
      `SELECT qv.variation_id, qv.status, sq.sub_question_id, sq.full_question_number
       FROM question_variations qv
       JOIN sub_questions sq ON qv.sub_question_id = sq.sub_question_id
       WHERE qv.paper_id = ? AND qv.status = 'selected_by_sme'`,
      [paperId]
    );

    if (selectedVariations.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No variations have been selected. Please select variations before sending to moderator.'
      });
    }

    // Validate that each sub-question has at least 4 selected variations
    const subQuestionCounts = {};
    selectedVariations.forEach(v => {
      subQuestionCounts[v.sub_question_id] = (subQuestionCounts[v.sub_question_id] || 0) + 1;
    });

    const invalidSubQuestions = Object.entries(subQuestionCounts)
      .filter(([_, count]) => count <= 3)
      .map(([subQuestionId, _]) => {
        const variation = selectedVariations.find(v => v.sub_question_id == subQuestionId);
        return variation?.full_question_number;
      });

    if (invalidSubQuestions.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot send to moderator. Each sub-question must have more than 3 selected variations (minimum 4). Insufficient: ${invalidSubQuestions.join(', ')}`
      });
    }

    // Update selected variations to sent_to_moderator
    const variationIds = selectedVariations.map(v => v.variation_id);
    const [updateResult] = await db.query(
      `UPDATE question_variations 
       SET status = 'sent_to_moderator' 
       WHERE variation_id IN (?) AND status = 'selected_by_sme'`,
      [variationIds]
    );

    console.log(`✅ Updated ${updateResult.affectedRows} selected variations to sent_to_moderator for paper ${paperId}`);

    // Update paper status to pending_moderator
    await db.query(
      'UPDATE question_papers SET status = ?, updated_at = NOW() WHERE paper_id = ?',
      ['pending_moderator', paperId]
    );

    // Log audit (collegeId can be null in subject-based system)
    await db.query(
      'INSERT INTO audit_logs (user_id, college_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [smeId, null, 'PAPER_SENT_TO_MODERATOR', 'question_paper', paperId, `SME sent ${updateResult.affectedRows} selected variations to moderator: ${paper.paper_title}`, req.ip]
    );

    res.json({
      success: true,
      message: 'Selected variations sent to moderator successfully',
      variations_sent: updateResult.affectedRows
    });
  } catch (err) {
    console.error('Send to moderator error:', err);
    res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
});

// Delete paper (only if draft status)
router.delete('/:paperId', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { paperId } = req.params;
    const userId = req.user.user_id;

    // Verify paper belongs to this user and is in draft status (subject-based)
    const [papers] = await db.query(
      'SELECT paper_id, status, paper_title FROM question_papers WHERE paper_id = ? AND generated_by = ?',
      [paperId, userId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found or unauthorized' });
    }

    const paper = papers[0];

    // Only allow deletion of draft papers
    if (paper.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: 'Only draft papers can be deleted. This paper has already been submitted.'
      });
    }

    // Delete paper_questions links first (foreign key constraint)
    await db.query('DELETE FROM paper_questions WHERE paper_id = ?', [paperId]);

    // Delete the paper
    await db.query('DELETE FROM question_papers WHERE paper_id = ?', [paperId]);

    // Log audit (collegeId can be null in subject-based system)
    await db.query(
      'INSERT INTO audit_logs (user_id, college_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, null, 'PAPER_DELETED', 'question_paper', paperId, `Deleted draft paper: ${paper.paper_title}`, req.ip]
    );

    res.json({
      success: true,
      message: 'Paper deleted successfully'
    });
  } catch (err) {
    console.error('Delete paper error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Update paper and questions (for both examiners and SMEs)
router.put('/:paperId', authMiddleware, async (req, res) => {
  try {
    const { paperId } = req.params;
    const { questions } = req.body;
    const userId = req.user.user_id;
    const userRole = req.user.role;

    // For examiners: verify paper belongs to them
    // For SMEs: verify paper is in their department and pending review
    let papers;
    if (userRole === 'examiner') {
      [papers] = await db.query(
        'SELECT paper_id FROM question_papers WHERE paper_id = ? AND generated_by = ?',
        [paperId, userId]
      );
    } else if (userRole === 'subject_matter_expert') {
      // Get SME's subject
      const [smeData] = await db.query(
        'SELECT subject_id FROM users WHERE user_id = ?',
        [userId]
      );

      if (smeData.length === 0 || !smeData[0].subject_id) {
        return res.status(400).json({ success: false, message: 'Subject not found for SME' });
      }

      const subjectId = smeData[0].subject_id;

      // Verify paper is in SME's subject
      [papers] = await db.query(
        `SELECT qp.paper_id 
         FROM question_papers qp
         JOIN users u ON qp.generated_by = u.user_id
         LEFT JOIN subjects s ON u.subject_id = s.subject_id
         WHERE qp.paper_id = ? 
           AND u.subject_id = ?`,
        [paperId, subjectId]
      );
    } else {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found or unauthorized' });
    }

    // Subject-based system
    // Delete existing question links for this paper
    await db.query('DELETE FROM paper_questions WHERE paper_id = ?', [paperId]);

    // Get existing question IDs to delete orphaned questions
    const [oldQuestions] = await db.query(
      'SELECT question_id FROM paper_questions WHERE paper_id = ?',
      [paperId]
    );

    // Insert updated questions
    let totalMarks = 0;
    let questionOrder = 0;
    for (const q of questions) {
      if (q.question_text && q.question_text.trim()) {
        const [questionResult] = await db.query(
          `INSERT INTO questions (subject_id, created_by, question_text, question_type, difficulty, marks, options, correct_answer, status) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
          [
            subjectId,
            userId,
            q.question_text,
            q.question_type || 'short_answer',
            q.difficulty || 'medium',
            q.marks || 1,
            q.options ? JSON.stringify(q.options) : null,
            q.correct_answer || null
          ]
        );

        // Link question to paper
        await db.query(
          'INSERT INTO paper_questions (paper_id, question_id, question_order) VALUES (?, ?, ?)',
          [paperId, questionResult.insertId, questionOrder++]
        );

        totalMarks += (q.marks || 1);
      }
    }

    // Update paper total marks
    await db.query(
      'UPDATE question_papers SET total_marks = ? WHERE paper_id = ?',
      [totalMarks, paperId]
    );

    res.json({ success: true, message: 'Paper updated successfully' });
  } catch (err) {
    console.error('Update paper error:', err);
    res.status(500).json({ success: false, message: 'Failed to update paper' });
  }
});

// Submit paper to moderator (papers are already in pending status, so this is just a confirmation)
router.put('/:paperId/submit', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { paperId } = req.params;
    const userId = req.user.user_id;
    // Verify paper belongs to this user and is in draft status
    const [papers] = await db.query(
      'SELECT paper_id FROM question_papers WHERE paper_id = ? AND generated_by = ? AND status = "draft"',
      [paperId, userId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found or already processed' });
    }

    // Log audit
    await db.query(
      'INSERT INTO audit_logs (user_id, college_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, null, 'PAPER_SUBMITTED', 'question_paper', paperId, 'Confirmed submission to admin', req.ip]
    );

    res.json({ success: true, message: 'Paper confirmed for College Admin review' });
  } catch (err) {
    console.error('Submit paper error:', err);
    res.status(500).json({ success: false, message: 'Failed to submit paper' });
  }
});


// Generate question paper matching PDF structure exactly (incremental question generation)
router.post('/generate-from-pdf-structure', authMiddleware, requireRole('examiner'), async (req, res) => {
  const { reference_pdf_id, subject, topic, paper_id, num_questions_to_generate } = req.body;
  const userId = req.user.user_id;
  const subjectId = req.user.subject_id;
  
  if (!reference_pdf_id) {
    return res.status(400).json({ success: false, message: 'Reference PDF ID is required' });
  }

  if (!subject) {
    return res.status(400).json({ success: false, message: 'Subject name is required' });
  }

  if (!topic) {
    return res.status(400).json({ success: false, message: 'Topic name is required' });
  }

  // If paper_id is provided, add questions to existing paper
  // Otherwise, create a new paper
  return await generateFromPDFStructureIncremental(req, res, {
    reference_pdf_id,
    subject,
    topic,
    paper_id: paper_id || null,
    num_questions_to_generate: num_questions_to_generate || 5, // Default 5 questions at a time
    userId,
    subjectId
  });
});

// Generate questions from uploaded PDF using RAG
router.post('/generate-from-pdf', authMiddleware, requireRole('examiner'), async (req, res) => {
  try {
    const { pdf_id, num_questions, difficulty, question_types, marks_distribution, total_marks } = req.body;
    const userId = req.user.user_id;
    if (!pdf_id) {
      return res.status(400).json({ success: false, message: 'PDF ID is required' });
    }

    // Get PDF details
    const [pdfs] = await db.query(
      'SELECT * FROM uploaded_pdfs WHERE pdf_id = ?',
      [pdf_id]
    );

    if (pdfs.length === 0) {
      return res.status(404).json({ success: false, message: 'PDF not found' });
    }

    const pdf = pdfs[0];

    // Import PDF utilities
    const { generateQueryEmbedding } = require('../utils/pdfProcessor');
    const { querySimilarChunks } = require('../utils/pinecone');

    // Generate query embedding for the topic
    const queryText = `${pdf.subject || ''} ${pdf.topic || ''} ${pdf.description || ''}`.trim();
    const queryEmbedding = await generateQueryEmbedding(queryText || 'general knowledge');

    // Query relevant chunks from Pinecone (subject-based system)
    const namespace = `subject_${subjectId}`;
    const relevantChunks = await querySimilarChunks(
      queryEmbedding,
      namespace,
      10, // Get top 10 most relevant chunks
      { pdfId: pdf_id }
    );

    if (relevantChunks.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No content found in PDF. Please re-upload the PDF.'
      });
    }

    // Combine relevant chunks into context
    const context = relevantChunks
      .map(chunk => chunk.metadata.text)
      .join('\n\n');

    console.log(`📚 Retrieved ${relevantChunks.length} relevant chunks (${context.length} characters)`);

    // Build prompt with context
    const selectedTypes = Object.keys(question_types).filter(type => question_types[type]);

    const prompt = `You are an expert question paper generator. Based on the following content from a PDF document, generate high-quality questions.

CONTEXT FROM PDF:
${context}

SPECIFICATIONS:
- Total Questions: ${num_questions}
- Difficulty Level: ${difficulty}
- Total Marks: ${total_marks || 50}
- Question Types: ${selectedTypes.join(', ')}

IMPORTANT INSTRUCTIONS:
1. Generate questions ONLY based on the provided context
2. Ensure questions test understanding of the material
3. Distribute ${total_marks || 50} marks across all ${num_questions} questions
4. Make questions clear and unambiguous
5. MUST provide "correct_answer" for ALL question types

MARKS DISTRIBUTION:
- MCQ: ${marks_distribution.mcq || 1} marks each
- Short Answer: ${marks_distribution.short_answer || 2} marks each (with 2-3 sentence answers)
- Long Answer: ${marks_distribution.long_answer || 5} marks each (with 1-2 paragraph answers)

Return ONLY valid JSON in this exact structure (no markdown, no comments):
{
  "questions": [
    {
      "type": "mcq",
      "question_text": "Based on the content, what is...?",
      "options": ["Option 1", "Option 2", "Option 3", "Option 4"],
      "correct_answer": "Option 1",
      "marks": ${marks_distribution.mcq || 1},
      "difficulty": "${difficulty}"
    },
    {
      "type": "short_answer",
      "question_text": "Explain the concept of...",
      "correct_answer": "The concept refers to... [2-3 sentences providing the complete answer based on the PDF content]",
      "marks": ${marks_distribution.short_answer || 2},
      "difficulty": "${difficulty}"
    },
    {
      "type": "long_answer",
      "question_text": "Discuss in detail...",
      "correct_answer": "A comprehensive explanation... [1-2 paragraphs providing the complete answer based on the PDF content]",
      "marks": ${marks_distribution.long_answer || 5},
      "difficulty": "${difficulty}"
    }
  ],
  "total_marks": ${total_marks || 50}
}

CRITICAL:
- For MCQ: "options" MUST be an array of 4 strings, "correct_answer" must match one option
- For Short Answer: "correct_answer" must be 2-3 sentences from the PDF content
- For Long Answer: "correct_answer" must be 1-2 paragraphs from the PDF content
- ALL questions MUST have a "correct_answer" field

Generate questions that demonstrate understanding of the provided content.`;

    // Call Gemini API
    let generatedText = await callGeminiAPI(prompt);

    // Extract JSON from response
    generatedText = generatedText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    console.log('Generated questions from PDF context');

    const generatedData = JSON.parse(generatedText);

    // Ensure MCQ questions have proper options array
    generatedData.questions = generatedData.questions.map(q => {
      if (q.type === 'mcq' && (!q.options || q.options.length === 0)) {
        q.options = ['Option A', 'Option B', 'Option C', 'Option D'];
      }
      return q;
    });

    // Calculate actual total marks
    const actualTotalMarks = generatedData.questions.reduce((sum, q) => sum + (q.marks || 0), 0);

    // Insert question paper (subject-based system)
    const [paperResult] = await db.query(
      `INSERT INTO question_papers 
       (subject, topic, difficulty, total_questions, total_marks, created_by, subject_id, status, source_type, source_pdf_id) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        pdf.subject || 'PDF Content',
        pdf.topic || pdf.file_name,
        difficulty,
        generatedData.questions.length,
        actualTotalMarks,
        userId,
        subjectId,
        'draft',
        'pdf',
        pdf_id
      ]
    );

    const paperId = paperResult.insertId;

    // Insert questions (subject-based system)
    for (const question of generatedData.questions) {
      await db.query(
        `INSERT INTO questions 
         (paper_id, question_type, question_text, options, correct_answer, marks, difficulty, created_by, subject_id) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          paperId,
          question.type,
          question.question_text,
          question.type === 'mcq' ? JSON.stringify(question.options) : null,
          question.correct_answer || null,
          question.marks,
          question.difficulty,
          userId,
          subjectId
        ]
      );
    }

    res.json({
      success: true,
      message: 'Questions generated successfully from PDF',
      paper: {
        paper_id: paperId,
        total_questions: generatedData.questions.length,
        total_marks: actualTotalMarks,
        source: 'pdf',
        pdf_name: pdf.file_name
      },
      questions: generatedData.questions
    });

  } catch (error) {
    console.error('Generate from PDF error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to generate questions from PDF'
    });
  }
});

// Moderator: Get all papers sent by SME (status='pending')
router.get('/moderator/pending-papers', authMiddleware, requireRole('moderator'), async (req, res) => {
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

    // Get all papers with status='pending_moderator' in moderator's subject
    const [papers] = await db.query(
      `SELECT qp.paper_id, qp.paper_title, qp.total_marks, qp.status, qp.created_at, qp.updated_at,
              u_examiner.name as examiner_name,
              u_examiner.user_id as examiner_id,
              s.subject_name,
              (SELECT COUNT(*) FROM paper_questions WHERE paper_id = qp.paper_id) as question_count
       FROM question_papers qp
       JOIN users u_examiner ON qp.generated_by = u_examiner.user_id
       LEFT JOIN subjects s ON u_examiner.subject_id = s.subject_id
       WHERE u_examiner.subject_id = ? AND qp.status = 'pending_moderator'
       ORDER BY qp.updated_at DESC`,
      [subjectId]);

    res.json({ success: true, papers });
  } catch (err) {
    console.error('Get pending papers error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Moderator: Get all finalized papers (categorized and approved)
router.get('/moderator/finalized-papers', authMiddleware, requireRole('moderator'), async (req, res) => {
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

    // Get only base papers with status='finalized' in moderator's subject
    const [papers] = await db.query(
      `SELECT qp.paper_id, qp.paper_title, qp.total_marks, qp.status, qp.created_at, qp.updated_at,
              u_examiner.name as examiner_name,
              u_examiner.user_id as examiner_id,
              s.subject_name,
              (SELECT COUNT(*) FROM question_papers qp2 
               JOIN users u2 ON qp2.generated_by = u2.user_id
               WHERE u2.subject_id = ?
               AND qp2.status = 'approved' 
               AND qp2.paper_category IS NOT NULL
               AND qp2.paper_title LIKE CONCAT(qp.paper_title, ' - Set %')) as categorized_count
       FROM question_papers qp
       JOIN users u_examiner ON qp.generated_by = u_examiner.user_id
       LEFT JOIN subjects s ON u_examiner.subject_id = s.subject_id
       WHERE u_examiner.subject_id = ? 
       AND qp.status = 'finalized'
       ORDER BY qp.updated_at DESC`,
      [subjectId, subjectId]);

    res.json({ success: true, papers });
  } catch (err) {
    console.error('Get finalized papers error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Moderator: Get paper details with all questions and sub-question variations
router.get('/moderator/paper/:paperId/details', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { paperId } = req.params;
    // Get paper details
    const [papers] = await db.query(
      `SELECT qp.paper_id, qp.paper_title, qp.total_marks, qp.status, qp.created_at, qp.updated_at,
              u_examiner.name as examiner_name,
              u_examiner.user_id as examiner_id,
              s.subject_name
       FROM question_papers qp
       JOIN users u_examiner ON qp.generated_by = u_examiner.user_id
       LEFT JOIN subjects s ON u_examiner.subject_id = s.subject_id
       WHERE qp.paper_id = ?`,
      [paperId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found' });
    }

    const paper = papers[0];

    // Get all questions for this paper
    const [questions] = await db.query(
      `SELECT q.question_id, q.question_text, q.question_type, q.difficulty, q.marks,
              q.options, q.correct_answer, pq.question_order
       FROM questions q
       JOIN paper_questions pq ON q.question_id = pq.question_id
       WHERE pq.paper_id = ?
       ORDER BY pq.question_order`,
      [paperId]
    );

    console.log(`📋 Found ${questions.length} questions for paper ${paperId}`);

    // If no questions found via paper_questions, try to find questions directly linked to paper via sub_questions
    if (questions.length === 0) {
      console.log(`⚠️ No questions in paper_questions table. Checking sub_questions table...`);

      // Get questions that have sub-questions linked to this paper
      const [directQuestions] = await db.query(
        `SELECT DISTINCT q.question_id, q.question_text, q.question_type, q.difficulty, q.marks,
                q.options, q.correct_answer
         FROM questions q
         JOIN sub_questions sq ON q.question_id = sq.parent_question_id
         WHERE sq.paper_id = ?
         ORDER BY q.question_id`,
        [paperId]
      );

      console.log(`📋 Found ${directQuestions.length} questions via sub_questions table`);
      questions.push(...directQuestions);
    }

    // Parse options JSON for MCQ questions
    questions.forEach(q => {
      if (q.options && typeof q.options === 'string') {
        try {
          q.options = JSON.parse(q.options);
        } catch (e) {
          q.options = null;
        }
      }
    });

    // Get sub-questions and their variations for each question
    for (let question of questions) {
      const [subQuestions] = await db.query(
        `SELECT sq.sub_question_id, sq.sub_question_number, sq.full_question_number,
                sq.question_type, sq.marks, sq.created_at
         FROM sub_questions sq
         WHERE sq.parent_question_id = ?
         ORDER BY sq.sub_question_number`,
        [question.question_id]
      );

      console.log(`  📝 Question ${question.question_id}: Found ${subQuestions.length} sub-questions`);

      // Get variations for each sub-question (only sme_approved ones sent to moderator)
      for (let subQuestion of subQuestions) {
        const [variations] = await db.query(
          `SELECT v.variation_id, v.variation_number, v.question_text, v.question_type,
                  v.options, v.correct_answer, v.marks, v.status, v.created_at,
                  svr.comments as sme_comments, svr.reviewed_at as sme_reviewed_at
           FROM question_variations v
           LEFT JOIN sme_variation_reviews svr ON v.variation_id = svr.variation_id
           WHERE v.sub_question_id = ? AND v.status IN ('sent_to_moderator', 'approved', 'rejected')
           ORDER BY v.variation_number`,
          [subQuestion.sub_question_id]
        );

        // Parse options JSON for MCQ variations
        variations.forEach(v => {
          if (v.options && typeof v.options === 'string') {
            try {
              v.options = JSON.parse(v.options);
            } catch (e) {
              v.options = null;
            }
          }
        });

        console.log(`    🔹 Sub-question ${subQuestion.sub_question_id}: ${variations.length} variations with status sent_to_moderator/approved/rejected`);
        subQuestion.variations = variations;
      }

      // Don't filter out sub-questions - variations will be loaded via pagination
      // Just set the variations array (can be empty, will be loaded on expand)
      question.sub_questions = subQuestions;
      question.sub_question_count = subQuestions.length;
    }

    // Don't filter out questions - show all questions even if sub-questions have no variations yet
    // Variations will be loaded via pagination when sub-questions are expanded
    paper.questions = questions;

    res.json({ success: true, paper });
  } catch (err) {
    console.error('Get paper details error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Moderator: AI-powered categorization of variations into 3 sets
router.post('/moderator/paper/:paperId/ai-categorize', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { paperId } = req.params;
    // Get paper details with all variations
    const [papers] = await db.query(
      `SELECT qp.paper_id, qp.paper_title, qp.total_marks
       FROM question_papers qp
       WHERE qp.paper_id = ?`,
      [paperId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found' });
    }

    // Get all sub-questions with their variations
    const [subQuestions] = await db.query(
      `SELECT sq.sub_question_id, sq.full_question_number, sq.question_type, sq.marks,
              q.question_id, q.question_text as parent_question_text
       FROM sub_questions sq
       JOIN questions q ON sq.parent_question_id = q.question_id
       JOIN paper_questions pq ON q.question_id = pq.question_id
       WHERE pq.paper_id = ?
       ORDER BY pq.question_order, sq.sub_question_number`,
      [paperId]
    );

    if (subQuestions.length === 0) {
      return res.status(400).json({ success: false, message: 'No sub-questions found in this paper' });
    }

    // Get all approved variations for each sub-question
    const categorization = {
      general: [],
      reexam: [],
      special: []
    };

    console.log(`[AI Categorization] Processing ${subQuestions.length} sub-questions for paper ${paperId}`);

    // First, collect all variations for all sub-questions
    const allSubQuestionsWithVariations = [];

    for (let subQ of subQuestions) {
      const [variations] = await db.query(
        `SELECT v.variation_id, v.variation_number, v.question_text, v.question_type,
                v.options, v.correct_answer, v.marks, v.status
         FROM question_variations v
         WHERE v.sub_question_id = ? AND v.status IN ('sent_to_moderator', 'sme_approved', 'moderator_approved', 'approved')
         ORDER BY v.variation_number`,
        [subQ.sub_question_id]
      );

      console.log(`[AI Categorization] Sub-question ${subQ.full_question_number}: Found ${variations.length} variations`);

      if (variations.length > 0) {
        allSubQuestionsWithVariations.push({
          sub_question_id: subQ.sub_question_id,
          full_question_number: subQ.full_question_number,
          variations: variations
        });
      }
    }

    // Determine how many sets we can create (minimum variations across all sub-questions)
    const minVariations = Math.min(...allSubQuestionsWithVariations.map(sq => sq.variations.length));
    const numSets = Math.min(minVariations, 3); // Maximum 3 sets

    console.log(`[AI Categorization] Can create ${numSets} sets (minimum ${minVariations} variations per sub-question)`);

    // Distribute variations: Set 1 gets all variation #1, Set 2 gets all variation #2, etc.
    const categories = ['general', 'reexam', 'special'];

    for (let setIndex = 0; setIndex < numSets; setIndex++) {
      const category = categories[setIndex];

      // For this set, take the same variation number from each sub-question
      for (let subQ of allSubQuestionsWithVariations) {
        const variation = subQ.variations[setIndex]; // Get variation at this index

        categorization[category].push({
          sub_question_id: subQ.sub_question_id,
          full_question_number: subQ.full_question_number,
          variation_id: variation.variation_id,
          variation_number: variation.variation_number,
          question_text: variation.question_text,
          question_type: variation.question_type,
          options: variation.options,
          correct_answer: variation.correct_answer,
          marks: variation.marks
        });
      }

      console.log(`[AI Categorization] Set ${setIndex + 1} (${category}): ${categorization[category].length} variations`);
    }

    console.log(`[AI Categorization] Final result - General: ${categorization.general.length}, Re-exam: ${categorization.reexam.length}, Special: ${categorization.special.length}`);

    res.json({
      success: true,
      categorization,
      stats: {
        general_count: categorization.general.length,
        reexam_count: categorization.reexam.length,
        special_count: categorization.special.length
      }
    });
  } catch (err) {
    console.error('AI categorization error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Moderator: Save categorization and create 3 final papers
router.post('/moderator/paper/:paperId/save-categorization', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { paperId } = req.params;
    const { categorization } = req.body;
    const moderatorId = req.user.user_id;
    const subjectId = req.user.subject_id;

    // Get original paper
    const [papers] = await db.query(
      `SELECT qp.*, u.name as examiner_name
       FROM question_papers qp
       JOIN users u ON qp.generated_by = u.user_id
       LEFT JOIN subjects s ON u.subject_id = s.subject_id
       WHERE qp.paper_id = ?`,
      [paperId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found' });
    }

    const originalPaper = papers[0];

    // Create 3 new papers (one for each category)
    const categories = [
      { key: 'general', name: 'General Exam', color: 'primary' },
      { key: 'reexam', name: 'Re-Exam', color: 'warning' },
      { key: 'special', name: 'Special Case', color: 'info' }
    ];

    const createdPapers = [];

    for (let category of categories) {
      const variations = categorization[category.key];

      if (!variations || variations.length === 0) {
        continue;
      }

      // Calculate total marks
      const totalMarks = variations.reduce((sum, v) => sum + (v.marks || 0), 0);

      // Create new paper
      const paperTitle = `${originalPaper.paper_title} - ${category.name}`;
      const [paperResult] = await db.query(
        `INSERT INTO question_papers 
         (generated_by, paper_title, total_marks, status, created_at, updated_at) 
         VALUES (?, ?, ?, 'draft', NOW(), NOW())`,
        [originalPaper.generated_by, paperTitle, totalMarks]
      );

      const newPaperId = paperResult.insertId;

      // Group variations by sub_question_id to maintain question structure
      const variationsBySubQ = {};
      variations.forEach(v => {
        if (!variationsBySubQ[v.sub_question_id]) {
          variationsBySubQ[v.sub_question_id] = [];
        }
        variationsBySubQ[v.sub_question_id].push(v);
      });

      // Create questions for this paper
      let questionOrder = 1;
      for (let subQId in variationsBySubQ) {
        const subQVariations = variationsBySubQ[subQId];

        // Use the first variation as the question
        const firstVariation = subQVariations[0];

        // Clean the question text - remove any existing question number prefix
        // Format: "Q1.a.6 Question text" -> "Question text"
        let cleanQuestionText = firstVariation.question_text;
        const questionTextMatch = cleanQuestionText.match(/^Q\d+\.[a-z](?:\.\d+)?\s+(.+)$/i);
        if (questionTextMatch) {
          cleanQuestionText = questionTextMatch[1];
        }

        const [questionResult] = await db.query(
          `INSERT INTO questions 
           (question_text, question_type, options, correct_answer, marks, difficulty, 
            created_by, subject_id, status) 
           VALUES (?, ?, ?, ?, ?, 'medium', ?, ?, 'active')`,
          [
            `${firstVariation.full_question_number} ${cleanQuestionText}`,
            firstVariation.question_type,
            firstVariation.options ? JSON.stringify(firstVariation.options) : null,
            firstVariation.correct_answer,
            firstVariation.marks,
            moderatorId,
            subjectId
          ]
        );

        // Link question to paper
        await db.query(
          'INSERT INTO paper_questions (paper_id, question_id, question_order) VALUES (?, ?, ?)',
          [newPaperId, questionResult.insertId, questionOrder++]
        );
      }

      createdPapers.push({
        paper_id: newPaperId,
        title: paperTitle,
        category: category.name,
        total_marks: totalMarks,
        question_count: Object.keys(variationsBySubQ).length
      });
    }

    // Update original paper status to finalized (categorization complete)
    await db.query(
      'UPDATE question_papers SET status = ? WHERE paper_id = ?',
      ['finalized', paperId]
    );

    // Log audit
    await db.query(
      'INSERT INTO audit_logs (user_id, college_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [moderatorId, null, 'PAPER_CATEGORIZED', 'question_paper', paperId, `Created 3 categorized papers from ${originalPaper.paper_title}`, req.ip]
    );

    res.json({
      success: true,
      message: 'Papers categorized and created successfully',
      papers: createdPapers
    });
  } catch (err) {
    console.error('Save categorization error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Moderator: Approve individual variation
router.post('/moderator/variation/:variationId/approve', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { variationId } = req.params;
    const moderatorId = req.user.user_id;
    
    // Verify variation exists (subject-based - no college check)
    const [variations] = await db.query(
      `SELECT v.* 
       FROM question_variations v
       JOIN sub_questions sq ON v.sub_question_id = sq.sub_question_id
       JOIN questions q ON sq.parent_question_id = q.question_id
       JOIN paper_questions pq ON q.question_id = pq.question_id
       JOIN question_papers qp ON pq.paper_id = qp.paper_id
       WHERE v.variation_id = ?`,
      [variationId]
    );

    if (variations.length === 0) {
      return res.status(404).json({ success: false, message: 'Variation not found' });
    }

    const variation = variations[0];

    if (variation.status !== 'sme_approved') {
      return res.status(400).json({
        success: false,
        message: 'Only SME-approved variations can be approved by moderator'
      });
    }

    // Update variation status to moderator_approved
    await db.query(
      `UPDATE question_variations 
       SET status = 'moderator_approved' 
       WHERE variation_id = ?`,
      [variationId]
    );

    // Log audit
    await db.query(
      'INSERT INTO audit_logs (user_id, college_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [moderatorId, null, 'VARIATION_APPROVED', 'question_variation', variationId, `Moderator approved variation ${variationId}`, req.ip]
    );

    res.json({
      success: true,
      message: 'Variation approved successfully'
    });
  } catch (err) {
    console.error('Approve variation error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Moderator: Reject individual variation
router.post('/moderator/variation/:variationId/reject', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { variationId } = req.params;
    const moderatorId = req.user.user_id;
    
    // Verify variation exists (subject-based - no college check)
    const [variations] = await db.query(
      `SELECT v.* 
       FROM question_variations v
       JOIN sub_questions sq ON v.sub_question_id = sq.sub_question_id
       JOIN questions q ON sq.parent_question_id = q.question_id
       JOIN paper_questions pq ON q.question_id = pq.question_id
       JOIN question_papers qp ON pq.paper_id = qp.paper_id
       WHERE v.variation_id = ?`,
      [variationId]
    );

    if (variations.length === 0) {
      return res.status(404).json({ success: false, message: 'Variation not found' });
    }

    const variation = variations[0];

    if (variation.status !== 'sme_approved') {
      return res.status(400).json({
        success: false,
        message: 'Only SME-approved variations can be rejected by moderator'
      });
    }

    // Update variation status to rejected
    await db.query(
      `UPDATE question_variations 
       SET status = 'rejected' 
       WHERE variation_id = ?`,
      [variationId]
    );

    // Log audit
    await db.query(
      'INSERT INTO audit_logs (user_id, college_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [moderatorId, null, 'VARIATION_REJECTED', 'question_variation', variationId, `Moderator rejected variation ${variationId}`, req.ip]
    );

    res.json({
      success: true,
      message: 'Variation rejected successfully'
    });
  } catch (err) {
    console.error('Reject variation error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Moderator: Final approval of categorized papers
router.post('/moderator/paper/:paperId/final-approve', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { paperId } = req.params;
    const moderatorId = req.user.user_id;

    // Verify paper exists and is categorized
    const [papers] = await db.query(
      `SELECT qp.paper_id, qp.paper_title, qp.status
       FROM question_papers qp
       WHERE qp.paper_id = ?`,
      [paperId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found' });
    }

    const paper = papers[0];

    if (paper.status !== 'finalized' && paper.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: 'Paper must be finalized before final approval'
      });
    }

    // Update paper status to approved
    await db.query(
      'UPDATE question_papers SET status = ?, updated_at = NOW() WHERE paper_id = ?',
      ['approved', paperId]
    );

    // Log audit
    await db.query(
      'INSERT INTO audit_logs (user_id, college_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [moderatorId, null, 'PAPER_FINAL_APPROVED', 'question_paper', paperId, `Final approval for ${paper.paper_title}`, req.ip]
    );

    res.json({
      success: true,
      message: 'Paper approved successfully'
    });
  } catch (err) {
    console.error('Final approval error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Moderator: Download categorized paper as PDF

// Optional libs for Arabic shaping + BiDi. Fallback logic is included if they are missing.
let arabicReshaper = null;
let bidiJs = null;
try { arabicReshaper = require('arabic-reshaper'); } catch (e) { console.warn('arabic-reshaper not installed'); }
try { bidiJs = require('bidi-js'); } catch (e) { console.warn('bidi-js not installed'); }

// Small helper: detect Arabic/Urdu characters
const containsArabic = (text = '') => /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(String(text));
const containsDevanagari = (text = '') => /[\u0900-\u097F]/.test(String(text));

// Helper: shape + bidi reorder Arabic/Urdu text to visual order for PDFKit
const processArabicForPdf = (text) => {
  if (!text || !containsArabic(text)) return text;
  try {
    let shaped = text;
    if (arabicReshaper && typeof arabicReshaper.reshape === 'function') {
      shaped = arabicReshaper.reshape(text);
    }
    if (bidiJs && typeof bidiJs.getDisplay === 'function') {
      return bidiJs.getDisplay(shaped);
    } else if (bidiJs && typeof bidiJs.createBidi === 'function') {
      const bidi = bidiJs.createBidi(shaped);
      if (typeof bidi.getLogicalToVisual === 'function') return bidi.getLogicalToVisual();
    }
    // fallback: reverse by words (not perfect but better than raw order)
    return shaped.split(' ').reverse().join(' ');
  } catch (err) {
    console.error('processArabicForPdf error:', err);
    return text.split('').reverse().join('');
  }
};

// Detect paper language from content
const detectPaperLanguage = (paper, questions) => {
  const allText = [
    paper.paper_title || '',
    paper.college_name || '',
    ...questions.map(q => q.question_text || '')
  ].join(' ');

  if (containsDevanagari(allText)) {
    // Check if it's Hindi or Marathi (ळ is unique to Marathi)
    if (/[ळ]/.test(allText)) return 'marathi';
    return 'hindi';
  }
  if (containsArabic(allText)) return 'urdu';
  return 'english';
};

// Convert numbers to Devanagari script
const toDevanagariNumber = (num) => {
  const devanagariDigits = ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९'];
  return String(num).split('').map(digit => devanagariDigits[parseInt(digit)] || digit).join('');
};

// Convert numbers to Arabic-Indic numerals (for Urdu)
const toUrduNumber = (num) => {
  const urduDigits = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
  return String(num).split('').map(digit => urduDigits[parseInt(digit)] || digit).join('');
};

// Get MCQ option labels based on language
const getMCQOptionLabel = (index, language) => {
  if (language === 'marathi' || language === 'hindi') {
    // Devanagari: अ, ब, क, ड
    const devanagariOptions = ['अ', 'ब', 'क', 'ड'];
    return devanagariOptions[index] || String.fromCharCode(2309 + index); // Unicode for Devanagari letters
  } else if (language === 'urdu') {
    // Urdu: الف, ب, ج, د
    const urduOptions = ['الف', 'ب', 'ج', 'د'];
    return urduOptions[index] || urduOptions[0];
  } else {
    // English: A, B, C, D
    return String.fromCharCode(65 + index);
  }
};

// Format number based on language
const formatNumber = (num, language) => {
  if (language === 'marathi' || language === 'hindi') {
    return toDevanagariNumber(num);
  } else if (language === 'urdu') {
    return toUrduNumber(num);
  } else {
    return String(num);
  }
};

// Format main question number based on language
const formatMainQuestionNumber = (questionNum, language) => {
  const num = parseInt(questionNum.replace(/[^\d]/g, '')) || 1;
  
  if (language === 'marathi') {
    return `प्र.${toDevanagariNumber(num)}`; // प्र. = प्रश्न (Question)
  } else if (language === 'hindi') {
    return `प्र.${toDevanagariNumber(num)}`; // प्र. = प्रश्न (Question)
  } else if (language === 'urdu') {
    return `س${toUrduNumber(num)}`; // س = سوال (Question)
  } else {
    return `Q${num}`;
  }
};

// Localized labels
const getLocalizedLabels = (language) => {
  const labels = {
    english: {
      totalMarks: 'Total Marks',
      examiner: 'Examiner',
      instructions: 'INSTRUCTIONS',
      marks: 'marks',
      selectCorrectAlternative: 'Select the correct alternative:',
      answerFollowing: 'Answer the following:',
      subQuestionFormat: 'letter' // a, b, c
    },
    marathi: {
      totalMarks: 'एकूण गुण',
      examiner: 'परीक्षक',
      instructions: 'सूचना',
      marks: 'गुण',
      selectCorrectAlternative: 'योग्य पर्याय निवडा:',
      answerFollowing: 'खालील प्रश्नांची उत्तरे द्या:',
      subQuestionFormat: 'letter' // अ, ब, क, ड
    },
    hindi: {
      totalMarks: 'कुल अंक',
      examiner: 'परीक्षक',
      instructions: 'निर्देश',
      marks: 'अंक',
      selectCorrectAlternative: 'सही विकल्प चुनें:',
      answerFollowing: 'निम्नलिखित प्रश्नों के उत्तर दें:',
      subQuestionFormat: 'number' // 1, 2, 3
    },
    urdu: {
      totalMarks: 'کل نمبر',
      examiner: 'ممتحن',
      instructions: 'ہدایات',
      marks: 'نمبر',
      selectCorrectAlternative: 'صحیح متبادل منتخب کریں:',
      answerFollowing: 'مندرجہ ذیل کے جوابات دیں:',
      subQuestionFormat: 'number' // 1, 2, 3
    }
  };
  return labels[language] || labels.english;
};

// The updated route
router.get('/moderator/paper/:paperId/download-pdf', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { paperId } = req.params;
    // Get paper details
    const [papers] = await db.query(
      `SELECT qp.paper_id, qp.paper_title, qp.total_marks, qp.status,
              u.name as examiner_name, s.subject_name
       FROM question_papers qp
       JOIN users u ON qp.generated_by = u.user_id
       LEFT JOIN subjects s ON u.subject_id = s.subject_id
       WHERE qp.paper_id = ?`,
      [paperId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found' });
    }

    const paper = papers[0];

    // Get all questions with grouping info
    const [questions] = await db.query(
      `SELECT q.question_id, q.question_text, q.question_type, q.marks,
              q.options, q.correct_answer, pq.question_order,
              pq.main_question_number, pq.sub_question_number
       FROM questions q
       JOIN paper_questions pq ON q.question_id = pq.question_id
       WHERE pq.paper_id = ?
       ORDER BY pq.question_order`,
      [paperId]
    );

    // Parse options (if stored as JSON string)
    questions.forEach(q => {
      if (q.options && typeof q.options === 'string') {
        try { q.options = JSON.parse(q.options); } catch (e) { q.options = null; }
      }
    });

    // Detect paper language and get localized labels
    const paperLanguage = detectPaperLanguage(paper, questions);
    const labels = getLocalizedLabels(paperLanguage);
    console.log(`📝 Detected paper language: ${paperLanguage}`);

    // Create PDF
    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });

    // Fonts - adjust paths as needed; ensure these files exist in your project.
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

    // Helper to choose font based on language (Hindi/Marathi use Devanagari)
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

    // Response headers
    res.setHeader('Content-Type', 'application/pdf');
    const safeTitle = (paper.paper_title || 'paper').replace(/[^a-z0-9]/gi, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.pdf"`);

    doc.pipe(res);

    // ===== HEADER =====
    const collegeName = paper.college_name || '';
    const title = paper.paper_title || '';
    const hasUrduInCollege = containsArabic(collegeName);
    const hasUrduInTitle = containsArabic(title);

    detectLanguageAndSetFont(collegeName, 18, true);
    const printedCollege = hasUrduInCollege ? processArabicForPdf(collegeName) : collegeName;
    doc.text(printedCollege, { align: hasUrduInCollege ? 'right' : 'center' });
    doc.moveDown(0.3);

    detectLanguageAndSetFont(title, 14, true);
    const printedTitle = hasUrduInTitle ? processArabicForPdf(title) : title;
    doc.text(printedTitle, { align: hasUrduInTitle ? 'right' : 'center' });
    doc.moveDown(0.8);

    doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
    doc.moveDown(0.8);

    // Paper Details - Total Marks (left) and Examiner (right)
    const detailsY = doc.y;
    const pageWidth = doc.page.width; // A4 width is 595.28 points

    // Total Marks on the LEFT
    const totalMarksText = `${labels.totalMarks}: ${formatNumber(paper.total_marks, paperLanguage)}`;
    detectLanguageAndSetFont(totalMarksText, 10);
    doc.text(totalMarksText, 50, detailsY);

    // Examiner on the RIGHT - use absolute positioning
    const examinerText = `${labels.examiner}: ${paper.examiner_name || ''}`;
    detectLanguageAndSetFont(examinerText, 10);
    // Position at 350 from left (roughly right side of page)
    doc.text(examinerText, 350, detailsY);

    doc.moveDown(1);

    // Instructions
    doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
    doc.moveDown(0.5);
    detectLanguageAndSetFont(labels.instructions, 11, true);
    doc.text(`${labels.instructions}:`, 50);
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica');
    doc.text('1. Answer all questions.', 60);
    doc.text('2. Write your answers in the space provided or on separate answer sheets.', 60);
    doc.text('3. For multiple choice questions, select the most appropriate answer.', 60);
    doc.text('4. Marks are indicated in brackets for each question.', 60);
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
    doc.moveDown(1.5);

    // ===== DETECT IF QUESTIONS HAVE SUB-QUESTIONS OR ARE STANDALONE =====
    const hasSubQuestions = questions.some(q => {
      const text = q.question_text || '';
      // English pattern: Q.1.a) or Q1a)
      const englishPattern = /^Q\.?\d+\.[a-z]+\)?/i.test(text);
      // Marathi/Hindi pattern: प्र.१.अ) or similar
      const marathiPattern = /^प्र\.?[०-९१-९]+\.[अ-ह]+\)?/.test(text);
      // Check database fields
      const hasDbSubQuestions = q.main_question_number && q.sub_question_number;
      
      return englishPattern || marathiPattern || hasDbSubQuestions;
    });

    // ===== RENDER QUESTIONS =====
    if (hasSubQuestions) {
      // Questions have sub-questions - group them
      const groupedQuestions = {};

      questions.forEach((q, index) => {
        let mainQ = '';
        let subQ = '';
        let questionText = q.question_text || '';

        if (q.main_question_number) {
          mainQ = q.main_question_number;
          const subMatch = (q.sub_question_number || '').match(/^Q\.(\d+)\.(.+)$/i);
          if (subMatch) {
            subQ = subMatch[2].replace(')', '');
            const textMatch = questionText.match(/^Q\.\d+\.[a-z0-9]+\)\s*(.+)$/i);
            if (textMatch) questionText = textMatch[1];
          }
        } else {
          // Try English pattern first: Q.1.a) or Q1a)
          const englishMatch = questionText.match(/^Q\.?(\d+)\.([a-z0-9]+)\)\s*(.+)$/i);
          // Try Marathi pattern: प्र.१.अ) or similar
          const marathiMatch = questionText.match(/^प्र\.?([०-९१-९]+)\.([अ-ह]+)\)\s*(.+)$/);
          
          if (englishMatch) {
            mainQ = `Q${englishMatch[1]}`;
            subQ = englishMatch[2];
            questionText = englishMatch[3];
          } else if (marathiMatch) {
            // Convert Devanagari number to English for internal processing
            const marathiNum = marathiMatch[1];
            const englishNum = marathiNum.replace(/[०-९]/g, (match) => {
              const devanagariDigits = ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९'];
              return devanagariDigits.indexOf(match).toString();
            });
            mainQ = `Q${englishNum}`;
            subQ = marathiMatch[2]; // Keep Marathi sub-question letter
            questionText = marathiMatch[3];
          } else {
            // Fallback grouping
            mainQ = `Q${Math.floor(index / 5) + 1}`;
            subQ = String.fromCharCode(97 + (index % 5));
          }
        }

        if (!groupedQuestions[mainQ]) {
          groupedQuestions[mainQ] = { mainNumber: mainQ, subQuestions: [] };
        }
        groupedQuestions[mainQ].subQuestions.push({ ...q, subNumber: subQ, cleanText: questionText });
      });

      const mainQuestionKeys = Object.keys(groupedQuestions).sort((a, b) => {
        return parseInt(a.replace('Q', '')) - parseInt(b.replace('Q', ''));
      });

      mainQuestionKeys.forEach((mainKey, mainIndex) => {
        const mainGroup = groupedQuestions[mainKey];
      
      if (doc.y > doc.page.height - 150) doc.addPage();

      // Add spacing between main questions
      if (mainIndex > 0) doc.moveDown(1.5);

      // Determine question type for this group
      const firstQuestion = mainGroup.subQuestions[0];
      const isMCQ = firstQuestion.question_type === 'mcq';
      const isShortAnswer = firstQuestion.question_type === 'short_answer';
      const isLongAnswer = firstQuestion.question_type === 'long_answer';

      // Determine instruction based on type (use localized labels)
      let instructionText = '';
      if (isMCQ) {
        instructionText = labels.selectCorrectAlternative;
      } else if (isShortAnswer || isLongAnswer) {
        instructionText = labels.answerFollowing;
      }

      // Main question header WITH instruction on the same line
      const mainQuestionY = doc.y;
      const localizedMainQ = formatMainQuestionNumber(mainKey, paperLanguage);
      detectLanguageAndSetFont(localizedMainQ, 14, true);
      doc.text(localizedMainQ, 50, mainQuestionY, { continued: false });
      
      // Add instruction beside the main question number if available
      if (instructionText) {
        const hasUrduInInstruction = containsArabic(instructionText);
        detectLanguageAndSetFont(instructionText, 11, true);
        const printedInstruction = hasUrduInInstruction ? processArabicForPdf(instructionText) : instructionText;
        doc.text(printedInstruction, 60, mainQuestionY + 18, { align: hasUrduInInstruction ? 'right' : 'left' });
      }
      
      doc.moveDown(instructionText ? 0.8 : 0.5);

      // Sub-questions
      mainGroup.subQuestions.forEach((subQ, subIndex) => {
        if (doc.y > doc.page.height - 150) doc.addPage();

        // Sub-question number - use localized format
        let subQuestionLabel = '';
        if (paperLanguage === 'marathi' || paperLanguage === 'hindi') {
          // For Marathi/Hindi, use Devanagari letters if available, otherwise convert from English
          if (subQ.subNumber && /[अ-ह]/.test(subQ.subNumber)) {
            // Already has Devanagari letter
            subQuestionLabel = subQ.subNumber;
          } else {
            // Convert English letter to Devanagari
            const devanagariLetters = ['अ', 'ब', 'क', 'ड', 'इ', 'फ', 'ग', 'ह'];
            const englishLetter = subQ.subNumber?.replace(/[^a-z]/gi, '') || String.fromCharCode(97 + subIndex);
            const letterIndex = englishLetter.toLowerCase().charCodeAt(0) - 97;
            subQuestionLabel = devanagariLetters[letterIndex] || englishLetter;
          }
        } else if (labels.subQuestionFormat === 'number') {
          subQuestionLabel = formatNumber(subIndex + 1, paperLanguage);
        } else {
          subQuestionLabel = subQ.subNumber?.replace(/[^a-z]/gi, '') || String.fromCharCode(97 + subIndex);
        }
        
        const hasUrdu = containsArabic(subQ.cleanText);
        
        // Save current Y position
        const startY = doc.y;
        
        // Sub-question label
        doc.fontSize(11).font('Helvetica-Bold');
        doc.text(`   ${subQuestionLabel}) `, 55, startY, { continued: false });
        
        // Question text with marks at the end
        detectLanguageAndSetFont(subQ.cleanText, 11);
        const printedText = hasUrdu ? processArabicForPdf(subQ.cleanText) : subQ.cleanText;
        const marksText = `(${formatNumber(subQ.marks, paperLanguage)} ${labels.marks})`;
        
        doc.text(printedText + ' ' + marksText, 80, startY, { 
          width: doc.page.width - 140, 
          lineGap: 3, 
          align: hasUrdu ? 'right' : 'left' 
        });
        
        doc.fillColor('#000000');
        doc.moveDown(0.1);

        // MCQ options
        if (subQ.question_type === 'mcq' && subQ.options && Array.isArray(subQ.options)) {
          subQ.options.forEach((opt, optIndex) => {
            const cleanOption = (opt || '').replace(/^[A-D][\)\.]\s*/, '');
            const optionLabel = getMCQOptionLabel(optIndex, paperLanguage);
            const hasUrduOpt = containsArabic(cleanOption);

            detectLanguageAndSetFont(cleanOption, 10);
            const printedOption = hasUrduOpt ? processArabicForPdf(cleanOption) : cleanOption;

            // Save Y position for option
            const optY = doc.y;
            
            // Print option label
            doc.text(`         ${optionLabel}) `, 100, optY, { continued: false });
            
            // Print option text - second line aligns exactly under first word
            doc.text(printedOption, 140, optY, { 
              width: doc.page.width - 200, 
              lineGap: 2, 
              align: hasUrduOpt ? 'right' : 'left' 
            });
            doc.moveDown(0.1);
          });
          doc.moveDown(0.1);
        }

        // Answer space for non-MCQ (no answer lines, just blank space)
        if (subQ.question_type !== 'mcq') {
          const spaceLines = subQ.marks <= 2 ? 1 : subQ.marks <= 5 ? 2 : 3;
          for (let i = 0; i < spaceLines; i++) {
            doc.moveDown(0.3);
          }
        }

        doc.moveDown(0.1);
      });
    });
    } else {
      // Standalone questions (no sub-questions)
      questions.forEach((q, index) => {
        if (doc.y > doc.page.height - 150) doc.addPage();

        let questionText = q.question_text || '';
        let questionNumber = `Q${index + 1}`;

        // Try to extract question number from text
        const match = questionText.match(/^Q\.?(\d+)\)?[\s\)]*(.+)$/i);
        if (match) {
          questionNumber = `Q${match[1]}`;
          questionText = match[2];
        }

        if (index > 0) doc.moveDown(1.5);

        const hasUrdu = containsArabic(questionText);

        // Save current Y position
        const startY = doc.y;
        
        // Question number
        const localizedQNum = formatMainQuestionNumber(questionNumber, paperLanguage);
        detectLanguageAndSetFont(localizedQNum, 12, true);
        doc.text(localizedQNum, 55, startY);
        
        // Question text with marks at the end
        detectLanguageAndSetFont(questionText, 11);
        const printedText = hasUrdu ? processArabicForPdf(questionText) : questionText;
        const marksText = `(${formatNumber(q.marks, paperLanguage)} ${labels.marks})`;
        
        doc.text(printedText + ' ' + marksText, 80, startY, { 
          width: doc.page.width - 140, 
          lineGap: 3, 
          align: hasUrdu ? 'right' : 'left' 
        });
        
        doc.fillColor('#000000');
        doc.moveDown(0.15);

        // MCQ options
        if (q.question_type === 'mcq' && q.options && Array.isArray(q.options)) {
          q.options.forEach((opt, optIndex) => {
            const cleanOption = (opt || '').replace(/^[A-D][\)\.]\s*/, '');
            const optionLabel = getMCQOptionLabel(optIndex, paperLanguage);
            const hasUrduOpt = containsArabic(cleanOption);

            detectLanguageAndSetFont(cleanOption, 10);
            const printedOption = hasUrduOpt ? processArabicForPdf(cleanOption) : cleanOption;

            // Save Y position for option
            const optY = doc.y;
            
            // Print option label
            doc.text(`         ${optionLabel}) `, 100, optY, { continued: false });
            
            // Print option text - second line aligns exactly under first word
            doc.text(printedOption, 140, optY, { 
              width: doc.page.width - 200, 
              lineGap: 2, 
              align: hasUrduOpt ? 'right' : 'left' 
            });
            doc.moveDown(0.2);
          });
          doc.moveDown(0.2);
        }

        // Answer space for non-MCQ
        if (q.question_type !== 'mcq') {
          const spaceLines = q.marks <= 2 ? 1 : q.marks <= 5 ? 2 : 3;
          for (let i = 0; i < spaceLines; i++) {
            doc.moveDown(0.5);
          }
        }

        doc.moveDown(0.2);
      });
    }

    // ===== FOOTER =====
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.moveTo(50, doc.page.height - 60).lineTo(doc.page.width - 50, doc.page.height - 60).stroke();

      const footerTitle = containsArabic(paper.paper_title) ? processArabicForPdf(paper.paper_title) : (paper.paper_title || '');
      doc.fontSize(8).fillColor('#666666').text(
        `${footerTitle} | Page ${i + 1} of ${range.count}`,
        50,
        doc.page.height - 45,
        { align: 'center', width: doc.page.width - 100 }
      );

      doc.fontSize(7).text(
        `Generated on ${new Date().toLocaleString()}`,
        50,
        doc.page.height - 30,
        { align: 'center', width: doc.page.width - 100 }
      );
      doc.fillColor('#000000');
    }

    doc.end();

  } catch (err) {
    console.error('PDF download error:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Failed to generate PDF' });
    }
  }
});


// Moderator: Get the 3 categorized papers created from original paper
router.get('/moderator/paper/:paperId/categorized-papers', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { paperId } = req.params;
    // Get original paper
    const [originalPapers] = await db.query(
      `SELECT qp.paper_id, qp.paper_title, qp.status
       FROM question_papers qp
       WHERE qp.paper_id = ?`,
      [paperId]
    );

    if (originalPapers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found' });
    }

    const originalPaper = originalPapers[0];

    // Get the 3 categorized papers (they have the original title + category suffix)
    const [categorizedPapers] = await db.query(
      `SELECT qp.paper_id, qp.paper_title, qp.total_marks, qp.status, qp.created_at,
              (SELECT COUNT(*) FROM paper_questions WHERE paper_id = qp.paper_id) as question_count
       FROM question_papers qp
       WHERE 1=1 
         AND qp.generated_by = (SELECT generated_by FROM question_papers WHERE paper_id = ?)
         AND qp.paper_title LIKE ?
         AND qp.paper_id != ?
       ORDER BY qp.paper_title`,
      [collegeId, paperId, `${originalPaper.paper_title} -%`, paperId]
    );

    res.json({
      success: true,
      original_paper: originalPaper,
      categorized_papers: categorizedPapers
    });
  } catch (err) {
    console.error('Get categorized papers error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Moderator: Get paper preview with questions for editing
router.get('/moderator/paper/:paperId/preview', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { paperId } = req.params;
    // First, check if this is a set_id (from paper_sets table)
    const [sets] = await db.query(
      `SELECT ps.set_id, ps.base_paper_id, ps.set_number, ps.category,
              qp.paper_title, qp.total_marks,
              u.name as examiner_name, s.subject_name
       FROM paper_sets ps
       JOIN question_papers qp ON ps.base_paper_id = qp.paper_id
       JOIN users u ON qp.generated_by = u.user_id
       LEFT JOIN subjects s ON u.subject_id = s.subject_id
       WHERE ps.set_id = ?`,
      [paperId]
    );

    if (sets.length > 0) {
      // This is a set, get questions from set_questions + question_variations
      const setInfo = sets[0];
      
      const [questions] = await db.query(
        `SELECT sq.question_order, sq.main_question_number, sq.sub_question_number,
                qv.variation_id as question_id, qv.question_text, qv.question_type, 
                qv.marks, qv.options, qv.correct_answer,
                LENGTH(qv.question_text) as text_length
         FROM set_questions sq
         JOIN question_variations qv ON sq.variation_id = qv.variation_id
         WHERE sq.set_id = ?
         ORDER BY sq.question_order`,
        [paperId]
      );

      console.log(`🔍 Raw questions from set ${paperId}:`, questions.map(q => ({
        id: q.question_id,
        has_text: !!q.question_text,
        text_length: q.text_length,
        main_q: q.main_question_number,
        text_preview: q.question_text ? q.question_text.substring(0, 50) : 'NULL'
      })));

      // Parse options
      questions.forEach(q => {
        if (q.options && typeof q.options === 'string') {
          try { q.options = JSON.parse(q.options); } catch (e) { q.options = null; }
        }
      });

      // Group questions by main_question_number
      const groupedQuestions = [];
      const questionGroups = {};
      
      questions.forEach(q => {
        if (q.main_question_number) {
          if (!questionGroups[q.main_question_number]) {
            questionGroups[q.main_question_number] = {
              main_question_number: q.main_question_number,
              sub_questions: []
            };
          }
          questionGroups[q.main_question_number].sub_questions.push({
            question_id: q.question_id,
            question_text: q.question_text,
            question_type: q.question_type,
            marks: q.marks,
            options: q.options,
            correct_answer: q.correct_answer,
            sub_question_number: q.sub_question_number
          });
        } else {
          groupedQuestions.push(q);
        }
      });

      // Add grouped questions
      Object.keys(questionGroups).sort().forEach(mainQ => {
        groupedQuestions.push(questionGroups[mainQ]);
      });

      const paper = {
        paper_id: setInfo.set_id,
        paper_title: `${setInfo.paper_title} - Set ${setInfo.set_number}`,
        total_marks: setInfo.total_marks,
        status: 'approved',
        examiner_name: setInfo.examiner_name,
        college_name: setInfo.college_name,
        questions: groupedQuestions
      };

      console.log(`📄 Preview for set ${paperId}: ${groupedQuestions.length} main questions, ${questions.length} total sub-questions`);

      return res.json({ success: true, paper });
    }

    // If not a set, try regular paper
    const [papers] = await db.query(
      `SELECT qp.paper_id, qp.paper_title, qp.total_marks, qp.status,
              u.name as examiner_name, s.subject_name
       FROM question_papers qp
       JOIN users u ON qp.generated_by = u.user_id
       LEFT JOIN subjects s ON u.subject_id = s.subject_id
       WHERE qp.paper_id = ?`,
      [paperId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found' });
    }

    const paper = papers[0];

    // Get all questions for this paper with grouping info
    const [questions] = await db.query(
      `SELECT q.question_id, q.question_text, q.question_type, q.marks,
              q.options, q.correct_answer, pq.question_order,
              pq.main_question_number, pq.sub_question_number,
              LENGTH(q.question_text) as text_length
       FROM questions q
       JOIN paper_questions pq ON q.question_id = pq.question_id
       WHERE pq.paper_id = ?
       ORDER BY pq.question_order`,
      [paperId]
    );
    
    // Debug: Check if questions have text
    console.log(`🔍 Raw questions from DB for paper ${paperId}:`, questions.map(q => ({
      id: q.question_id,
      has_text: !!q.question_text,
      text_length: q.text_length,
      main_q: q.main_question_number,
      text_preview: q.question_text ? q.question_text.substring(0, 50) : 'NULL'
    })));

    // Parse options (if stored as JSON string)
    questions.forEach(q => {
      if (q.options && typeof q.options === 'string') {
        try { q.options = JSON.parse(q.options); } catch (e) { q.options = null; }
      }
    });

    // Group questions by main_question_number if available
    const groupedQuestions = [];
    const questionGroups = {};
    
    questions.forEach(q => {
      if (q.main_question_number) {
        if (!questionGroups[q.main_question_number]) {
          questionGroups[q.main_question_number] = {
            main_question_number: q.main_question_number,
            sub_questions: []
          };
        }
        questionGroups[q.main_question_number].sub_questions.push({
          question_id: q.question_id,
          question_text: q.question_text,
          question_type: q.question_type,
          marks: q.marks,
          options: q.options,
          correct_answer: q.correct_answer,
          sub_question_number: q.sub_question_number
        });
      } else {
        // Flat question without grouping
        groupedQuestions.push(q);
      }
    });

    // Add grouped questions
    Object.keys(questionGroups).sort().forEach(mainQ => {
      groupedQuestions.push(questionGroups[mainQ]);
    });

    paper.questions = groupedQuestions;

    console.log(`📄 Preview for paper ${paperId}: ${groupedQuestions.length} main questions, ${questions.length} total sub-questions`);

    res.json({ success: true, paper });
  } catch (err) {
    console.error('Get paper preview error:', err);
    res.status(500).json({ success: false, message: 'Failed to load paper preview' });
  }
});

// Moderator: Download categorized paper as PDF with custom edits
router.post('/moderator/paper/:paperId/download-pdf-custom', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { paperId } = req.params;
    const { header, instructions, footer, questions } = req.body;
    // Get paper details
    const [papers] = await db.query(
      `SELECT qp.paper_id, qp.paper_title, qp.total_marks, qp.status,
 u.name as examiner_name, s.subject_name
FROM question_papers qp
JOIN users u ON qp.generated_by = u.user_id
WHERE qp.paper_id = ?`,
      [paperId]
    );

    if (papers.length === 0) {
      return res.status(404).json({ success: false, message: 'Paper not found' });
    }

    const paper = papers[0];

    // Detect paper language and get localized labels
    const paperLanguage = detectPaperLanguage(paper, questions);
    const labels = getLocalizedLabels(paperLanguage);
    console.log(`📝 Custom PDF - Detected paper language: ${paperLanguage}`);

    // Create PDF with custom content
    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });

    // Fonts
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

    res.setHeader('Content-Type', 'application/pdf');
    const safeTitle = (paper.paper_title || 'paper').replace(/[^a-z0-9]/gi, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.pdf"`);

    doc.pipe(res);

    const pageWidth = doc.page.width;
    const leftMargin = 50;
    const rightMargin = pageWidth - 50;
    const detailFontSize = 10;
    const detailFont = 'Helvetica';

    // Header Section
    if (header) {
      const headerLines = header.split('\n');
      headerLines.forEach(line => {
        const hasUrdu = containsArabic(line);
        detectLanguageAndSetFont(line, 14, true);
        const printedLine = hasUrdu ? processArabicForPdf(line) : line;
        doc.text(printedLine, { align: hasUrdu ? 'right' : 'center' });
      });
      doc.moveDown(0.5);
    }

    const detailsY = doc.y;

    const totalMarksText = `${labels.totalMarks}: ${formatNumber(paper.total_marks, paperLanguage)}`;
    detectLanguageAndSetFont(totalMarksText, detailFontSize);
    doc.text(totalMarksText, leftMargin, detailsY);

    const examinerText = `${labels.examiner}: ${paper.examiner_name || ''}`;
    detectLanguageAndSetFont(examinerText, detailFontSize);
    doc.text(examinerText, leftMargin, detailsY, {
      align: 'right',
      width: rightMargin - leftMargin,
      lineBreak: false
    });

    doc.moveDown(1);

    doc.moveTo(leftMargin, doc.y).lineTo(rightMargin, doc.y).stroke();
    doc.moveDown(1);

    // Instructions Section
    const instructionsText = instructions || 'Instructions:\n1. Answer all questions.\n2. All questions carry equal marks.\n3. Write clearly and legibly.';
    const instructionLines = String(instructionsText).split('\n');

    instructionLines.forEach((line, index) => {
      if (line.trim().length > 0) {
        const hasUrdu = containsArabic(line);
        const isHeading = line.trim().toLowerCase().startsWith('instructions') ||
          line.trim().startsWith('निर्देश') ||
          line.trim().startsWith('تعليمات');

        detectLanguageAndSetFont(line, isHeading ? 11 : 10, isHeading);
        const printedLine = hasUrdu ? processArabicForPdf(line) : line;
        doc.text(printedLine, { align: hasUrdu ? 'right' : 'left' });
      } else {
        doc.moveDown(0.3);
      }
    });

    doc.moveDown(0.5);
    doc.moveTo(leftMargin, doc.y).lineTo(rightMargin, doc.y).stroke();
    doc.moveDown(1.5);

    // ===== DETECT IF QUESTIONS HAVE SUB-QUESTIONS OR ARE STANDALONE =====
    const hasGroupedQuestions = questions.some(q => q.is_grouped === true);

    // ===== RENDER QUESTIONS =====
    if (hasGroupedQuestions) {
      // Questions have sub-questions - render grouped
      let mainQuestionIndex = 0;

      questions.forEach((q, index) => {
        if (q.is_grouped && q.sub_questions && q.sub_questions.length > 0) {
          mainQuestionIndex++;
          const mainKey = q.main_question_number || `Q${mainQuestionIndex}`;
          
          if (doc.y > doc.page.height - 150) doc.addPage();
          if (mainQuestionIndex > 1) doc.moveDown(1.5);

          // Determine question type for this group
          const firstQuestion = q.sub_questions[0];
          const isMCQ = firstQuestion.question_type === 'mcq';
          const isShortAnswer = firstQuestion.question_type === 'short_answer';
          const isLongAnswer = firstQuestion.question_type === 'long_answer';

          // Use custom instruction if provided, otherwise use localized default based on type
          let instructionText = q.instruction;
          if (!instructionText) {
            if (isMCQ) {
              instructionText = labels.selectCorrectAlternative;
            } else if (isShortAnswer || isLongAnswer) {
              instructionText = labels.answerFollowing;
            }
          }

          // Main question header - use localized format
          const mainQuestionY = doc.y;
          const localizedMainQ = formatMainQuestionNumber(mainKey, paperLanguage);
          detectLanguageAndSetFont(localizedMainQ, 14, true);
          doc.text(localizedMainQ, leftMargin, mainQuestionY, { continued: false });
          doc.moveDown(0.8);
          
          // Add instruction below the main question number if available
          if (instructionText) {
            const hasUrduInInstruction = containsArabic(instructionText);
            detectLanguageAndSetFont(instructionText, 11, true);
            const printedInstruction = hasUrduInInstruction ? processArabicForPdf(instructionText) : instructionText;
            doc.text(printedInstruction, leftMargin + 10, doc.y, { align: hasUrduInInstruction ? 'right' : 'left' });
            doc.moveDown(0.5);
          }

          // Sub-questions
          q.sub_questions.forEach((subQ, subIndex) => {
            if (doc.y > doc.page.height - 150) doc.addPage();

            // Sub-question number - use localized format
            let subQuestionLabel = '';
            if (paperLanguage === 'marathi' || paperLanguage === 'hindi') {
              // For Marathi/Hindi, use Devanagari letters if available, otherwise convert from English
              if (subQ.sub_question_number && /[अ-ह]/.test(subQ.sub_question_number)) {
                // Already has Devanagari letter
                const match = subQ.sub_question_number.match(/[अ-ह]+/);
                subQuestionLabel = match ? match[0] : String.fromCharCode(97 + subIndex);
              } else {
                // Convert English letter to Devanagari
                const devanagariLetters = ['अ', 'ब', 'क', 'ड', 'इ', 'फ', 'ग', 'ह'];
                let englishLetter = String.fromCharCode(97 + subIndex);
                if (subQ.sub_question_number) {
                  const match = subQ.sub_question_number.match(/[a-z]+/i);
                  if (match) englishLetter = match[0];
                }
                const letterIndex = englishLetter.toLowerCase().charCodeAt(0) - 97;
                subQuestionLabel = devanagariLetters[letterIndex] || englishLetter;
              }
            } else if (labels.subQuestionFormat === 'number') {
              subQuestionLabel = formatNumber(subIndex + 1, paperLanguage);
            } else {
              subQuestionLabel = String.fromCharCode(97 + subIndex);
              if (subQ.sub_question_number) {
                const match = subQ.sub_question_number.match(/[a-z]+/i);
                if (match) subQuestionLabel = match[0];
              }
            }

            const hasUrdu = containsArabic(subQ.question_text);
            
            // Save current Y position
            const subStartY = doc.y;
            
            // Sub-question label
            doc.fontSize(11).font('Helvetica-Bold');
            doc.text(`   ${subQuestionLabel}) `, leftMargin + 5, subStartY, { continued: false });
            
            // Question text with marks at the end
            detectLanguageAndSetFont(subQ.question_text, 11);
            const printedText = hasUrdu ? processArabicForPdf(subQ.question_text) : subQ.question_text;
            const marksText = `(${formatNumber(subQ.marks, paperLanguage)} ${labels.marks})`;
            
            doc.text(printedText + ' ' + marksText, leftMargin + 30, subStartY, { 
              width: rightMargin - leftMargin - 40, 
              lineGap: 3, 
              align: hasUrdu ? 'right' : 'left' 
            });
            
            doc.fillColor('#000000');
            doc.moveDown(0.1);

            // MCQ options
            if (subQ.question_type === 'mcq' && subQ.options && Array.isArray(subQ.options)) {
              subQ.options.forEach((opt, optIndex) => {
                const cleanOption = (opt || '').replace(/^[A-D][\)\.]\s*/, '');
                const optionLabel = getMCQOptionLabel(optIndex, paperLanguage);
                const hasUrduOpt = containsArabic(cleanOption);

                detectLanguageAndSetFont(cleanOption, 10);
                const printedOption = hasUrduOpt ? processArabicForPdf(cleanOption) : cleanOption;

                // Save Y position for option
                const optY = doc.y;
                
                // Print option label
                doc.text(`         ${optionLabel}) `, leftMargin + 50, optY, { continued: false });
                
                // Print option text - second line aligns exactly under first word
                doc.text(printedOption, leftMargin + 90, optY, { 
                  width: rightMargin - leftMargin - 100, 
                  lineGap: 2, 
                  align: hasUrduOpt ? 'right' : 'left' 
                });
                doc.moveDown(0.1);
              });
              doc.moveDown(0.1);
            }

            // Answer space for non-MCQ
            if (subQ.question_type !== 'mcq') {
              const spaceLines = subQ.marks <= 2 ? 1 : subQ.marks <= 5 ? 2 : 3;
              for (let i = 0; i < spaceLines; i++) {
                doc.moveDown(0.3);
              }
            }

            doc.moveDown(0.1);
          });
        }
      });
    } else {
      // Standalone questions (no sub-questions)
      questions.forEach((q, index) => {
        if (doc.y > doc.page.height - 150) doc.addPage();

        let questionText = q.question_text || '';
        let questionNumber = `Q${index + 1}`;

        const match = questionText.match(/^Q\.?(\d+)\)?[\s\)]*(.+)$/i);
        if (match) {
          questionNumber = `Q${match[1]}`;
          questionText = match[2];
        }

        if (index > 0) doc.moveDown(1.5);

        const hasUrdu = containsArabic(questionText);

        // Save current Y position
        const qStartY = doc.y;
        
        // Question number
        const localizedQNum = formatMainQuestionNumber(questionNumber, paperLanguage);
        detectLanguageAndSetFont(localizedQNum, 12, true);
        doc.text(localizedQNum, leftMargin + 5, qStartY);
        
        // Question text with marks at the end
        detectLanguageAndSetFont(questionText, 11);
        const printedText = hasUrdu ? processArabicForPdf(questionText) : questionText;
        const marksText = `(${formatNumber(q.marks, paperLanguage)} ${labels.marks})`;
        
        doc.text(printedText + ' ' + marksText, leftMargin + 30, qStartY, { 
          width: rightMargin - leftMargin - 40, 
          lineGap: 3, 
          align: hasUrdu ? 'right' : 'left' 
        });
        
        doc.fillColor('#000000');
        doc.moveDown(0.15);

        // MCQ options
        if (q.question_type === 'mcq' && q.options && Array.isArray(q.options)) {
          q.options.forEach((opt, optIndex) => {
            const cleanOption = (opt || '').replace(/^[A-D][\)\.]\s*/, '');
            const optionLabel = getMCQOptionLabel(optIndex, paperLanguage);
            const hasUrduOpt = containsArabic(cleanOption);

            detectLanguageAndSetFont(cleanOption, 10);
            const printedOption = hasUrduOpt ? processArabicForPdf(cleanOption) : cleanOption;

            // Save Y position for option
            const optY = doc.y;
            
            // Print option label
            doc.text(`         ${optionLabel}) `, leftMargin + 50, optY, { continued: false });
            
            // Print option text - second line aligns exactly under first word
            doc.text(printedOption, leftMargin + 90, optY, { 
              width: rightMargin - leftMargin - 100, 
              lineGap: 2, 
              align: hasUrduOpt ? 'right' : 'left' 
            });
            doc.moveDown(0.2);
          });
          doc.moveDown(0.2);
        }

        // Answer space for non-MCQ
        if (q.question_type !== 'mcq') {
          const spaceLines = q.marks <= 2 ? 1 : q.marks <= 5 ? 2 : 3;
          for (let i = 0; i < spaceLines; i++) {
            doc.moveDown(0.5);
          }
        }

        doc.moveDown(0.2);
      });
    }

    if (footer) {
      doc.moveDown(2);
      doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.page.height - 60).stroke();
      doc.moveDown(0.5);
      const footerLines = footer.split('\n');
      footerLines.forEach(line => {
        const hasUrdu = containsArabic(line);
        detectLanguageAndSetFont(line, 10);
        const printedLine = hasUrdu ? processArabicForPdf(line) : line;
        doc.text(printedLine, { align: hasUrdu ? 'right' : 'center' });
      });
    }

    doc.end();

  } catch (err) {
    console.error('Download custom PDF error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate PDF' });
  }
});

// Moderator: Download paper with AI-enhanced formatting using Gemini
router.post('/moderator/paper/:paperId/download-pdf-ai', authMiddleware, requireRole('moderator'), async (req, res) => {
  try {
    const { paperId } = req.params;
    const { header, instructions, footer, questions, password } = req.body;
    console.log('🤖 Starting AI-enhanced PDF generation for ID:', paperId);
    console.log('🔒 Password encryption:', password ? 'Enabled' : 'Disabled');

    // First, check if this is a set_id (from paper_sets table)
    const [sets] = await db.query(
      `SELECT ps.set_id, ps.base_paper_id, ps.set_number, ps.category,
              qp.paper_title, qp.total_marks,
              u.name as examiner_name, s.subject_name
       FROM paper_sets ps
       JOIN question_papers qp ON ps.base_paper_id = qp.paper_id
       JOIN users u ON qp.generated_by = u.user_id
       LEFT JOIN subjects s ON u.subject_id = s.subject_id
       WHERE ps.set_id = ?`,
      [paperId]
    );

    let paper;
    if (sets.length > 0) {
      // This is a set
      console.log('✅ Found set:', sets[0].set_number);
      paper = {
        paper_id: sets[0].set_id,
        paper_title: `${sets[0].paper_title} - Set ${sets[0].set_number}`,
        total_marks: sets[0].total_marks,
        examiner_name: sets[0].examiner_name,
        college_name: sets[0].college_name
      };
    } else {
      // Try regular paper
      const [papers] = await db.query(
        `SELECT qp.paper_id, qp.paper_title, qp.total_marks, qp.status,
                u.name as examiner_name, s.subject_name
         FROM question_papers qp
         JOIN users u ON qp.generated_by = u.user_id
         LEFT JOIN subjects s ON u.subject_id = s.subject_id
         WHERE qp.paper_id = ?`,
        [paperId]
      );

      if (papers.length === 0) {
        console.log('❌ Paper/Set not found for ID:', paperId);
        return res.status(404).json({ success: false, message: 'Paper or Set not found' });
      }

      console.log('✅ Found regular paper:', papers[0].paper_title);
      paper = papers[0];
    }

    // Prepare data for Gemini
    const paperData = {
      header: header || `${paper.college_name}\n${paper.paper_title}`,
      instructions: instructions || 'Instructions:\n1. Answer all questions.\n2. All questions carry equal marks.\n3. Write clearly and legibly.',
      footer: footer || 'End of Paper',
      examiner: paper.examiner_name,
      totalMarks: paper.total_marks,
      questions: questions
    };

    // Create prompt for Gemini to generate formatted paper structure
    const geminiPrompt = `You are an expert in creating professional examination question papers for Indian educational institutions.

Analyze this question paper and create a perfectly formatted structure following Indian examination conventions.

Paper Data:
${JSON.stringify(paperData, null, 2)}

CRITICAL INSTRUCTIONS:

1. LANGUAGE DETECTION: Detect the primary language from question text

2. FOR HINDI PAPERS:
   - Main questions: प्र.१, प्र.२, प्र.३ (use Devanagari numbers)
   - Sub-questions: अ), ब), क), ड) (Devanagari letters)
   - MCQ options: अ) option1, ब) option2, क) option3, ड) option4 (Devanagari letters)
   - Marks: (३ अंक)
   - MCQ instruction: "सही विकल्प चुनिए:"
   - Descriptive instruction: "निम्नलिखित प्रश्नों के उत्तर दीजिए:"
   - Long answer instruction: "विस्तार से उत्तर दीजिए:"

3. FOR ENGLISH PAPERS:
   - Main questions: Q.1, Q.2, Q.3
   - Sub-questions: 1), 2), 3), 4)
   - MCQ options: A) option1, B) option2, C) option3, D) option4
   - Marks: (3 marks)
   - MCQ instruction: "Select the correct alternative:"
   - Descriptive instruction: "Answer the following questions:"
   - Long answer instruction: "Answer in detail:"

4. FOR MARATHI PAPERS:
   - Main questions: प्र.१, प्र.२, प्र.३
   - Sub-questions: अ), ब), क), ड)
   - MCQ options: अ) option1, ब) option2, क) option3, ड) option4 (Devanagari letters)
   - Marks: (३ गुण)
   - MCQ instruction: "योग्य पर्याय निवडा:"
   - Descriptive instruction: "खालील प्रश्नांची उत्तरे द्या:"
   - Long answer instruction: "तपशीलवार उत्तर द्या:"

5. FOR URDU PAPERS:
   - Main questions: 1., 2., 3.
   - Sub-questions: 1), 2), 3)
   - MCQ options: A) option1, B) option2, C) option3, D) option4
   - Marks: (3 marks)
   - **IMPORTANT**: Instructions format:
   - General Instructions (header section): IN ENGLISH
     - Title: "Instructions:" (English)
     - Points: "1. Answer all questions.", "2. Write clearly and legibly." (English)
   - Question-specific instructions (beside main questions): IN URDU
     - MCQ instruction: "صحیح جواب منتخب کریں:"
     - Descriptive instruction: "مندرجہ ذیل سوالات کے جوابات دیں:"
     - Long answer instruction: "تفصیل سے جواب دیں:"

IMPORTANT RULES:
- Analyze EACH question group separately
- If a group has MCQ questions, use MCQ instruction
- If a group has short_answer questions, use descriptive instruction  
- If a group has long_answer questions, use long answer instruction
- Use actual question numbers from data (Q1→प्र.१, Q2→प्र.२, Q5→प्र.५)
- Preserve ALL question text and options EXACTLY as provided
- Convert option labels to match language (A,B,C,D → अ,ब,क,ड for Hindi/Marathi)

Return ONLY this JSON structure (no markdown):
{
  "language": "hindi",
  "paperStructure": {
    "header": {
      "collegeName": "from data",
      "paperTitle": "from data",
      "additionalInfo": "समय: ३ घंटे | कुल अंक: १००"
    },
    "instructions": {
      "title": "सूचना:",
      "points": ["१. सभी प्रश्न अनिवार्य हैं।", "२. स्पष्ट लिखें।"]
    },
    "questions": [
      {
        "mainNumber": "प्र.१",
        "instruction": "सही विकल्प चुनिए:",
        "subQuestions": [
          {
            "number": "अ)",
            "text": "question text from data",
            "marks": 1,
            "type": "mcq",
            "options": ["अ) option1", "ब) option2", "क) option3", "ड) option4"]
          }
        ]
      },
      {
        "mainNumber": "प्र.२",
        "instruction": "निम्नलिखित प्रश्नों के उत्तर दीजिए:",
        "subQuestions": [
          {
            "number": "अ)",
            "text": "question text from data",
            "marks": 3,
            "type": "short_answer",
            "options": null
          }
        ]
      }
    ],
    "footer": {
      "pageNumberFormat": "पृष्ठ {page} / {total}"
    }
  },
  "formatting": {
    "marksFormat": "({marks} अंक)"
  }
}`;

    console.log('📤 Sending request to Gemini AI...');
    
    // Call Gemini API
    const geminiResponse = await callGeminiAPI(geminiPrompt);
    
    console.log('📥 Received response from Gemini AI');
    console.log('Response length:', geminiResponse.length);
    
    // Parse Gemini response
    let aiStructure;
    try {
      // Remove markdown code blocks if present
      let cleanedResponse = geminiResponse.trim();
      if (cleanedResponse.startsWith('```json')) {
        cleanedResponse = cleanedResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      } else if (cleanedResponse.startsWith('```')) {
        cleanedResponse = cleanedResponse.replace(/```\n?/g, '');
      }
      
      aiStructure = JSON.parse(cleanedResponse);
      console.log('✅ Successfully parsed AI response');
      console.log('AI detected language:', aiStructure.language);
      console.log('Questions count:', aiStructure.paperStructure?.questions?.length || 0);
    } catch (parseError) {
      console.error('❌ Failed to parse Gemini response:', parseError);
      console.log('Raw response (first 1000 chars):', geminiResponse.substring(0, 1000));
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to parse AI response',
        details: parseError.message,
        rawResponse: geminiResponse.substring(0, 500)
      });
    }
    
    // Add default formatting if not provided by AI
    if (!aiStructure.formatting) {
      aiStructure.formatting = {
        questionNumberStyle: 'Q.1, Q.2',
        subQuestionStyle: 'a), b), c)',
        mcqOptionStyle: 'A), B), C), D)',
        marksFormat: '({marks} marks)'
      };
      console.log('⚠️  Added default formatting structure');
    }

    // Generate PDF using AI structure with optional encryption
    const pdfOptions = { 
      margin: 50, 
      size: 'A4', 
      bufferPages: true
    };
    
    // Add encryption if password is provided
    if (password && password.trim()) {
      pdfOptions.userPassword = password.trim();
      pdfOptions.ownerPassword = password.trim();
      pdfOptions.permissions = {
        printing: 'highResolution',
        modifying: false,
        copying: false,
        annotating: false,
        fillingForms: false,
        contentAccessibility: true,
        documentAssembly: false
      };
      console.log('🔐 PDF encryption enabled with password');
    }
    
    const doc = new PDFDocument(pdfOptions);

    // Register fonts
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

    res.setHeader('Content-Type', 'application/pdf');
    const safeTitle = (paper.paper_title || 'paper').replace(/[^a-z0-9]/gi, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_AI.pdf"`);

    doc.pipe(res);

    const pageWidth = doc.page.width;
    const leftMargin = 50;
    const rightMargin = pageWidth - 50;

    // Render Header - Use custom header directly if provided
    if (header) {
      console.log('📝 Using custom header directly:', header);
      const headerLines = header.split('\n');
      headerLines.forEach((line, index) => {
        if (line.trim()) {
          const hasUrdu = containsArabic(line);
          const isMockTestLine = line.toLowerCase().includes('mock test');
          const fontSize = index === 0 ? 16 : isMockTestLine ? 14 : 12;
          const isBold = index === 0 || isMockTestLine;
          detectLanguageAndSetFont(line, fontSize, isBold);
          const printedText = hasUrdu ? processArabicForPdf(line) : line;
          doc.text(printedText, { align: hasUrdu ? 'right' : 'center' });
          doc.moveDown(0.3);
        }
      });
    } else if (aiStructure.paperStructure.header) {
      // Use AI-generated header structure (fallback)
      const headerData = aiStructure.paperStructure.header;
      
      if (headerData.collegeName) {
        const hasUrdu = containsArabic(headerData.collegeName);
        detectLanguageAndSetFont(headerData.collegeName, 16, true);
        const printedText = hasUrdu ? processArabicForPdf(headerData.collegeName) : headerData.collegeName;
        doc.text(printedText, { align: hasUrdu ? 'right' : 'center' });
        doc.moveDown(0.3);
      }
      
      if (headerData.paperTitle) {
        const hasUrdu = containsArabic(headerData.paperTitle);
        detectLanguageAndSetFont(headerData.paperTitle, 14, true);
        const printedText = hasUrdu ? processArabicForPdf(headerData.paperTitle) : headerData.paperTitle;
        doc.text(printedText, { align: hasUrdu ? 'right' : 'center' });
        doc.moveDown(0.3);
      }
      
      if (headerData.additionalInfo) {
        const hasUrdu = containsArabic(headerData.additionalInfo);
        detectLanguageAndSetFont(headerData.additionalInfo, 10);
        const printedText = hasUrdu ? processArabicForPdf(headerData.additionalInfo) : headerData.additionalInfo;
        doc.text(printedText, { align: hasUrdu ? 'right' : 'center' });
        doc.moveDown(0.5);
      }
    }

    doc.moveTo(leftMargin, doc.y).lineTo(rightMargin, doc.y).stroke();
    doc.moveDown(1);

    // Render Instructions - Use custom instructions directly if provided
    if (instructions) {
      console.log('📝 Using custom instructions directly');
      const instructionLines = instructions.split('\n');
      instructionLines.forEach((line, index) => {
        if (line.trim()) {
          const hasUrdu = containsArabic(line);
          const isTitle = index === 0 || line.toLowerCase().includes('instruction');
          const fontSize = isTitle ? 12 : 10;
          const isBold = isTitle;
          detectLanguageAndSetFont(line, fontSize, isBold);
          const printedText = hasUrdu ? processArabicForPdf(line) : line;
          doc.text(printedText, { align: hasUrdu ? 'right' : 'left' });
          doc.moveDown(0.3);
        }
      });
    } else if (aiStructure.paperStructure.instructions) {
      // Use AI-generated instructions structure (fallback)
      const instructionsData = aiStructure.paperStructure.instructions;
      
      if (instructionsData.title) {
        const hasUrdu = containsArabic(instructionsData.title);
        detectLanguageAndSetFont(instructionsData.title, 12, true);
        const printedText = hasUrdu ? processArabicForPdf(instructionsData.title) : instructionsData.title;
        doc.text(printedText, { align: hasUrdu ? 'right' : 'left' });
        doc.moveDown(0.5);
      }
      
      if (instructionsData.points && Array.isArray(instructionsData.points)) {
        instructionsData.points.forEach((point, index) => {
          const hasUrdu = containsArabic(point);
          detectLanguageAndSetFont(point, 10);
          const printedText = hasUrdu ? processArabicForPdf(point) : point;
          doc.text(printedText, { align: hasUrdu ? 'right' : 'left' });
          doc.moveDown(0.3);
        });
      }
    }

    doc.moveDown(0.5);
    doc.moveTo(leftMargin, doc.y).lineTo(rightMargin, doc.y).stroke();
    doc.moveDown(1.5);

    // Render Questions using AI structure
    if (aiStructure.paperStructure.questions && Array.isArray(aiStructure.paperStructure.questions)) {
      aiStructure.paperStructure.questions.forEach((question, qIndex) => {
        if (doc.y > doc.page.height - 150) doc.addPage();
        
        // Space between main questions
        if (qIndex > 0) doc.moveDown(1.8);

        // Main question number with instruction on same line
        if (question.mainNumber) {
          const hasUrdu = containsArabic(question.mainNumber);
          const hasUrduInst = question.instruction ? containsArabic(question.instruction) : false;
          const isRTL = hasUrdu || hasUrduInst;
          const currentY = doc.y;
          
          if (isRTL) {
            // RTL layout for Urdu - instruction and number on same line with minimal space
            detectLanguageAndSetFont(question.mainNumber, 14, true);
            const printedMainNum = hasUrdu ? processArabicForPdf(question.mainNumber) : question.mainNumber;
            
            if (question.instruction) {
              detectLanguageAndSetFont(question.instruction, 11, true);
              const printedInst = hasUrduInst ? processArabicForPdf(question.instruction) : question.instruction;
              
              // Combine instruction and number with minimal spacing
              const combinedText = printedInst + '     ' + printedMainNum;
              doc.text(combinedText, leftMargin, currentY, { 
                width: rightMargin - leftMargin,
                align: 'right',
                continued: false 
              });
            } else {
              doc.text(printedMainNum, rightMargin - 30, currentY, { align: 'right', continued: false });
            }
          } else {
            // LTR layout for Hindi/Marathi/English - number on left, instruction beside it
            detectLanguageAndSetFont(question.mainNumber, 14, true);
            const printedMainNum = question.mainNumber;
            doc.text(printedMainNum, leftMargin, currentY, { continued: true });
            
            if (question.instruction) {
              detectLanguageAndSetFont(question.instruction, 11, true);
              const printedInst = question.instruction;
              doc.text(`    ${printedInst}`, { continued: false });
            } else {
              doc.text('', { continued: false });
            }
          }
          
          doc.moveDown(0.1);
        }

        // Sub-questions
        if (question.subQuestions && Array.isArray(question.subQuestions)) {
          question.subQuestions.forEach((subQ, subIndex) => {
            if (doc.y > doc.page.height - 150) doc.addPage();
            
            // Add space between sub-questions
            if (subIndex > 0) doc.moveDown(0.6);

            // Sub-question number and text
            const hasUrdu = containsArabic(subQ.text);
            const hasUrduNum = containsArabic(subQ.number);
            const isRTL = hasUrdu || hasUrduNum;
            const currentY = doc.y;
            
            // Simple layout for all languages
            const subStartY = doc.y;
            const marksFormat = aiStructure.formatting?.marksFormat || '({marks} marks)';
            const marksText = subQ.marks ? marksFormat.replace('{marks}', subQ.marks) : '';
            
            detectLanguageAndSetFont(subQ.number, 11, true);
            const printedNum = hasUrduNum ? processArabicForPdf(subQ.number) : subQ.number;
            
            detectLanguageAndSetFont(subQ.text, 11);
            const printedText = hasUrdu ? processArabicForPdf(subQ.text) : subQ.text;
            
            if (isRTL) {
              // RTL: question text with number at end, prevent number from wrapping
              // Use non-breaking space or ensure they stay together
              const fullLine = printedText + '\u00A0' + printedNum;
              
              // Use smaller font to fit everything on one line
              doc.fontSize(9);
              doc.text(fullLine, leftMargin + 5, subStartY, { 
                width: rightMargin - leftMargin - 10, 
                lineGap: 0.25, 
                align: 'right' 
              });
              
              // Print marks on the left side in English
              if (marksText) {
                doc.moveDown(0.05);
                doc.font('Helvetica').fontSize(8);
                doc.text(marksText, leftMargin + 5, doc.y, { align: 'left' });
              }
            } else {
              // LTR: number on left, text beside it with marks at end
              doc.text(`   ${printedNum} `, leftMargin + 5, subStartY, { continued: false });
              doc.text(printedText + (marksText ? ' ' + marksText : ''), leftMargin + 30, subStartY, { 
                width: rightMargin - leftMargin - 40, 
                lineGap: 1, 
                align: 'left'
              });
            }
            
            doc.fillColor('#000000');
            doc.moveDown(0.02);

            // MCQ options
            if (subQ.type === 'mcq' && subQ.options && Array.isArray(subQ.options)) {
              if (isRTL) {
                // For Urdu: Display options in 2 columns (A & B on one line, C & D on next)
                for (let i = 0; i < subQ.options.length; i += 2) {
                  const optY = doc.y;
                  const pageWidth = rightMargin - leftMargin;
                  const colWidth = pageWidth / 2;
                  
                  // Right column (A or C)
                  if (subQ.options[i]) {
                    const hasUrduOpt1 = containsArabic(subQ.options[i]);
                    detectLanguageAndSetFont(subQ.options[i], 9);
                    const printedOption1 = hasUrduOpt1 ? processArabicForPdf(subQ.options[i]) : subQ.options[i];
                    
                    doc.text(printedOption1, leftMargin + colWidth + 5, optY, { 
                      width: colWidth - 10, 
                      lineGap: 0.2, 
                      align: 'right' 
                    });
                  }
                  
                  // Left column (B or D)
                  if (subQ.options[i + 1]) {
                    const hasUrduOpt2 = containsArabic(subQ.options[i + 1]);
                    detectLanguageAndSetFont(subQ.options[i + 1], 9);
                    const printedOption2 = hasUrduOpt2 ? processArabicForPdf(subQ.options[i + 1]) : subQ.options[i + 1];
                    
                    doc.text(printedOption2, leftMargin + 5, optY, { 
                      width: colWidth - 10, 
                      lineGap: 0.2, 
                      align: 'right' 
                    });
                  }
                  
                  doc.moveDown(0.3);
                }
                doc.moveDown(0.1);
              } else {
                // For LTR: Display options vertically
                subQ.options.forEach((opt, optIndex) => {
                  const hasUrduOpt = containsArabic(opt);
                  detectLanguageAndSetFont(opt, 10);
                  const printedOption = hasUrduOpt ? processArabicForPdf(opt) : opt;
                  const optY = doc.y;
                  
                  const optMatch = printedOption.match(/^([A-D][\)\.]\s*)(.+)$/);
                  if (optMatch) {
                    const optLabel = optMatch[1].trim();
                    const optText = optMatch[2];
                    
                    doc.text(`      ${optLabel} `, leftMargin + 30, optY, { continued: false });
                    doc.text(optText, leftMargin + 65, optY, { 
                      width: rightMargin - leftMargin - 75, 
                      lineGap: 0.5, 
                      align: 'left' 
                    });
                  } else {
                    doc.text(printedOption, leftMargin + 30, optY, { 
                      width: rightMargin - leftMargin - 40, 
                      lineGap: 0.5, 
                      align: 'left' 
                    });
                  }
                  
                  doc.moveDown(0.02);
                });
                doc.moveDown(0.02);
              }
            }

            // Answer space for non-MCQ
            if (subQ.type !== 'mcq') {
              const spaceLines = subQ.marks <= 2 ? 1 : subQ.marks <= 5 ? 2 : 3;
              for (let i = 0; i < spaceLines; i++) {
                doc.moveDown(0.15);
              }
            }
          });
        }
      });
    }

    // Footer
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.moveTo(50, doc.page.height - 60).lineTo(doc.page.width - 50, doc.page.height - 60).stroke();

      if (aiStructure.paperStructure.footer) {
        const footerText = aiStructure.paperStructure.footer.pageNumberFormat
          .replace('{page}', i + 1)
          .replace('{total}', range.count);
        
        doc.fontSize(8).fillColor('#666666').text(
          footerText,
          50,
          doc.page.height - 45,
          { align: 'center', width: doc.page.width - 100 }
        );
      }
      
      doc.fillColor('#000000');
    }

    doc.end();

    console.log('✅ AI-enhanced PDF generated successfully');

  } catch (err) {
    console.error('❌ AI PDF generation error:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to generate AI-enhanced PDF',
      error: err.message 
    });
  }
});

// Examiner: Delete paper (only if status is draft and no variations sent to SME)
router.delete('/papers/:paperId', authMiddleware, requireRole('examiner'), async (req, res) => {
  const connection = await db.getConnection();
  
  try {
    const { paperId } = req.params;
    const userId = req.user.user_id;
    await connection.beginTransaction();

    // Check if paper exists and belongs to the examiner
    const [papers] = await connection.query(
      `SELECT paper_id, paper_title, status, generated_by 
       FROM question_papers 
       WHERE paper_id = ?`,
      [paperId]
    );

    if (papers.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Paper not found' });
    }

    const paper = papers[0];

    // Check if user owns this paper
    if (paper.generated_by !== userId) {
      await connection.rollback();
      return res.status(403).json({ success: false, message: 'You can only delete your own papers' });
    }

    // Check if paper can be deleted (only draft status)
    if (paper.status !== 'draft') {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot delete paper. Only draft papers can be deleted.' 
      });
    }

    // Check if any variations have been sent to SME
    const [variationCount] = await connection.query(
      `SELECT COUNT(*) as count 
       FROM question_variations qv
       JOIN sub_questions sq ON qv.sub_question_id = sq.sub_question_id
       WHERE sq.paper_id = ? AND qv.status IN ('sent_to_sme', 'approved', 'sent_to_moderator')`,
      [paperId]
    );

    if (variationCount[0].count > 0) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot delete paper. Some variations have already been sent to SME.' 
      });
    }

    console.log(`🗑️ Deleting paper ${paperId} (${paper.paper_title}) by user ${userId}`);

    // Delete in correct order to avoid foreign key constraints
    
    // 1. Delete question variations
    await connection.query(
      `DELETE qv FROM question_variations qv
       JOIN sub_questions sq ON qv.sub_question_id = sq.sub_question_id
       WHERE sq.paper_id = ?`,
      [paperId]
    );
    console.log('✅ Deleted question variations');

    // 2. Delete sub-questions
    await connection.query(
      `DELETE FROM sub_questions WHERE paper_id = ?`,
      [paperId]
    );
    console.log('✅ Deleted sub-questions');

    // 3. Delete paper_questions links
    await connection.query(
      `DELETE FROM paper_questions WHERE paper_id = ?`,
      [paperId]
    );
    console.log('✅ Deleted paper_questions links');

    // 4. Delete questions that belong to this paper
    await connection.query(
      `DELETE q FROM questions q
       JOIN paper_questions pq ON q.question_id = pq.question_id
       WHERE pq.paper_id = ?`,
      [paperId]
    );
    console.log('✅ Deleted questions');

    // 5. Finally delete the paper
    await connection.query(
      `DELETE FROM question_papers WHERE paper_id = ?`,
      [paperId]
    );
    console.log('✅ Deleted paper');

    await connection.commit();
    
    res.json({ 
      success: true, 
      message: `Paper "${paper.paper_title}" has been deleted successfully.` 
    });

  } catch (error) {
    await connection.rollback();
    console.error('Delete paper error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to delete paper. Please try again.' 
    });
  } finally {
    connection.release();
  }
});

// NEW API: Examiner - Delete paper with enhanced validation
router.post('/examiner/delete-paper', authMiddleware, requireRole('examiner'), async (req, res) => {
  const connection = await db.getConnection();
  
  try {
    const { paperId } = req.body;
    const userId = req.user.user_id;
    const subjectId = req.user.subject_id;
    
    if (!paperId) {
      return res.status(400).json({ success: false, message: 'Paper ID is required' });
    }

    await connection.beginTransaction();

    // Check if paper exists and belongs to the examiner
    const [papers] = await connection.query(
      `SELECT paper_id, paper_title, status, generated_by, template_id
       FROM question_papers 
       WHERE paper_id = ?`,
      [paperId]
    );

    if (papers.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Paper not found' });
    }

    const paper = papers[0];

    // Check if user owns this paper
    if (paper.generated_by !== userId) {
      await connection.rollback();
      return res.status(403).json({ 
        success: false, 
        message: 'You can only delete your own papers' 
      });
    }

    // Check if paper can be deleted (only draft status)
    if (paper.status !== 'draft') {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot delete paper. Only draft papers can be deleted.',
        reason: 'Paper status is not draft'
      });
    }

    // Check if any variations have been sent to SME
    const [variationCount] = await connection.query(
      `SELECT COUNT(*) as count 
       FROM question_variations qv
       JOIN sub_questions sq ON qv.sub_question_id = sq.sub_question_id
       WHERE sq.paper_id = ? AND qv.status IN ('sent_to_sme', 'approved', 'sent_to_moderator')`,
      [paperId]
    );

    if (variationCount[0].count > 0) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot delete paper. Some variations have already been sent to SME.',
        reason: 'Variations sent to SME',
        variationCount: variationCount[0].count
      });
    }

    console.log(`🗑️ [NEW API] Deleting paper ${paperId} (${paper.paper_title}) by user ${userId}`);

    // Delete in correct order to avoid foreign key constraints
    
    // 1. Delete question variations
    const [deletedVariations] = await connection.query(
      `DELETE qv FROM question_variations qv
       JOIN sub_questions sq ON qv.sub_question_id = sq.sub_question_id
       WHERE sq.paper_id = ?`,
      [paperId]
    );
    console.log(`✅ Deleted ${deletedVariations.affectedRows} question variations`);

    // 2. Delete sub-questions
    const [deletedSubQuestions] = await connection.query(
      `DELETE FROM sub_questions WHERE paper_id = ?`,
      [paperId]
    );
    console.log(`✅ Deleted ${deletedSubQuestions.affectedRows} sub-questions`);

    // 3. Delete questions that belong to this paper (before deleting paper_questions links)
    const [deletedQuestions] = await connection.query(
      `DELETE q FROM questions q
       JOIN paper_questions pq ON q.question_id = pq.question_id
       WHERE pq.paper_id = ?`,
      [paperId]
    );
    console.log(`✅ Deleted ${deletedQuestions.affectedRows} questions`);

    // 4. Delete paper_questions links
    const [deletedPaperQuestions] = await connection.query(
      `DELETE FROM paper_questions WHERE paper_id = ?`,
      [paperId]
    );
    console.log(`✅ Deleted ${deletedPaperQuestions.affectedRows} paper_questions links`);

    // 5. Finally delete the paper
    await connection.query(
      `DELETE FROM question_papers WHERE paper_id = ?`,
      [paperId]
    );
    console.log('✅ Deleted paper');

    // 6. Log audit trail
    await connection.query(
      `INSERT INTO audit_logs (user_id, college_id, action, entity_type, entity_id, details, ip_address) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId, 
        null, 
        'DELETED_PAPER', 
        'question_paper', 
        paperId,
        JSON.stringify({ 
          paper_title: paper.paper_title, 
          template_id: paper.template_id,
          deleted_at: new Date().toISOString()
        }),
        req.ip
      ]
    );

    await connection.commit();
    
    res.json({ 
      success: true, 
      message: `Paper "${paper.paper_title}" has been deleted successfully.`,
      deletedPaperId: paperId
    });

  } catch (error) {
    await connection.rollback();
    console.error('Delete paper error (NEW API):', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to delete paper. Please try again.',
      error: error.message
    });
  } finally {
    connection.release();
  }
});

module.exports = router;



// Moderator: Download