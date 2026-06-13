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
import os
import re
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

logger = logging.getLogger("gpt_image2")

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

# Configuration (all overridable via environment variables).
GRSAI_API_KEY = os.environ.get("GRSAI_API_KEY", "").strip()
# Overseas host by default; set GRSAI_BASE_URL=https://grsai.dakka.com.cn for the
# mainland-China direct host.
GRSAI_BASE_URL = os.environ.get("GRSAI_BASE_URL", "https://grsaiapi.com").rstrip("/")
GRSAI_MODEL = os.environ.get("GRSAI_MODEL", "gpt-image-2")

# Aspect-ratio presets surfaced in the UI. The upstream API is lenient and also
# accepts "auto" plus arbitrary WxH strings, so we additionally allow any value
# matching ``ASPECT_RATIO_RE`` (used by the "custom size" advanced field).
ASPECT_RATIO_PRESETS = ["1024x1024", "1536x1024", "1024x1536", "auto"]
ASPECT_RATIO_RE = re.compile(r"^\d{2,5}x\d{2,5}$")
MAX_REFERENCE_URLS = 4

app = FastAPI(title="gpt-image-2 Studio", version="0.1.0")


class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=4000)
    aspectRatio: str = Field(default="1024x1024")
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
        if value == "auto" or ASPECT_RATIO_RE.match(value):
            return value
        return "1024x1024"

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


@app.get("/api/config")
async def config() -> JSONResponse:
    """Expose non-sensitive config the frontend needs to render."""
    return JSONResponse(
        {
            "model": GRSAI_MODEL,
            "aspectRatios": ASPECT_RATIO_PRESETS,
            "maxReferenceUrls": MAX_REFERENCE_URLS,
            "apiKeyConfigured": bool(GRSAI_API_KEY),
        }
    )


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok", "apiKeyConfigured": bool(GRSAI_API_KEY)}


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


# Static assets (styles, scripts, fonts). Mounted last so it does not shadow the
# API routes above.
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
