const events = require('events');
events.EventEmitter.defaultMaxListeners = 25;

const express = require('express');
const http = require('http');
// const { Server } = require('socket.io'); // COMMENTED OUT - Not using Socket.IO
const dotenv = require('dotenv');
const cors = require('cors');
const db = require('./config/db');
const authRoutes = require('./routes/auth');
const collegeRoutes = require('./routes/colleges');
const userRoutes = require('./routes/users');
const publicRoutes = require('./routes/public');
const coordinatorRoutes = require('./routes/coordinators');
const adminRoutes = require('./routes/admins');
const paperRoutes = require('./routes/papers');
const departmentRoutes = require('./routes/departments');
// const pdfRoutes = require('./routes/pdfs-simple'); // Simple PDF extraction, no embeddings
const templateRoutes = require('./routes/templates');
const paperGenerationRoutes = require('./routes/paper-generation');
const smeSelectionRoutes = require('./routes/sme-selection');
const moderatorCategorizationRoutes = require('./routes/moderator-categorization');
const questionVariationsRoutes = require('./routes/question-variations');
const subQuestionsRoutes = require('./routes/sub-questions');
const universitiesRoutes = require('./routes/universities');
const templateExtractionRoutes = require('./routes/template-extraction');
const voiceAssistantRoutes = require('./routes/voice-assistant');
const subjectsRoutes = require('./routes/subjects');
const subjectPdfsRoutes = require('./routes/subject-pdfs');

dotenv.config();
const app = express();
const server = http.createServer(app);

// SOCKET.IO COMMENTED OUT - Not currently in use
// // Initialize Socket.IO
// const io = new Server(server, {
//   cors: {
//     origin: '*',
//     methods: ['GET', 'POST'],
//     credentials: true
//   }
// });

// // Make io accessible to routes
// app.set('io', io);

// // Socket.IO connection handling with detailed error logging
// io.on('connection', (socket) => {
//   console.log('✓ Socket.IO: Client connected');
//   console.log('  - Socket ID:', socket.id);
//   console.log('  - Client IP:', socket.handshake.address);
//   console.log('  - Transport:', socket.conn.transport.name);
//   console.log('  - Total connections:', io.engine.clientsCount);

//   // Handle connection errors
//   socket.on('connect_error', (error) => {
//     console.error('✗ Socket.IO: Connection error');
//     console.error('  - Socket ID:', socket.id);
//     console.error('  - Error:', error.message);
//     console.error('  - Stack:', error.stack);
//   });

//   // Handle general errors
//   socket.on('error', (error) => {
//     console.error('✗ Socket.IO: Socket error');
//     console.error('  - Socket ID:', socket.id);
//     console.error('  - Error:', error.message);
//     console.error('  - Stack:', error.stack);
//   });

//   // Handle disconnection
//   socket.on('disconnect', (reason) => {
//     console.log('✗ Socket.IO: Client disconnected');
//     console.log('  - Socket ID:', socket.id);
//     console.log('  - Reason:', reason);
//     console.log('  - Remaining connections:', io.engine.clientsCount);
//   });

//   // Handle disconnecting event (before actual disconnect)
//   socket.on('disconnecting', (reason) => {
//     console.log('⚠ Socket.IO: Client disconnecting');
//     console.log('  - Socket ID:', socket.id);
//     console.log('  - Reason:', reason);
//     console.log('  - Rooms:', Array.from(socket.rooms));
//   });
// });

// // Handle Socket.IO server errors
// io.engine.on('connection_error', (err) => {
//   console.error('✗ Socket.IO Engine: Connection error');
//   console.error('  - Code:', err.code);
//   console.error('  - Message:', err.message);
//   console.error('  - Context:', err.context);
// });


// === Middleware Configuration (FIX APPLIED HERE) ===

app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Function to conditionally skip express.json() for file upload routes (multipart/form-data)
const skipMultipart = (req, res, next) => {
    // Specify the full paths for routes that use multer (file uploads)
    // The router is mounted at '/sub-questions', and the route is '/upload-pdf'
    const fileUploadRoutes = [
        '/sub-questions/upload-pdf',
    ];

    // Get the base path without query parameters
    const path = req.path.split('?')[0];

    if (fileUploadRoutes.includes(path)) {
        // Skip JSON parsing for file upload routes. Multer will handle body parsing.
        return next();
    }
    
    // For all other routes, apply standard JSON parsing with increased limit
    express.json({ limit: '50mb' })(req, res, next);
};

// Use the conditional function to apply JSON parsing globally
app.use(skipMultipart);

// ==================================================


app.get('/', (req, res) => {
  res.json({ ok: true, message: 'AI Question Paper Generator SaaS Platfor' });
});

app.get('/db-test', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT NOW() AS now');
    res.json({ success: true, time: rows[0].now });
  } catch (err) {
    console.error('DB test error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Routes
app.use('/public', publicRoutes);
app.use('/auth', authRoutes);
app.use('/colleges', collegeRoutes);
app.use('/users', userRoutes);
app.use('/coordinators', coordinatorRoutes);
app.use('/admins', adminRoutes);
app.use('/papers', paperRoutes);
app.use('/departments', departmentRoutes);
// app.use('/pdfs', pdfRoutes);
app.use('/templates', templateRoutes);
app.use('/paper-generation', paperGenerationRoutes);
app.use('/sme-selection', smeSelectionRoutes);
app.use('/moderator-categorization', moderatorCategorizationRoutes);
app.use('/question-variations', questionVariationsRoutes);
app.use('/sub-questions', subQuestionsRoutes);
app.use('/universities', universitiesRoutes);
app.use('/template-extraction', templateExtractionRoutes);
app.use('/voice-assistant', voiceAssistantRoutes);
app.use('/subjects', subjectsRoutes);
app.use('/subject-pdfs', subjectPdfsRoutes);

const PORT = process.env.PORT || 5000;
server.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Server URL: ${process.env.SERVER_URL || `http://localhost:${PORT}`}`);
  // console.log(`Socket.IO enabled for real-time updates`); // COMMENTED OUT

  // Test database connection
  try {
    await db.query('SELECT 1');
    const dbHost = process.env.DB_HOST || 'localhost';
    const dbType = dbHost === 'localhost' || dbHost === '127.0.0.1' ? 'Local' : 'Live';
    console.log(`✓ Database connected successfully (${dbType}: ${dbHost}:${process.env.DB_PORT || 3306})`);
  } catch (err) {
    console.error('✗ Database connection failed:', err.message);
  }
});