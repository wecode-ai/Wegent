# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

FROM ghcr.io/wecode-ai/wegent-base-python3.12:1.0.1

# Set working directory
WORKDIR /app

# Install uv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    export PATH="/root/.local/bin:${PATH}" && \
    uv --version

ENV PATH="/root/.local/bin:${PATH}"

# Copy pyproject.toml and install dependencies
COPY backend/pyproject.toml .
RUN uv pip install --system --no-cache -r pyproject.toml

# Copy application code
COPY backend /app
COPY shared /app/shared

# Create .env file (if it doesn't exist)
RUN if [ ! -f .env ]; then cp .env.example .env; fi

ENV PORT=8000
# Expose port
EXPOSE ${PORT}


# Start command
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 4"]