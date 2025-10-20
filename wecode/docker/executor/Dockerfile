# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

FROM registry.api.weibo.com/wecode/wegent-base-python3.12:1.0.1-java-support

WORKDIR /app/executor

RUN npm update -g @anthropic-ai/claude-code
COPY executor/requirements.txt /app/executor/requirements.txt

RUN wget https://www.sqlite.org/2025/sqlite-autoconf-3500400.tar.gz && \
    tar -xvf sqlite-autoconf-3500400.tar.gz && \
    cd sqlite-autoconf-3500400 && \
    ./configure --prefix=/usr/local && \
    make -j$(nproc) && \
    make install && \
    cd .. && \
    rm -rf sqlite-autoconf-3500400 sqlite-autoconf-3500400.tar.gz

# 安装 glab 命令行工具
RUN wget -O glab_1.74.0_linux_amd64.rpm "https://gitlab.com/gitlab-org/cli/-/releases/v1.74.0/downloads/glab_1.74.0_linux_amd64.rpm" \
 && dnf install -y glab_1.74.0_linux_amd64.rpm \
 && rm -rf glab_1.74.0_linux_amd64.rpm \
 && dnf clean all \
 && glab --version

# 设置 claude code 环境变量
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
ENV CLAUDE_CODE_INCLUDE_CO_AUTHORED_BY="false"

# 设置环境变量
ENV PATH="/usr/local/bin:${PATH}"
RUN yes|cp -rf /usr/local/lib/libsqlite3.so.3.50.4 /usr/lib64/libsqlite3.so.0.8.6 && pip install -r /app/executor/requirements.txt -i http://mirrors.cloud.aliyuncs.com/pypi/simple/ --trusted-host mirrors.cloud.aliyuncs.com
ENV PORT=10001
ENV PYTHONPATH=/app
COPY backend/wecode /app/wecode
COPY wecode/docker/executor/claude_hooks.json /app/config/claude_hooks.json
COPY executor /app/executor
COPY shared /app/shared
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT} --reload"]
