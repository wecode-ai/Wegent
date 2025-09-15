# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

FROM registry.api.weibo.com/wecode/python:3.12-slim

# Set working directory
WORKDIR /app

# Copy requirements.txt and install dependencies
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt -i http://mirrors.cloud.aliyuncs.com/pypi/simple/ --trusted-host mirrors.cloud.aliyuncs.com

# Copy application code
COPY backend /app

# Create .env file (if it doesn't exist)
RUN if [ ! -f .env ]; then cp .env.example .env; fi

ENV PORT=8000
# Expose port
EXPOSE ${PORT}


# Start command
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 4"]