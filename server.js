const express = require('express');
const multer = require('multer');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { patchVideo } = require('./mp4patch');

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

// ─── Security ───────────────────────────────────────────────────────────────
const VIDEO_API_KEY = process.env.VIDEO_API_KEY || 'rizip-dev-key-change-me';

app.use(helmet());
app.use(cors({
  origin: [
    'https://rizip120fps.com',
    'https://www.rizip120fps.com',
    'http://localhost:5173',
    'http://localhost:3000',
  ],
  methods: ['POST', 'GET'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
}));

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many uploads. Try again in 15 minutes.' },
});

// ─── IP tracking ────────────────────────────────────────────────────────────
const ipLog = new Map(); // ip -> { count, windowStart }
const IP_WINDOW = 60 * 60 * 1000; // 1 hour
const IP_MAX = 30;

function trackIp(ip) {
  const now = Date.now();
  const entry = ipLog.get(ip);
  if (!entry || now - entry.windowStart > IP_WINDOW) {
    ipLog.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= IP_MAX) return false;
  entry.count++;
  return true;
}

// Clean up old entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipLog) {
    if (now - entry.windowStart > IP_WINDOW * 2) ipLog.delete(ip);
  }
}, 10 * 60 * 1000);

// ─── API key auth ───────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== VIDEO_API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key.' });
  }
  next();
}

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
app.post('/api/process', uploadLimiter, requireApiKey, (req, res, next) => {
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  if (!trackIp(clientIp)) {
    return res.status(429).json({ error: 'IP rate limit exceeded. Try again later.' });
  }
  next();
}, upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No video file uploaded.' });
  }

  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  const inputSizeMB = (req.file.size / (1024 * 1024)).toFixed(1);
  console.log(`[PROCESS] Received: ${req.file.originalname} (${inputSizeMB} MB) from ${clientIp}`);

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
