# Stage 1: Build frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY apps/client-web/frontend/package*.json ./
RUN npm ci
COPY apps/client-web/frontend/ ./
RUN npm run build

# Stage 2: Python backend
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml ./
COPY apps/host-runtime/ ./apps/host-runtime/
COPY packages/ ./packages/
COPY adapters/ ./adapters/

# Copy frontend build artifacts
COPY --from=frontend-builder /app/frontend/dist/ ./apps/host-runtime/backend/static-dist/
COPY --from=frontend-builder /app/frontend/dist/index.html ./apps/host-runtime/backend/index.html

# Install internal packages, then the main app + adapters
RUN pip install --no-cache-dir -e packages/core/ \
    && pip install --no-cache-dir -e packages/adapter-sdk/ \
    && pip install --no-cache-dir -e packages/voice-providers/ \
    && pip install --no-cache-dir -e . \
    && pip install --no-cache-dir -e adapters/openai-compatible/ \
    && pip install --no-cache-dir -e adapters/anthropic/ \
    && pip install --no-cache-dir -e adapters/openclaw/ \
    && pip install --no-cache-dir -e adapters/claude-code/

VOLUME ["/data"]
ENV TRYVOICE_USER_DATA_DIR=/data
ENV TRYVOICE_ACTIVE_ADAPTER=echo
ENV PORT=7860
EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=15s \
  CMD curl -f http://localhost:7860/health || exit 1

CMD ["python", "-m", "backend.cli"]
