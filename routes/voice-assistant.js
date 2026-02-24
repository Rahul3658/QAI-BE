/**
 * Voice Assistant Routes
 * 
 * Endpoints:
 * - POST /voice-assistant/process-command - Process voice command
 * - GET /voice-assistant/context/:contextName/functions - Get function definitions
 * - GET /voice-assistant/health - Health check
 */

const express = require('express');
const router = express.Router();
const { getVoiceAssistantService } = require('../services/voiceAssistantService');
const { getRateLimiter } = require('../utils/rateLimiter');
const { getModelSelector } = require('../utils/modelSelector');

// Middleware to verify authentication (reuse existing auth middleware)
const { authMiddleware: verifyToken } = require('../middleware/auth');

/**
 * POST /voice-assistant/process-command
 * Process a voice command and return actions + response
 */
router.post('/process-command', verifyToken, async (req, res) => {
  try {
    const { transcript, context, formState, conversationHistory } = req.body;

    // Validate request
    if (!transcript || typeof transcript !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Transcript is required and must be a string'
      });
    }

    if (!context || typeof context !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Context is required and must be a string'
      });
    }

    if (!formState || typeof formState !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'Form state is required and must be an object'
      });
    }

    console.log(`📥 Voice command request from user ${req.user.user_id}:`, {
      transcript: transcript.substring(0, 100),
      context,
      historyLength: conversationHistory?.length || 0
    });

    // Process command
    const voiceAssistantService = getVoiceAssistantService();
    const result = await voiceAssistantService.processCommand(
      transcript,
      context,
      formState,
      conversationHistory || []
    );

    // Return result
    res.json({
      success: result.success,
      response: result.response,
      actions: result.actions,
      updatedState: result.updatedState,
      conversationContext: result.conversationContext,
      usage: result.usage,
      error: result.error || null
    });

  } catch (error) {
    console.error('❌ Voice assistant error:', error);
    
    res.status(500).json({
      success: false,
      message: 'Failed to process voice command',
      error: {
        code: 'INTERNAL_ERROR',
        message: error.message,
        retryable: false
      }
    });
  }
});

/**
 * GET /voice-assistant/context/:contextName/functions
 * Get function definitions for a specific context
 */
router.get('/context/:contextName/functions', verifyToken, async (req, res) => {
  try {
    const { contextName } = req.params;

    const voiceAssistantService = getVoiceAssistantService();
    const plugin = voiceAssistantService.getContextPlugin(contextName);

    if (!plugin) {
      return res.status(404).json({
        success: false,
        message: `Context "${contextName}" not found`
      });
    }

    const functions = plugin.getFunctionDefinitions();
    const metadata = plugin.getMetadata();

    res.json({
      success: true,
      context: contextName,
      metadata,
      functions
    });

  } catch (error) {
    console.error('❌ Get context functions error:', error);
    
    res.status(500).json({
      success: false,
      message: 'Failed to get context functions',
      error: error.message
    });
  }
});

/**
 * GET /voice-assistant/contexts
 * Get all available contexts
 */
router.get('/contexts', verifyToken, async (req, res) => {
  try {
    const voiceAssistantService = getVoiceAssistantService();
    const contexts = voiceAssistantService.getAllContexts();

    res.json({
      success: true,
      contexts
    });

  } catch (error) {
    console.error('❌ Get contexts error:', error);
    
    res.status(500).json({
      success: false,
      message: 'Failed to get contexts',
      error: error.message
    });
  }
});

/**
 * GET /voice-assistant/health
 * Health check endpoint
 */
router.get('/health', async (req, res) => {
  try {
    const rateLimiter = getRateLimiter();
    const modelSelector = getModelSelector();
    
    const rateLimitStats = rateLimiter.getUsageStats();
    const modelStats = modelSelector.getStats();

    res.json({
      success: true,
      status: 'healthy',
      geminiAvailable: !!process.env.GEMINI_API_KEY,
      rateLimitStatus: {
        currentRPM: rateLimitStats.currentRPM,
        currentTPM: rateLimitStats.currentTPM,
        rpmLimit: rateLimitStats.rpmLimit,
        tpmLimit: rateLimitStats.tpmLimit,
        rpmUtilization: rateLimitStats.rpmUtilization + '%',
        tpmUtilization: rateLimitStats.tpmUtilization + '%'
      },
      modelStatus: {
        currentModel: modelStats.currentModel,
        overloadedModels: modelStats.overloadedModels,
        consecutiveErrors: modelStats.consecutiveOverloadErrors
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Health check error:', error);
    
    res.status(500).json({
      success: false,
      status: 'unhealthy',
      error: error.message
    });
  }
});

module.exports = router;
