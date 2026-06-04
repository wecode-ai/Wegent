FROM ghcr.io/wecode-ai/wegent-base-python3.12:latest AS builder

WORKDIR /app

COPY shared /app/shared
COPY executor/pyproject.toml /app/executor/pyproject.toml

RUN cd /app/shared \
    && uv pip install --system --no-cache -e . \
    && cd /app/executor \
    && uv pip install --system --no-cache -r pyproject.toml \
    && uv pip install --system --no-cache --no-deps openai-codex==0.1.0b2 \
    && uv pip install --system --no-cache pyinstaller

COPY executor /app/executor

RUN cd /app/executor && bash build.sh

FROM ghcr.io/wecode-ai/wegent-base-python3.12:latest

WORKDIR /app

RUN npm install -g @anthropic-ai/claude-code@2.1.142 \
    && npm cache clean --force

COPY --from=builder /app/executor/dist/executor /app/executor

RUN chmod +x /app/executor

ENV NODE_PATH=/usr/lib/node_modules
ENV PYTHONUNBUFFERED=1
ENV PORT=10001

CMD ["/app/executor"]
