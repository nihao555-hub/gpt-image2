FROM python:3.12-slim

WORKDIR /app

# Install uv for fast dependency resolution.
COPY --from=ghcr.io/astral-sh/uv:0.4.25 /uv /usr/local/bin/uv

# Copy project files.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY app/ app/
COPY static/ static/
RUN uv sync --frozen --no-dev

# Create the uploads directory (runtime data, git-ignored).
RUN mkdir -p uploads

EXPOSE 8000

CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
