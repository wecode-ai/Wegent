ARG BASE_IMAGE
FROM ${BASE_IMAGE}

RUN useradd --system --user-group --create-home --shell /bin/bash wegent
COPY executor /app/executor
COPY codex /usr/local/bin/codex
COPY connection-runtime /opt/wegent/connection-runtime
RUN chmod 0755 /app/executor /usr/local/bin/codex \
    && mkdir -p /home/wegent/.wecode/wegent-executor/bin /home/wegent/.wegent \
    && cp /app/executor /home/wegent/.wecode/wegent-executor/bin/wegent-executor \
    && ln -s /opt/wegent/connection-runtime /app/connection-runtime \
    && ln -s /opt/wegent/connection-runtime /home/wegent/.wecode/wegent-executor/bin/connection-runtime \
    && chown -R wegent:wegent /app /home/wegent
ENV HOME=/home/wegent
USER wegent
CMD ["/app/executor"]
