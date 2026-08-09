const express = require('express');
const multer = require('multer');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { patchVideo } = require('./mp4patch');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Security ───────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: [
    'https://rizip120fps.com',
    'https://www.rizip120fps.com',
    'http://localhost:5173',
    'http://localhost:3000',
  ],
  methods: ['POST', 'GET'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many uploads. Try again in 15 minutes.' },
});

// ─── Upload config ──────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'video/mp4' || file.originalname.toLowerCase().endsWith('.mp4')) {
      cb(null, true);
    } else {
      cb(new Error('Only MP4 files are supported.'));
    }
  },
});

// ─── Health check ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Process video ──────────────────────────────────────────────────────────
app.post('/api/process', uploadLimiter, upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No video file uploaded.' });
  }

  const inputSizeMB = (req.file.size / (1024 * 1024)).toFixed(1);
  console.log(`[PROCESS] Received: ${req.file.originalname} (${inputSizeMB} MB)`);

  try {
    const startTime = Date.now();
    const patchedBuffer = patchVideo(req.file.buffer);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    const outputSizeMB = (patchedBuffer.length / (1024 * 1024)).toFixed(1);

    console.log(`[PROCESS] Done in ${elapsed}s: ${outputSizeMB} MB output`);

    const outName = req.file.originalname.replace(/\.mp4$/i, '') + '_RiZip120FPS.mp4';
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="${outName}"`,
      'X-Processing-Time': elapsed + 's',
      'X-Input-Size': String(req.file.size),
      'X-Output-Size': String(patchedBuffer.length),
    });
    res.send(patchedBuffer);
  } catch (err) {
    console.error('[PROCESS] Error:', err.message);
    res.status(422).json({ error: 'Failed to process video: ' + err.message });
  }
});

// ─── Error handler ──────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large. Maximum size is 100MB.' });
    }
    return res.status(400).json({ error: 'Upload error: ' + err.message });
  }
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

// ─── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`RiZip 120FPS video server running on port ${PORT}`);
});
