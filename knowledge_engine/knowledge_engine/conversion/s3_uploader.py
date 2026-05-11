# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
S3-compatible storage uploader for converted document images.

Lazily initializes boto3 client. Thread-safe for Celery worker usage.
"""

import io
import logging
import threading
from dataclasses import dataclass
from typing import Any, Optional
from urllib.parse import quote

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class S3Config:
    """Configuration for S3 image storage."""

    enabled: bool = False
    endpoint: str = ""
    access_key: str = ""
    secret_key: str = ""
    bucket_name: str = ""
    region_name: str = "us-east-1"


class S3Uploader:
    """Lazy-initialized S3 client for image upload."""

    def __init__(self, config: S3Config):
        """Initialize S3Uploader with the given configuration."""
        self._config = config
        self._client = None
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        """Return whether S3 upload is enabled in the configuration."""
        return self._config.enabled

    def _get_client(self) -> Any:
        """Lazily initialize boto3 S3 client (thread-safe)."""
        if self._client is None:
            with self._lock:
                if self._client is None:
                    import boto3

                    self._client = boto3.client(
                        "s3",
                        endpoint_url=self._config.endpoint,
                        aws_access_key_id=self._config.access_key,
                        aws_secret_access_key=self._config.secret_key,
                        region_name=self._config.region_name,
                    )
                    logger.info(
                        f"[S3] Client initialized for endpoint: {self._config.endpoint}"
                    )
        return self._client

    def upload_image(
        self,
        image_data: bytes,
        object_name: str,
        content_type: str = "image/jpeg",
    ) -> Optional[str]:
        """
        Upload image to S3 and return the public URL.

        Args:
            image_data: Image binary data
            object_name: S3 object key (supports UTF-8 paths)
            content_type: MIME type of the image

        Returns:
            Public URL string, or None if upload fails
        """
        if not self._config.enabled:
            return None

        try:
            client = self._get_client()
            bucket = self._config.bucket_name

            client.upload_fileobj(
                io.BytesIO(image_data),
                bucket,
                object_name,
                ExtraArgs={"ContentType": content_type},
            )

            # URL-encode path segments for Chinese character support
            endpoint = self._config.endpoint.rstrip("/")
            if not endpoint:
                logger.warning(
                    f"[S3] Skipping URL generation for {object_name}: "
                    "endpoint is empty, cannot build valid public URL"
                )
                return None

            path_parts = object_name.split("/")
            encoded_parts = [quote(part, safe="") for part in path_parts]
            encoded_path = "/".join(encoded_parts)
            public_url = f"{endpoint}/{bucket}/{encoded_path}"

            logger.info(f"[S3] Uploaded: {object_name} -> {public_url}")
            return public_url

        except Exception as e:
            logger.error(f"[S3] Failed to upload {object_name}: {e}")
            return None
