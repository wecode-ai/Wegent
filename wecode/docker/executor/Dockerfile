# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

FROM registry.api.weibo.com/ci/wegent-runtime:0.0.2-update-executor-base-image

WORKDIR /app/executor

RUN npm update -g @anthropic-ai/claude-code
COPY executor/requirements.txt /app/executor/requirements.txt

# Set claude code environment variables
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
ENV CLAUDE_CODE_INCLUDE_CO_AUTHORED_BY="false"

# Set environment variables
ENV PATH="/usr/local/bin:${PATH}"
RUN pip install -r /app/executor/requirements.txt -i http://mirrors.cloud.aliyuncs.com/pypi/simple/ --trusted-host mirrors.cloud.aliyuncs.com
ENV PORT=10001
ENV PYTHONPATH=/app
ENV CUSTOM_CONFIG='{"wecode_config": "executor.wecode.config.config.WeCodeConfig"}'
COPY claude_hooks.json /app/config/claude_hooks.json
COPY file_change_sender.py /app/scripts/file_change_sender.py
COPY executor /app/executor
COPY shared /app/shared
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]

