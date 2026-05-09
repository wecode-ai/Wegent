# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Extract Markdown and images from MinerU result ZIP.

Handles:
- Finding .md files in ZIP
- Extracting images and uploading to S3
- Replacing image references in Markdown with S3 URLs
"""

import io
import logging
import os
import re
import zipfile
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

from knowledge_engine.conversion.s3_uploader import S3Uploader

logger = logging.getLogger(__name__)

# Image extensions recognized in ZIP
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".tiff")

# Content type mapping
CONTENT_TYPE_MAP = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
}


@dataclass
class ExtractionResult:
    """Result of ZIP extraction."""

    markdown_bytes: bytes
    uploaded_images: List[Tuple[str, str]] = field(default_factory=list)


def extract_markdown_from_zip(
    zip_content: bytes,
    s3_uploader: Optional[S3Uploader] = None,
    s3_base_path: Optional[str] = None,
) -> ExtractionResult:
    """
    Extract markdown from MinerU result ZIP.

    If s3_uploader is provided and enabled, images will be uploaded
    and markdown references replaced with S3 URLs.

    Args:
        zip_content: ZIP binary content
        s3_uploader: Optional S3 uploader instance
        s3_base_path: Base path for S3 object keys (e.g., "kb_name/doc_name")

    Returns:
        ExtractionResult with markdown bytes and uploaded image list
    """
    uploaded_images: List[Tuple[str, str]] = []

    try:
        with zipfile.ZipFile(io.BytesIO(zip_content)) as z:
            md_files = [f for f in z.namelist() if f.endswith(".md")]
            if not md_files:
                raise RuntimeError("No markdown file found in MinerU result")

            md_file = md_files[0]
            logger.info(f"[MinerU] Extracting markdown: {md_file}")
            content = z.read(md_file).decode("utf-8")

            if s3_uploader and s3_uploader.enabled and s3_base_path:
                content, uploaded_images = _process_images(
                    z, content, s3_uploader, s3_base_path
                )

            return ExtractionResult(
                markdown_bytes=content.encode("utf-8"),
                uploaded_images=uploaded_images,
            )

    except zipfile.BadZipFile:
        raise RuntimeError("Invalid ZIP file from MinerU result")


def _process_images(
    z: zipfile.ZipFile,
    content: str,
    s3_uploader: S3Uploader,
    s3_base_path: str,
) -> Tuple[str, List[Tuple[str, str]]]:
    """Process and upload images from ZIP, replacing references in markdown."""
    uploaded_images: List[Tuple[str, str]] = []

    all_image_files = [f for f in z.namelist() if f.lower().endswith(IMAGE_EXTENSIONS)]
    logger.info(f"[S3] Found {len(all_image_files)} images in ZIP")

    def _find_image_in_zip(img_path: str) -> Optional[str]:
        """Try multiple path strategies to find image in ZIP."""
        candidates = [
            img_path,
            f"./{img_path}",
            os.path.basename(img_path),
        ]
        if not img_path.startswith("document/"):
            candidates.extend(
                [
                    f"document/{img_path}",
                    f"document/ocr/{img_path}",
                ]
            )
        if "/" in img_path:
            basename = os.path.basename(img_path)
            for zip_path in z.namelist():
                if zip_path.endswith(img_path) or zip_path.endswith(basename):
                    if zip_path not in candidates:
                        candidates.append(zip_path)

        seen = set()
        for c in candidates:
            if c in seen:
                continue
            seen.add(c)
            if c in z.namelist():
                return c
        return None

    def _upload_single_image(zip_path: str) -> Optional[str]:
        """Upload a single image from ZIP to S3."""
        try:
            img_data = z.read(zip_path)
            ext = os.path.splitext(zip_path)[1].lower()
            content_type = CONTENT_TYPE_MAP.get(ext, "image/jpeg")
            s3_object_name = f"{s3_base_path}/{zip_path}"
            url = s3_uploader.upload_image(img_data, s3_object_name, content_type)
            if url:
                uploaded_images.append((zip_path, url))
            return url
        except Exception as e:
            logger.warning(f"[S3] Failed to process image {zip_path}: {e}")
            return None

    # Replace markdown image references: ![alt](path)
    md_img_pattern = r"!\[([^\]]*)\]\(([^)]+)\)"

    def replace_md_ref(match):
        alt_text = match.group(1)
        img_path = match.group(2)
        if img_path.startswith(("http://", "https://")):
            return match.group(0)
        img_path = img_path.lstrip("./").lstrip("/")
        zip_path = _find_image_in_zip(img_path)
        if zip_path:
            url = _upload_single_image(zip_path)
            if url:
                return f"![{alt_text}]({url})"
        return match.group(0)

    content = re.sub(md_img_pattern, replace_md_ref, content)

    # Replace HTML img tags: <img src="path" ...>
    html_img_pattern = r'<img[^>]+src=["\']([^"\']+)["\'][^>]*>'

    def replace_html_ref(match):
        img_path = match.group(1)
        if img_path.startswith(("http://", "https://")):
            return match.group(0)
        img_path = img_path.lstrip("./").lstrip("/")
        zip_path = _find_image_in_zip(img_path)
        if zip_path:
            url = _upload_single_image(zip_path)
            if url:
                return match.group(0).replace(match.group(1), url)
        return match.group(0)

    content = re.sub(html_img_pattern, replace_html_ref, content, flags=re.IGNORECASE)

    logger.info(f"[S3] Uploaded {len(uploaded_images)} images for: {s3_base_path}")
    return content, uploaded_images
