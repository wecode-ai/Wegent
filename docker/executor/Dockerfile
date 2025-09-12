# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

FROM ghcr.io/wecode-ai/wegent-base-python3.12:1.0.0

WORKDIR /app/executor

RUN claude update
COPY executor/requirements.txt /app/executor/requirements.txt
RUN pip install -r /app/executor/requirements.txt -U

ENV PYTHONPATH=/app
COPY executor /app/executor
COPY shared /app/shared
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT} --reload"]