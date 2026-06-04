FROM ghcr.io/wecode-ai/wegent-base-python3.12:latest

WORKDIR /app

COPY shared /app/src/shared
COPY executor /app/src/executor

RUN cd /app/src/shared \
    && uv pip install --system --no-cache -e . \
    && cd /app/src/executor \
    && uv pip install --system --no-cache -r pyproject.toml \
    && uv pip install --system --no-cache --no-deps openai-codex==0.1.0b2 \
    && npm install -g @anthropic-ai/claude-code@2.1.142 \
    && npm cache clean --force
    && printf '#!/bin/sh\nexec python -m executor.main "$@"\n' > /app/executor \
    && chmod +x /app/executor

ENV NODE_PATH=/usr/lib/node_modules
ENV PYTHONPATH=/app/src
ENV PYTHONUNBUFFERED=1
ENV PORT=10001

CMD ["/app/executor"]
