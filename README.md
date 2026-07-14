# gpt-image-2 Studio

A small full-stack playground that lets anyone try the **gpt-image-2** image
generation model. Write a prompt, pick an aspect ratio, optionally add reference
images (drag-and-drop / click-to-upload, or paste a URL) for image-to-image, and
watch the result render live. The UI is in Simplified Chinese.

The frontend was designed with the **design-taste-frontend** skill: a light
editorial studio look, a single accent color, self-hosted fonts, real states
(empty / loading / result / error), and live progress. Every parameter from the
upstream API request body is exposed; the optional ones (`model`, custom
`aspectRatio`, `webHook`, `shutProgress`) live in a collapsible 高级参数
(advanced) section.

![studio](static/showcase/coast.webp)

## How it works

```
browser  ──POST /api/generate──▶  FastAPI backend  ──POST /v1/draw/completions──▶  grsai (gpt-image-2)
        ◀──── SSE progress ─────                   ◀──────── SSE stream ──────────
```

The backend is a thin proxy. The API key lives only on the server (read from the
`GRSAI_API_KEY` environment variable) and is **never** exposed to the browser.
The Server-Sent-Events progress stream from the upstream API is relayed straight
through to the client so the progress bar updates in real time.

## API contract (grsai, legacy endpoint)

- `POST {GRSAI_BASE_URL}/v1/draw/completions`
- Headers: `Content-Type: application/json`, `Authorization: Bearer <key>`
- Body:
  ```json
  {
    "model": "gpt-image-2",
    "prompt": "a neon-lit ramen stall in the rain, cinematic",
    "aspectRatio": "1024x1024",
    "urls": ["https://example.com/ref.png"],
    "webHook": "https://example.com/callback",
    "shutProgress": false
  }
  ```
- Response: a `text/event-stream` of `data: {json}` frames. Each frame carries
  `progress` (1-100), `status` (`running` / `succeeded` / `failed`) and, on
  success, `results: [{ "url": "..." }]`.

### Aspect ratios

The UI exposes the documented gpt-image-2 ratio set as chips:
`1:1, 3:2, 2:3, 4:3, 3:4, 5:4, 4:5, 16:9, 9:16, 21:9, auto`. Ratio strings are
honoured accurately by the API. The 高级参数 (advanced) section also has a custom
size field that accepts either a ratio (`16:9`) or pixels (`1280x720`).

### Reference image upload

- `POST /api/upload` (multipart, field `file`) stores a JPG / PNG / WEBP image
  (max 12 MB) and returns `{ "url": "<public-url>/uploads/<name>" }`.
- Uploaded files are served from `/uploads/<name>`. The URL is built from the
  forwarded host headers so it is reachable by the upstream API for
  image-to-image. Uploaded files are runtime data and are git-ignored.
- The browser can upload via drag-and-drop or the file picker; uploaded images
  and pasted URLs are merged into `urls` (max 4).

## Run locally

Requires Python 3.11+.

```bash
# 1. install deps (uses uv if available, otherwise pip)
uv sync                      # or: pip install -e .

# 2. configure the key
cp .env.example .env         # then edit .env and set GRSAI_API_KEY

# 3. start the server
export $(grep -v '^#' .env | xargs)   # load .env into the shell
uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8000.

## Configuration

| Variable         | Default                 | Description                                   |
| ---------------- | ----------------------- | --------------------------------------------- |
| `GRSAI_API_KEY`  | (required)              | grsai API key, sent as a Bearer token.        |
| `GRSAI_BASE_URL` | `https://grsaiapi.com`  | Use `https://grsai.dakka.com.cn` for CN host. |
| `GRSAI_MODEL`    | `gpt-image-2`           | Model name passed to the API.                 |
| `PUBLIC_BASE_URL`| (derived from headers)  | Explicit public base for uploaded images when behind a proxy/tunnel; may include `user:pass@` for a basic-auth tunnel so the upstream API can fetch uploads. |

## Project layout

```
app/main.py        FastAPI app: /api/generate (SSE proxy), /api/upload, /api/config, /healthz, static + /uploads serving
static/index.html  single-page studio UI
static/styles.css  light studio theme (self-hosted Space Grotesk + JetBrains Mono)
static/app.js      prompt form, SSE parsing, live progress, gallery
static/showcase/   example renders produced by gpt-image-2 itself
```
