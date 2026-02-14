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

# Copy and install shared module first
COPY shared /app/shared
RUN uv pip install --system --no-cache /app/shared

# OpenTelemetry configuration
ENV OTEL_ENABLED=true
ENV OTEL_MAX_BODY_SIZE=1048576
ENV OTEL_CAPTURE_REQUEST_HEADERS=true
ENV OTEL_CAPTURE_REQUEST_BODY=true
ENV OTEL_TRACES_SAMPLER_ARG=1.0
ENV OTEL_EXPORTER_OTLP_ENDPOINT=http://wegent-otel-web.wb-plat-ide.svc.cluster.local:4317

# Copy pyproject.toml and install dependencies
# Remove wegent-shared line as it's already installed
COPY executor_manager/pyproject.toml /app/executor_manager/pyproject.toml
RUN cd /app/executor_manager && \
    sed -i '/wegent-shared.*file:/d' pyproject.toml && \
    uv pip install --system --no-cache -r pyproject.toml

ENV EXECUTOR_ENV='{"DEFAULT_HEADERS":{"wecode-user":"${task_data.user.name}","wecode-action":"wegent","wecode-executor":"agno","wecode-model-id":"${agent_config.env.model_id}"}}'

ENV REDIS_URL=redis://:fpxsHjf3m0Bh4SIA@rm48958.eos.grid.sina.com.cn:48958/0
ENV E2B_API_KEY=kucvaN-qowmax-kyvni7
ENV EXECUTOR_MANAGER_EXTERNAL_URL=http://wegent-executor-manager-web.wb-plat-ide.svc.cluster.local:8080
ENV PYTHONPATH=/app
ENV LITELLM_LOCAL_MODEL_COST_MAP=True
COPY executor_manager /app/executor_manager
COPY shared /app/shared

ENV PORT=9081
ENTRYPOINT ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-9081}"]