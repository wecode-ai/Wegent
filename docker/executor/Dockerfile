# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

FROM ghcr.io/wecode-ai/wegent-base-python3.12:1.0.0

WORKDIR /app/executor

RUN claude update
COPY executor/requirements.txt /app/executor/requirements.txt

RUN wget https://www.sqlite.org/2025/sqlite-autoconf-3500400.tar.gz && \
    tar -xvf sqlite-autoconf-3500400.tar.gz && \
    cd sqlite-autoconf-3500400 && \
    ./configure --prefix=/usr/local && \
    make -j$(nproc) && \
    make install && \
    cd .. && \
    rm -rf sqlite-autoconf-3500400 sqlite-autoconf-3500400.tar.gz

# 设置环境变量
ENV PATH="/usr/local/bin:${PATH}"
RUN yes|cp -rf /usr/local/lib/libsqlite3.so.3.50.4 /usr/lib64/libsqlite3.so.0.8.6 && pip install -r /app/executor/requirements.txt -U
ENV PORT=10001
ENV PYTHONPATH=/app
COPY executor /app/executor
COPY shared /app/shared
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT} --reload"]