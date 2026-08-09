# RiZip 120FPS Video Server

Server-side video processing for RiZip 120FPS. Receives MP4 uploads, patches the audio track with phantom samples, and returns the patched file.

## How it works

1. User uploads MP4 video
2. Server patches the audio track metadata (adds phantom samples)
3. Server returns the patched MP4 file

## API

### `POST /api/process`

Upload an MP4 file, get back the patched version.

**Request:**
- `Content-Type: multipart/form-data`
- Body: `video` field with the MP4 file

**Response:**
- `Content-Type: video/mp4`
- `Content-Disposition: attachment; filename="*_RiZip120FPS.mp4"`

**Limits:**
- Max file size: 100MB
- Max requests: 20 per 15 minutes per IP

### `GET /health`

Returns `{ status: "ok" }`.

## Deployment (Render.com)

1. Push to GitHub
2. Connect repo to Render.com
3. Render auto-detects `render.yaml` config
4. Deploy

## Local development

```bash
npm install
npm run dev
# Server runs on http://localhost:3000
```

Test with curl:
```bash
curl -X POST -F "video=@test.mp4" http://localhost:3000/api/process -o output.mp4
```
