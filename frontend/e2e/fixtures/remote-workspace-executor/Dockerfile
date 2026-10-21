ARG BASE_IMAGE
FROM ${BASE_IMAGE}

COPY wegent-executor /app/executor
RUN chmod 0755 /app/executor

ENV EXECUTOR_MODE=docker
ENV WORKSPACE_ROOT=/root/.wegent/workspace

CMD ["/app/executor"]
