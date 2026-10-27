FROM scratch
COPY wegent-backend-rs /app/wegent-backend-rs
COPY attachment-s3-e2e /app/attachment-s3-e2e
ENTRYPOINT ["/app/wegent-backend-rs"]
