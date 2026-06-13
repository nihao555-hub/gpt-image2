"""FastAPI backend for the gpt-image-2 Studio.

Exposes a single streaming endpoint that proxies the grsai
``/v1/draw/completions`` image-generation API. The upstream API key never
leaves the server: the browser talks only to this backend, which injects the
``Authorization`` header from the ``GRSAI_API_KEY`` environment variable and
relays the Server-Sent-Events progress stream back to the client.
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Annotated

import httpx
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

logger = logging.getLogger("gpt_image2")

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
# Reference images uploaded from the browser are stored here and served back at
# ``/uploads/<name>`` so the upstream API can fetch them for image-to-image.
UPLOAD_DIR = Path(__file__).resolve().parent.parent / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
# Ensure static serving returns correct image content types (some systems lack
# a webp mapping by default), so the upstream API can fetch uploads reliably.
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/jpeg", ".jpg")
mimetypes.add_type("image/png", ".png")

# Configuration (all overridable via environment variables).
GRSAI_API_KEY = os.environ.get("GRSAI_API_KEY", "").strip()
# Overseas host by default; set GRSAI_BASE_URL=https://grsai.dakka.com.cn for the
# mainland-China direct host.
GRSAI_BASE_URL = os.environ.get("GRSAI_BASE_URL", "https://grsaiapi.com").rstrip("/")
GRSAI_MODEL = os.environ.get("GRSAI_MODEL", "gpt-image-2")
# Optional explicit public base URL for uploaded reference images. Set this when
# the app sits behind a proxy/tunnel whose host (or credentials) cannot be
# derived from request headers, so the upstream API can fetch uploads. May
# include userinfo, e.g. https://user:pass@host, for a basic-auth-protected
# tunnel.
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/")

# Aspect-ratio presets surfaced in the UI. gpt-image-2 honours ratio strings
# (e.g. "16:9") accurately, so we expose the documented ratio set. The upstream
# API also accepts "auto" and pixel "WxH" strings, so the "custom size" advanced
# field additionally allows any value matching one of the patterns below.
ASPECT_RATIO_PRESETS = [
    "1:1",
    "3:2",
    "2:3",
    "4:3",
    "3:4",
    "5:4",
    "4:5",
    "16:9",
    "9:16",
    "21:9",
    "auto",
]
ASPECT_RATIO_RE = re.compile(r"^\d{2,5}x\d{2,5}$")  # pixels, e.g. 1280x720
ASPECT_RATIO_RATIO_RE = re.compile(r"^\d{1,4}:\d{1,4}$")  # ratio, e.g. 16:9
DEFAULT_ASPECT_RATIO = "1:1"
MAX_REFERENCE_URLS = 4

# Uploaded reference images: allowed content types -> file extension, size cap.
ALLOWED_UPLOAD_TYPES = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}
MAX_UPLOAD_BYTES = 12 * 1024 * 1024

app = FastAPI(title="gpt-image-2 Studio", version="0.1.0")


class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=4000)
    aspectRatio: str = Field(default=DEFAULT_ASPECT_RATIO)
    urls: list[str] = Field(default_factory=list)
    # Advanced, all optional. Mirror the upstream API request body 1:1.
    model: str = Field(default="")
    webHook: str = Field(default="")
    shutProgress: bool = Field(default=False)

    @field_validator("prompt")
    @classmethod
    def _strip_prompt(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("prompt must not be empty")
        return value

    @field_validator("aspectRatio")
    @classmethod
    def _check_ratio(cls, value: str) -> str:
        value = (value or "").strip()
        if value == "auto" or ASPECT_RATIO_RE.match(value) or ASPECT_RATIO_RATIO_RE.match(value):
            return value
        return DEFAULT_ASPECT_RATIO

    @field_validator("urls")
    @classmethod
    def _clean_urls(cls, value: list[str]) -> list[str]:
        cleaned = [u.strip() for u in value if u and u.strip()]
        if len(cleaned) > MAX_REFERENCE_URLS:
            raise ValueError(f"at most {MAX_REFERENCE_URLS} reference images are allowed")
        for url in cleaned:
            if not (url.startswith("http://") or url.startswith("https://")):
                raise ValueError(f"reference image url must be http(s): {url}")
        return cleaned

    @field_validator("model")
    @classmethod
    def _clean_model(cls, value: str) -> str:
        return (value or "").strip()

    @field_validator("webHook")
    @classmethod
    def _check_webhook(cls, value: str) -> str:
        value = (value or "").strip()
        if value and not (value.startswith("http://") or value.startswith("https://")):
            raise ValueError("webHook must be an http(s) URL")
        return value


def _sse(payload: dict) -> bytes:
    """Encode a dict as a single Server-Sent-Event ``data:`` frame."""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()


async def _stream_generation(req: GenerateRequest) -> AsyncIterator[bytes]:
    if not GRSAI_API_KEY:
        yield _sse(
            {
                "status": "failed",
                "error": "Server is missing the GRSAI_API_KEY environment variable.",
            }
        )
        return

    payload: dict = {
        "model": req.model or GRSAI_MODEL,
        "prompt": req.prompt,
        "aspectRatio": req.aspectRatio,
        "shutProgress": req.shutProgress,
    }
    if req.urls:
        payload["urls"] = req.urls
    if req.webHook:
        payload["webHook"] = req.webHook

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {GRSAI_API_KEY}",
    }
    url = f"{GRSAI_BASE_URL}/v1/draw/completions"
    # Image generation can take ~1-2 minutes; keep a generous read timeout.
    timeout = httpx.Timeout(connect=15.0, read=300.0, write=30.0, pool=15.0)

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", url, json=payload, headers=headers) as resp:
                if resp.status_code != 200:
                    body = (await resp.aread()).decode("utf-8", "replace")[:500]
                    logger.warning("Upstream error %s: %s", resp.status_code, body)
                    yield _sse(
                        {
                            "status": "failed",
                            "error": f"Upstream API returned {resp.status_code}.",
                            "detail": body,
                        }
                    )
                    return
                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[len("data:") :].strip()
                    if not data:
                        continue
                    # Forward the raw upstream JSON as a clean SSE frame.
                    yield f"data: {data}\n\n".encode()
    except httpx.TimeoutException:
        yield _sse({"status": "failed", "error": "The generation request timed out."})
    except httpx.HTTPError as exc:
        logger.exception("Upstream request failed")
        yield _sse({"status": "failed", "error": f"Upstream request failed: {exc}"})


@app.post("/api/generate")
async def generate(req: GenerateRequest) -> StreamingResponse:
    return StreamingResponse(
        _stream_generation(req),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _public_base_url(request: Request) -> str:
    """Best-effort public base URL, honouring reverse-proxy / tunnel headers.

    When the app runs behind the public tunnel, the original host arrives via
    ``X-Forwarded-*`` headers; we use them so the returned upload URL is one the
    upstream image API can actually fetch.
    """
    if PUBLIC_BASE_URL:
        return PUBLIC_BASE_URL
    forwarded_host = request.headers.get("x-forwarded-host")
    host = forwarded_host or request.headers.get("host")
    if not host:
        return str(request.base_url).rstrip("/")
    proto = request.headers.get("x-forwarded-proto")
    if not proto:
        is_local = host.startswith(("localhost", "127.0.0.1", "0.0.0.0"))
        proto = request.url.scheme if is_local else "https"
    return f"{proto}://{host}"


@app.post("/api/upload")
async def upload(request: Request, file: Annotated[UploadFile, File()]) -> JSONResponse:
    """Store an uploaded reference image and return a public URL for it."""
    content_type = (file.content_type or "").split(";")[0].strip().lower()
    ext = ALLOWED_UPLOAD_TYPES.get(content_type)
    if ext is None:
        raise HTTPException(status_code=415, detail="仅支持 JPG / PNG / WEBP 格式的图片。")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="上传的文件为空。")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="图片过大，请上传 12MB 以内的图片。")
    name = f"{uuid.uuid4().hex}{ext}"
    (UPLOAD_DIR / name).write_bytes(data)
    path = f"/uploads/{name}"
    # ``url`` may carry credentials (for the upstream fetch); ``path`` is a
    # same-origin relative URL the browser can use for the thumbnail (browsers
    # block embedded credentials in <img> subresource requests).
    return JSONResponse(
        {
            "url": f"{_public_base_url(request)}{path}",
            "path": path,
            "name": file.filename or name,
        }
    )


@app.get("/api/config")
async def config() -> JSONResponse:
    """Expose non-sensitive config the frontend needs to render."""
    return JSONResponse(
        {
            "model": GRSAI_MODEL,
            "aspectRatios": ASPECT_RATIO_PRESETS,
            "maxReferenceUrls": MAX_REFERENCE_URLS,
            "maxUploadMB": MAX_UPLOAD_BYTES // (1024 * 1024),
            "apiKeyConfigured": bool(GRSAI_API_KEY),
        }
    )


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok", "apiKeyConfigured": bool(GRSAI_API_KEY)}


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


# User-uploaded reference images. Mounted before the catch-all "/" mount.
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

# Static assets (styles, scripts, fonts). Mounted last so it does not shadow the
# API routes above.
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
