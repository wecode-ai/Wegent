FROM ghcr.io/wecode-ai/wegent-base-python3.12:latest

WORKDIR /workspace/src/executor

COPY shared /workspace/src/shared
COPY executor /workspace/src/executor

RUN cd /workspace/src/shared \
    && uv pip install --system --no-cache -e . \
    && cd /workspace/src/executor \
    && uv pip install --system --no-cache -r pyproject.toml \
    && uv pip install --system --no-cache --no-deps openai-codex==0.1.0b2 \
    && npm install -g @anthropic-ai/claude-code@2.1.142 \
    && npm cache clean --force \
    && mkdir -p /app \
    && printf '#!/bin/sh\nexec python /workspace/src/executor/main.py "$@"\n' > /app/executor \
    && chmod +x /app/executor

ENV NODE_PATH=/usr/lib/node_modules
ENV PYTHONPATH=/workspace/src
ENV PYTHONUNBUFFERED=1
ENV PORT=10001
ENV EXECUTOR_MODE=docker

CMD ["/app/executor"]
