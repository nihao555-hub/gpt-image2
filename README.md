# gpt-image-2 Studio

A small full-stack playground that lets anyone try the **gpt-image-2** image
generation model. Write a prompt, pick an aspect ratio, optionally add reference
images, and watch the result render live. The UI is in Simplified Chinese.

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

## Project layout

```
app/main.py        FastAPI app: /api/generate (SSE proxy), /api/config, /healthz, static serving
static/index.html  single-page studio UI
static/styles.css  light studio theme (self-hosted Space Grotesk + JetBrains Mono)
static/app.js      prompt form, SSE parsing, live progress, gallery
static/showcase/   example renders produced by gpt-image-2 itself
```
