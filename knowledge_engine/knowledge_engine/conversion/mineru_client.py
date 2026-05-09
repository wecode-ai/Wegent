# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
MinerU API client for document-to-Markdown conversion.

Responsibilities:
- Submit document conversion tasks to MinerU API
- Poll task status until completion
- Download conversion result (ZIP file)

No framework dependencies — pure HTTP client using httpx.
"""

import asyncio
import logging
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class MinerUConfig:
    """Configuration for MinerU API."""

    api_base_url: str
    backend: str = "pipeline"
    parse_method: str = "ocr"
    lang_list: str = "ch"
    formula_enable: bool = True
    table_enable: bool = True
    poll_interval_seconds: int = 3
    max_wait_seconds: int = 600


# Supported MIME types for conversion
SUPPORTED_MIME_TYPES = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "doc": "application/msword",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "ppt": "application/vnd.ms-powerpoint",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xls": "application/vnd.ms-excel",
}


def is_supported_extension(ext: str) -> bool:
    """Check if file extension is supported for conversion."""
    return ext.lstrip(".").lower() in SUPPORTED_MIME_TYPES


async def submit_and_wait(
    binary_data: bytes,
    file_extension: str,
    config: MinerUConfig,
) -> bytes:
    """
    Submit document to MinerU and wait for result ZIP.

    Args:
        binary_data: Document binary content
        file_extension: Extension without dot (e.g., "pdf")
        config: MinerU API configuration

    Returns:
        ZIP file binary content from MinerU

    Raises:
        RuntimeError: If submission, polling, or download fails
    """
    ext = file_extension.lstrip(".").lower()
    mime_type = SUPPORTED_MIME_TYPES.get(ext, "application/octet-stream")
    filename = f"document.{ext}"
    base_url = config.api_base_url.rstrip("/")

    async with httpx.AsyncClient() as client:
        task_id = await _submit_task(
            client, base_url, filename, binary_data, mime_type, config
        )
        await _poll_until_done(client, base_url, task_id, config)
        return await _download_result(client, base_url, task_id)


async def _submit_task(
    client: httpx.AsyncClient,
    base_url: str,
    filename: str,
    binary_data: bytes,
    mime_type: str,
    config: MinerUConfig,
) -> str:
    """Submit conversion task to MinerU API."""
    submit_url = f"{base_url}/tasks"
    data = {
        "backend": config.backend,
        "parse_method": config.parse_method,
        "lang_list": config.lang_list,
        "formula_enable": "true" if config.formula_enable else "false",
        "table_enable": "true" if config.table_enable else "false",
        "return_md": "true",
        "return_images": "true",
        "response_format_zip": "true",
    }
    files = {"files": (filename, binary_data, mime_type)}

    logger.info(f"[MinerU] Submitting task to {submit_url}")
    response = await client.post(submit_url, data=data, files=files, timeout=60.0)
    response.raise_for_status()

    result = response.json()
    task_id = result.get("task_id") if isinstance(result, dict) else result.strip('"')
    logger.info(f"[MinerU] Task submitted: {task_id}")
    return task_id


async def _poll_until_done(
    client: httpx.AsyncClient,
    base_url: str,
    task_id: str,
    config: MinerUConfig,
) -> None:
    """Poll MinerU task status until completion."""
    start_time = asyncio.get_running_loop().time()

    while True:
        elapsed = asyncio.get_running_loop().time() - start_time
        if elapsed > config.max_wait_seconds:
            raise RuntimeError(
                f"MinerU task timeout after {config.max_wait_seconds}s: {task_id}"
            )

        try:
            status_url = f"{base_url}/tasks/{task_id}"
            status_resp = await client.get(status_url, timeout=10.0)
            status_resp.raise_for_status()

            status_data = status_resp.json()
            status = (
                status_data.get("status", "").lower()
                if isinstance(status_data, dict)
                else status_data.strip('"').lower()
            )

            if status in ("completed", "done", "success"):
                logger.info(f"[MinerU] Task completed: {task_id}")
                return
            elif status in ("failed", "error"):
                raise RuntimeError(f"MinerU task failed: {task_id}")
            else:
                logger.debug(f"[MinerU] Task status: {status}, waiting...")
                await asyncio.sleep(config.poll_interval_seconds)
        except RuntimeError:
            raise
        except Exception as e:
            logger.warning(f"[MinerU] Status check error: {e}")
            await asyncio.sleep(config.poll_interval_seconds)


async def _download_result(
    client: httpx.AsyncClient,
    base_url: str,
    task_id: str,
) -> bytes:
    """Download conversion result ZIP from MinerU."""
    result_url = f"{base_url}/tasks/{task_id}/result"
    logger.info(f"[MinerU] Downloading result from {result_url}")

    result_resp = await client.get(result_url, timeout=120.0)
    result_resp.raise_for_status()

    content_type = result_resp.headers.get("content-type", "")
    if "application/json" in content_type:
        raise RuntimeError("MinerU returned JSON instead of ZIP")

    return result_resp.content
