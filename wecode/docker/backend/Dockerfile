# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

FROM registry.api.weibo.com/wecode/python:3.12-slim

# Set working directory
WORKDIR /app

# Install tzdata and set timezone to Shanghai
RUN apt-get update && apt-get install -y tzdata && \
    ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

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