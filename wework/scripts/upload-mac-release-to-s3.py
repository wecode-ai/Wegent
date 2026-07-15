from __future__ import annotations

import mimetypes
import os
from pathlib import Path
from urllib.parse import urlparse

from minio import Minio


def require_env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


def create_client(endpoint: str) -> Minio:
    parsed = urlparse(endpoint)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise SystemExit(f"Invalid ATTACHMENT_S3_ENDPOINT: {endpoint}")
    if parsed.path not in {"", "/"}:
        raise SystemExit("ATTACHMENT_S3_ENDPOINT must not include an object path")

    return Minio(
        parsed.netloc,
        access_key=require_env("ATTACHMENT_S3_ACCESS_KEY"),
        secret_key=require_env("ATTACHMENT_S3_SECRET_KEY"),
        secure=parsed.scheme == "https",
        region=os.environ.get("ATTACHMENT_S3_REGION", "us-east-1"),
    )


def storage_key(prefix: str, filename: str) -> str:
    return "/".join(part for part in (prefix.strip("/"), filename) if part)


def upload_file(
    client: Minio,
    bucket: str,
    prefix: str,
    path: Path,
    cache_control: str,
) -> None:
    object_name = storage_key(prefix, path.name)
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    client.fput_object(
        bucket,
        object_name,
        str(path),
        content_type=content_type,
        metadata={"Cache-Control": cache_control},
    )
    print(f"Uploaded: s3://{bucket}/{object_name}")


def main() -> None:
    client = create_client(require_env("ATTACHMENT_S3_ENDPOINT"))
    bucket = require_env("ATTACHMENT_S3_BUCKET")
    prefix = os.environ.get("WEWORK_RELEASE_S3_PREFIX", "wework/macos")
    version = require_env("RELEASE_VERSION")
    output_dir = Path(require_env("RELEASE_OUTPUT_DIR"))

    if not client.bucket_exists(bucket):
        raise SystemExit(f"S3 bucket does not exist: {bucket}")

    artifacts = sorted(output_dir.glob(f"WeWork_{version}_*"))
    if not artifacts:
        raise SystemExit(f"No release artifacts found for version {version}")
    for artifact in artifacts:
        upload_file(
            client,
            bucket,
            prefix,
            artifact,
            "public, max-age=31536000, immutable",
        )

    manifest = output_dir / "latest.json"
    if not manifest.is_file():
        raise SystemExit(f"Updater manifest not found: {manifest}")
    upload_file(client, bucket, prefix, manifest, "no-cache, no-store")
    print("Uploaded latest.json last so clients never observe a partial release.")


if __name__ == "__main__":
    main()
