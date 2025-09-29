# One-Stop File Converter — Backend

Node.js + Express + CloudConvert. Secure uploads, strict validation, robust error handling.

## Quick start
```bash
npm i
cp .env.example .env
# edit .env and set CLOUDCONVERT_API_KEY
npm start
# http://localhost:8080/api/health
```

### Convert via cURL
```bash
curl -X POST http://localhost:8080/api/convert     -F "file=@/path/to/input.pdf"     -F "target=docx"
```

## Environment
Create `.env`:
```env
PORT=8080
CLOUDCONVERT_API_KEY=your_api_key_here
MAX_FILE_SIZE_MB=25
```

> `.env` is ignored by git. Do NOT commit secrets.

## Supported conversions (MVP)
- PDF → DOCX, PNG
- DOC/DOCX → PDF (and DOCX→PDF)
- PNG → JPG/WEBP/PDF
- JPG → PNG/WEBP/JPG
- WEBP → JPG/PNG
- TXT → PDF

Extend by editing `CONVERSION_MAP` in `server.js`.

## Deploy
- **Render / Railway**: set env vars, start command `node server.js`.
- **Vercel (API Route)**: port `app.post('/api/convert', ...)` into a serverless function.
