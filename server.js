/**
 * One-Stop File Converter — Backend (Express + CloudConvert)
 * Secure uploads • strict validation • robust error handling
 *
 * ENV VARS (.env):
 *  - PORT=8080
 *  - CLOUDCONVERT_API_KEY=your_api_key_here
 *  - MAX_FILE_SIZE_MB=25
 */
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import axios from 'axios';
import CloudConvert from 'cloudconvert';
import FormData from 'form-data';

const app = express();

// ---- Security & Basics ----
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '1mb' }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use('/api/', limiter);

// ---- Multer Upload Config ----
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 25);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // Accept any upload but block obviously dangerous types.
    const banned = [
      'application/x-msdownload',
      'application/x-dosexec',
      'application/x-executable',
      'application/x-sh',
      'application/x-binary'
    ];
    if (banned.includes(file.mimetype)) return cb(new Error('Unsupported file type for security reasons.'));
    cb(null, true);
  }
});

// ---- Supported Conversions ----
// Map source mime -> allowed target formats
const CONVERSION_MAP = {
  'application/pdf': ['docx', 'png'],
  'application/msword': ['pdf', 'docx'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['pdf'],
  'image/jpeg': ['png', 'webp', 'jpg'],
  'image/png': ['jpg', 'webp', 'pdf', 'png'],
  'image/webp': ['jpg', 'png'],
  'text/plain': ['pdf']
};

function isTargetAllowed(mime, target) {
  const allowed = CONVERSION_MAP[mime] || [];
  return allowed.includes(String(target || '').toLowerCase());
}

// ---- CloudConvert Setup ----
const cloudconvertApiKey = process.env.CLOUDCONVERT_API_KEY;
if (!cloudconvertApiKey) {
  console.warn('[WARN] CLOUDCONVERT_API_KEY is missing. Set it in your .env');
}
const cloudConvert = new CloudConvert(cloudconvertApiKey);

// ---- Helpers ----
function badRequest(res, msg, details) {
  return res.status(400).json({ error: msg, ...(details ? { details } : {}) });
}
function serverError(res, msg, details) {
  return res.status(500).json({ error: msg || 'Internal server error', ...(details ? { details } : {}) });
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), maxUploadMB: MAX_FILE_SIZE_MB });
});

/**
 * POST /api/convert
 * multipart/form-data: { file: <binary>, target: <string e.g. 'pdf'|'docx'|'png'|'jpg'|'webp'> }
 * Returns: { downloadUrl, filename, sizeBytes, contentType, meta }
 */
app.post('/api/convert', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return badRequest(res, 'No file uploaded. Use field name "file".');
    const target = (req.body?.target || '').toLowerCase();
    if (!target) return badRequest(res, 'Missing target format. Include a "target" field (e.g., pdf, docx, png).');

    const { originalname, mimetype, buffer, size } = req.file;

    // Validate supported conversions
    if (!CONVERSION_MAP[mimetype]) {
      return badRequest(res, 'This file type is not supported yet.', {
        receivedMime: mimetype,
        supportedMimes: Object.keys(CONVERSION_MAP)
      });
    }
    if (!isTargetAllowed(mimetype, target)) {
      return badRequest(res, 'Target format not allowed for this file type.', {
        sourceMime: mimetype,
        allowedTargets: CONVERSION_MAP[mimetype]
      });
    }

    // Create job with import/upload -> convert -> export/url
    const job = await cloudConvert.jobs.create({
      tasks: {
        'import-1': { operation: 'import/upload' },
        'convert-1': {
          operation: 'convert',
          input: 'import-1',
          output_format: target
        },
        'export-1': { operation: 'export/url', input: 'convert-1', inline: false, archive_multiple_files: false }
      }
    });

    const importTask = job.tasks.find(t => t.name === 'import-1');
    if (!importTask || !importTask.result) {
      return serverError(res, 'Failed to initialize upload with conversion service.');
    }

    // Upload to the signed URL
    const uploadUrl = importTask.result.form.url;
    const uploadFields = importTask.result.form.parameters || {};

    const form = new FormData();
    Object.entries(uploadFields).forEach(([k, v]) => form.append(k, v));
    form.append('file', buffer, { filename: originalname, contentType: mimetype, knownLength: buffer.length });

    await axios.post(uploadUrl, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    // Wait for job completion
    const completedJob = await cloudConvert.jobs.wait(job.id);
    const exportTask = completedJob.tasks.find(t => t.name === 'export-1' && t.status === 'finished');
    if (!exportTask || !exportTask.result || !exportTask.result.files || !exportTask.result.files[0]) {
      return serverError(res, 'Conversion finished, but no output file was provided.');
    }

    const fileInfo = exportTask.result.files[0];
    return res.json({
      downloadUrl: fileInfo.url,
      filename: fileInfo.filename,
      sizeBytes: fileInfo.size,
      contentType: fileInfo.content_type,
      meta: {
        original: { name: originalname, mime: mimetype, size },
        target
      }
    });
  } catch (err) {
    // Multer errors
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return badRequest(res, `Max file size is ${MAX_FILE_SIZE_MB}MB.`);
      }
      return badRequest(res, 'Upload error.', { code: err.code, message: err.message });
    }

    // CloudConvert / network errors
    if (axios.isAxiosError?.(err)) {
      const status = err.response?.status || 500;
      return res.status(status >= 400 && status < 600 ? status : 500).json({
        error: 'Upstream conversion error.',
        details: { status, data: err.response?.data || null }
      });
    }

    console.error('[ERROR] /api/convert', err);
    return serverError(res, 'Unexpected server error.', { message: err?.message });
  }
});

// 404 & Error handler
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[UNCAUGHT]', err);
  res.status(500).json({ error: 'Unhandled error' });
});

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  console.log(`File Converter API running on http://localhost:${PORT}`);
});
