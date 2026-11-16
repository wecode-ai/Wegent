ARG BASE_IMAGE
FROM ${BASE_IMAGE}

RUN useradd --system --user-group --create-home --shell /bin/bash wegent
COPY executor /app/executor
COPY codex /opt/wegent/codex
COPY connection-runtime /opt/wegent/connection-runtime
RUN chmod 0755 /app/executor \
    && find /opt/wegent/codex -type f -path '*/bin/*' -exec chmod 0755 {} + \
    && test -x /opt/wegent/codex/vendor/x86_64-unknown-linux-musl/bin/codex \
    && test -x /opt/wegent/codex/vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host \
    && ln -s /opt/wegent/codex/vendor/x86_64-unknown-linux-musl/bin/codex /usr/local/bin/codex \
    && mkdir -p /home/wegent/.wecode/wegent-executor/bin /home/wegent/.wegent \
    && cp /app/executor /home/wegent/.wecode/wegent-executor/bin/wegent-executor \
    && ln -s /opt/wegent/connection-runtime /app/connection-runtime \
    && ln -s /opt/wegent/connection-runtime /home/wegent/.wecode/wegent-executor/bin/connection-runtime \
    && chown -R wegent:wegent /app /home/wegent
ENV HOME=/home/wegent
USER wegent
CMD ["/app/executor"]
