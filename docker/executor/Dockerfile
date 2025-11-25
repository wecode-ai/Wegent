# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Build stage: compile executor to standalone binary
FROM ghcr.io/wecode-ai/wegent-base-python3.12:1.0.0 AS builder

WORKDIR /app

RUN npm update -g @anthropic-ai/claude-code

# Copy requirements and install dependencies
COPY executor/requirements.txt /app/executor/requirements.txt

RUN wget https://www.sqlite.org/2025/sqlite-autoconf-3500400.tar.gz && \
    tar -xvf sqlite-autoconf-3500400.tar.gz && \
    cd sqlite-autoconf-3500400 && \
    ./configure --prefix=/usr/local && \
    make -j$(nproc) && \
    make install && \
    cd .. && \
    rm -rf sqlite-autoconf-3500400 sqlite-autoconf-3500400.tar.gz

ENV PATH="/usr/local/bin:${PATH}"
RUN yes|cp -rf /usr/local/lib/libsqlite3.so.3.50.4 /usr/lib64/libsqlite3.so.0.8.6 && \
    pip install -r /app/executor/requirements.txt -U

# Copy source code
COPY executor /app/executor
COPY shared /app/shared

# Build standalone binary
RUN cd /app/executor && bash build.sh

# Runtime stage: minimal image with only the binary
FROM ghcr.io/wecode-ai/wegent-base-python3.12:1.0.0

WORKDIR /app

RUN npm update -g @anthropic-ai/claude-code

# Install sqlite
RUN wget https://www.sqlite.org/2025/sqlite-autoconf-3500400.tar.gz && \
    tar -xvf sqlite-autoconf-3500400.tar.gz && \
    cd sqlite-autoconf-3500400 && \
    ./configure --prefix=/usr/local && \
    make -j$(nproc) && \
    make install && \
    cd .. && \
    rm -rf sqlite-autoconf-3500400 sqlite-autoconf-3500400.tar.gz

ENV PATH="/usr/local/bin:${PATH}"
RUN yes|cp -rf /usr/local/lib/libsqlite3.so.3.50.4 /usr/lib64/libsqlite3.so.0.8.6

# Copy only the standalone binary from builder
COPY --from=builder /app/executor/dist/executor /app/executor

ENV PORT=10001
ENV PYTHONPATH=/app

# Run the standalone binary
CMD ["/app/executor"]
