# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

FROM registry.api.weibo.com/wecode/wegent-base-python3.12:1.0.0
WORKDIR /app/executor_manager

COPY executor_manager/requirements.txt /app/executor_manager/requirements.txt
RUN pip install -r /app/executor_manager/requirements.txt -i http://mirrors.cloud.aliyuncs.com/pypi/simple/ --trusted-host mirrors.cloud.aliyuncs.com

ENV PYTHONPATH=/app
COPY executor_manager /app/executor_manager
COPY shared /app/shared

ENV PORT=9081
ENTRYPOINT ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-9081}"]