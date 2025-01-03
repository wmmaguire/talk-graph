import express from 'express';
import cors from 'cors';
import { promises as fs } from 'fs';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import OpenAI from 'openai';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Check for OpenAI API key
if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set in environment variables');
  process.exit(1);
}

// Configure OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Define base directory for production
const baseDir = process.env.NODE_ENV === 'production' 
  ? '/opt/render/project/src/server'
  : __dirname;

const uploadsDir = path.join(baseDir, 'uploads');
const metadataDir = path.join(baseDir, 'metadata');

// Create Express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Ensure directories exist
(async () => {
  try {
    await fs.mkdir(uploadsDir, { recursive: true });
    await fs.mkdir(metadataDir, { recursive: true });
  } catch (error) {
    console.error('Error creating directories:', error);
  }
})();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueId = Date.now();
    const extension = path.extname(file.originalname);
    cb(null, `${uniqueId}${extension}`);
  }
});

const upload = multer({ storage: storage });

// API Routes - Define these BEFORE static file serving
app.get('/api/files', async (req, res) => {
  try {
    console.log('Reading metadata directory:', metadataDir);
    const metadataFiles = await fs.readdir(metadataDir);
    console.log('Found metadata files:', metadataFiles);
    
    const fileList = await Promise.all(
      metadataFiles
        .filter(file => file.endsWith('.json'))
        .map(async (metaFile) => {
          try {
            const metadata = JSON.parse(
              await fs.readFile(path.join(metadataDir, metaFile), 'utf8')
            );
            return {
              ...metadata,
              filename: metaFile.replace('.json', '')
            };
          } catch (error) {
            console.error('Error reading metadata file:', metaFile, error);
            return null;
          }
        })
    );

    const validFiles = fileList.filter(file => file !== null);
    
    res.setHeader('Content-Type', 'application/json');
    res.json({ files: validFiles });
  } catch (error) {
    console.error('Error reading metadata directory:', error);
    res.status(500).json({ 
      error: 'Failed to read files',
      details: error.message,
      path: metadataDir
    });
  }
});

app.post('/api/upload', (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      console.error('Upload Error:', err);
      return res.status(400).json({ 
        error: err.message || 'Error uploading file'
      });
    }

    if (!req.file) {
      return res.status(400).json({ 
        error: 'No file uploaded'
      });
    }

    try {
      // Create metadata for the file
      const metadata = {
        originalName: req.file.originalname,
        customName: req.body.customName || req.file.originalname.replace(/\.[^/.]+$/, ""),
        uploadDate: new Date().toISOString(),
        fileType: req.file.mimetype,
        size: req.file.size
      };

      // Save metadata
      await fs.writeFile(
        path.join(metadataDir, `${req.file.filename}.json`),
        JSON.stringify(metadata, null, 2)
      );

      console.log('File uploaded successfully:', {
        filename: req.file.filename,
        metadata: metadata
      });

      return res.json({ 
        message: 'File uploaded successfully',
        filename: req.file.filename,
        metadata
      });
    } catch (error) {
      console.error('Metadata Error:', error);
      next(error); // Pass error to error handling middleware
    }
  });
});

app.get('/api/test', (req, res) => {
  try {
    res.json({ 
      status: 'ok',
      message: 'Server is running',
      env: process.env.NODE_ENV,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Test endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API Routes - Must come BEFORE the production static/catch-all routes
app.get('/api/files/:filename', async (req, res) => {
  console.log('File request received:', {
    filename: req.params.filename,
    path: req.path,
    method: req.method,
    uploadsDir: uploadsDir
  });
  
  try {
    const filename = decodeURIComponent(req.params.filename);
    const filePath = path.join(uploadsDir, filename);
    
    console.log('File access attempt:', {
      requestedFile: filename,
      fullPath: filePath,
      exists: await fs.access(filePath).then(() => true).catch(() => false)
    });

    // List all files in uploads directory for debugging
    const files = await fs.readdir(uploadsDir);
    console.log('Files in uploads directory:', files);
    
    // Check if file exists before trying to read it
    try {
      await fs.access(filePath);
    } catch (error) {
      console.log('File not found:', {
        filePath,
        error: error.message,
        uploadsDir,
        availableFiles: files
      });
      return res.status(404).json({
        success: false,
        error: 'File not found',
        details: {
          requested: filename,
          path: filePath,
          availableFiles: files
        }
      });
    }

    const content = await fs.readFile(filePath, 'utf8');
    console.log('File read successfully:', {
      filename,
      contentLength: content.length,
      preview: content.substring(0, 100)
    });

    return res.json({
      success: true,
      content: content
    });
  } catch (error) {
    console.error('Server error:', {
      error: error.message,
      stack: error.stack,
      filename: req.params.filename
    });
    return res.status(500).json({
      success: false,
      error: 'Server error',
      details: error.message
    });
  }
});

// Import the router
import uploadRouter from './routes/upload.js';

// Use the router BEFORE your other routes
app.use('/api', uploadRouter);

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    error: err.message || 'Internal server error'
  });
});

// Production configuration - Must come AFTER all API routes
if (process.env.NODE_ENV === 'production') {
  // Serve static files from the React app
  app.use(express.static(path.join(__dirname, '../client/build')));

  // The "catch-all" route handler must be last
  app.get('*', (req, res) => {
    // Don't handle /api routes here
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({
        success: false,
        error: 'API endpoint not found'
      });
    }
    res.sendFile(path.join(__dirname, '../client/build/index.html'));
  });
}

// Error handling middleware - must be last
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  res.status(500).json({ 
    error: 'Something went wrong!',
    message: err.message,
    path: req.path
  });
});

// Update the analyze endpoint
app.post('/api/analyze', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  try {
    const { content } = req.body;

    if (!content) {
      return res.json({
        success: false,
        error: 'No content provided'
      });
    }

    console.log('Analyzing content length:', content.length);
    console.log('Content preview:', content.substring(0, 100));

    const prompt = `
      Analyze the following content and return a JSON object containing:
      1. nodes: An array of objects, each representing a key concept with properties:
         - id: unique identifier
         - label: name of the concept
         - description: brief explanation
      2. links: An array of objects representing relationships between nodes with properties:
         - source: id of the source node
         - target: id of the target node
         - relationship: description of how these concepts are related

      Content to analyze:
      ${content}

      Please ensure the response is valid JSON and includes at least 5-10 key concepts and their relationships.
    `;

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant that analyzes text and identifies key concepts and their relationships. Return only valid JSON without any additional text."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: 2000
    });

    const graphData = JSON.parse(completion.choices[0].message.content);
    console.log('Analysis completed successfully');
    
    return res.json({
      success: true,
      data: graphData
    });
  } catch (error) {
    console.error('Analysis error:', error);
    return res.json({
      success: false,
      error: 'Failed to analyze content',
      details: error.message
    });
  }
});

// Start server
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log('=================================');
  console.log(`Server running on port ${PORT}`);
  console.log(`http://localhost:${PORT}`);
  console.log(`Test endpoint: http://localhost:${PORT}/test`);
  console.log(`Files endpoint: http://localhost:${PORT}/api/files`);
  console.log('OpenAI configured:', !!openai);
  console.log('CORS enabled');
  console.log('Directories:');
  console.log(`- Uploads: ${uploadsDir}`);
  console.log(`- Metadata: ${metadataDir}`);
  console.log('=================================');
});