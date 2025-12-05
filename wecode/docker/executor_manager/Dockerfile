# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

FROM registry.api.weibo.com/ci/wegent-runtime:0.0.2-update-executor-base-image

WORKDIR /app/executor_manager
# Install uv from PyPI using Aliyun mirror
RUN pip install --no-cache-dir uv -i http://mirrors.cloud.aliyuncs.com/pypi/simple/ --trusted-host mirrors.cloud.aliyuncs.com && \
    uv --version

# Configure uv to use Aliyun PyPI mirror
ENV UV_INDEX_URL="http://mirrors.cloud.aliyuncs.com/pypi/simple/"
ENV UV_EXTRA_INDEX_URL=""

# Copy pyproject.toml and install dependencies
COPY executor_manager/pyproject.toml /app/executor_manager/pyproject.toml
RUN cd /app/executor_manager && uv pip install --system --no-cache -r pyproject.toml

ENV EXECUTOR_ENV='{"DEFAULT_HEADERS":{"wecode-user":"${task_data.user.name}","wecode-action":"wegent","wecode-executor":"agno","wecode-model-id":"${agent_config.env.model_id}"}}'

ENV PYTHONPATH=/app
COPY executor_manager /app/executor_manager
COPY shared /app/shared

ENV PORT=9081
ENTRYPOINT ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-9081}"]