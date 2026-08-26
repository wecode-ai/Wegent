#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Verify video-image upload and public download through Aliyun OSS."""

from __future__ import annotations

import argparse
import base64
import hashlib
import mimetypes
import sys
import uuid
from pathlib import Path
from urllib.parse import quote, urlsplit

import httpx
import oss2

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from wecode.video.config.image_staging import (  # noqa: E402
    VideoImageStagingSettings,
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "image",
        nargs="?",
        type=Path,
        help="Local image to upload; defaults to a generated 1x1 PNG",
    )
    parser.add_argument(
        "--public-endpoint",
        help="Override VIDEO_MODEL_IMAGE_OSS_PUBLIC_ENDPOINT",
    )
    parser.add_argument(
        "--referer",
        help="Referer header expected by the Bucket anti-hotlink whitelist",
    )
    parser.add_argument(
        "--expires",
        type=int,
        default=300,
        help="Signed download URL lifetime in seconds (default: 300)",
    )
    parser.add_argument(
        "--keep",
        action="store_true",
        help="Keep the uploaded test object",
    )
    return parser.parse_args()


def _read_image(path: Path | None) -> tuple[bytes, str, str]:
    if path is None:
        data = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNg"
            "YAAAAAMAASsJTYQAAAAASUVORK5CYII="
        )
        return data, "image/png", ".png"

    path = path.expanduser().resolve()
    if not path.is_file():
        raise ValueError(f"Image does not exist: {path}")
    mime_type = mimetypes.guess_type(path.name)[0] or ""
    if not mime_type.startswith("image/"):
        raise ValueError(f"File is not recognized as an image: {path}")
    return path.read_bytes(), mime_type, path.suffix.lower() or ".img"


def _download_url(
    upload_bucket: oss2.Bucket,
    public_endpoint: str,
    object_key: str,
    expires: int,
) -> str:
    if public_endpoint:
        object_path = quote(object_key, safe="/")
        return f"{public_endpoint.rstrip('/')}/{object_path}"
    return upload_bucket.sign_url("GET", object_key, expires)


def _print_referer_config(bucket: oss2.Bucket) -> None:
    config = bucket.get_bucket_referer()
    print(f"Allow empty Referer: {config.allow_empty_referer}")
    print(f"Referer whitelist: {config.referers}")
    print(f"Referer blacklist: {config.black_referers}")


def _download(url: str, referer: str | None) -> httpx.Response:
    headers = {"Referer": referer} if referer else {}
    return httpx.get(
        url,
        headers=headers,
        timeout=30.0,
        follow_redirects=True,
    )


def _print_response(label: str, response: httpx.Response, source_sha256: str) -> bool:
    downloaded_sha256 = hashlib.sha256(response.content).hexdigest()
    content_type = response.headers.get("content-type", "")
    valid = (
        response.status_code == 200
        and content_type.lower().startswith("image/")
        and downloaded_sha256 == source_sha256
    )
    print(f"{label} status: {response.status_code}")
    print(f"{label} Content-Type: {content_type}")
    print(f"{label} SHA-256 match: {downloaded_sha256 == source_sha256}")
    return valid


def main() -> int:
    args = _parse_args()
    settings = VideoImageStagingSettings()
    data, mime_type, suffix = _read_image(args.image)
    source_sha256 = hashlib.sha256(data).hexdigest()

    auth = oss2.Auth(
        settings.VIDEO_MODEL_IMAGE_OSS_ACCESS_KEY_ID,
        settings.VIDEO_MODEL_IMAGE_OSS_ACCESS_KEY_SECRET,
    )
    upload_bucket = oss2.Bucket(
        auth,
        settings.VIDEO_MODEL_IMAGE_OSS_ENDPOINT,
        settings.VIDEO_MODEL_IMAGE_OSS_BUCKET,
    )
    public_endpoint = (
        args.public_endpoint
        if args.public_endpoint is not None
        else settings.VIDEO_MODEL_IMAGE_OSS_PUBLIC_ENDPOINT
    ).strip()
    _print_referer_config(upload_bucket)

    prefix = settings.VIDEO_MODEL_IMAGE_OSS_PREFIX.strip("/")
    object_key = f"{prefix}/{uuid.uuid4().hex}/{uuid.uuid4().hex}{suffix}"

    print(f"Uploading: bucket={settings.VIDEO_MODEL_IMAGE_OSS_BUCKET}")
    print(f"Object key: {object_key}")
    upload_bucket.put_object(
        object_key,
        data,
        headers={"Content-Type": mime_type},
    )

    try:
        download_url = _download_url(
            upload_bucket,
            public_endpoint,
            object_key,
            args.expires,
        )
        parsed = urlsplit(download_url)
        if parsed.query:
            print(
                f"Signed OSS URL: "
                f"{parsed.scheme}://{parsed.netloc}{parsed.path}?<redacted>"
            )
        else:
            print(f"CDN URL: {parsed.scheme}://{parsed.netloc}{parsed.path}")

        response = _download(download_url, args.referer)
        label = "Configured Referer" if args.referer else "Empty Referer"
        valid = _print_response(label, response, source_sha256)
        if args.referer:
            empty_response = _download(download_url, None)
            _print_response("Empty Referer", empty_response, source_sha256)

        print("Result: PASS" if valid else "Result: FAIL")
        return 0 if valid else 1
    finally:
        if args.keep:
            print("Uploaded object retained because --keep was specified")
        else:
            upload_bucket.delete_object(object_key)
            print("Uploaded test object deleted")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, oss2.exceptions.OssError, httpx.HTTPError) as exc:
        print(f"Verification failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
