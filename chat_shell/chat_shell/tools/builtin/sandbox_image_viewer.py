"""Sandbox file viewer tool for reading files from sandbox containers."""

import base64
import json
import logging
import mimetypes
import os
from typing import Any

import httpx
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

DEFAULT_EXECUTOR_MANAGER_URL = "http://localhost:8001"

# E2B envd runs on this port inside each sandbox container.
# Derived from e2b SDK: ConnectionConfig.envd_port = 49983
_E2B_ENVD_PORT = 49983

IMAGE_MIME_TYPES = frozenset(
    {
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/gif",
        "image/webp",
        "image/bmp",
        "image/tiff",
    }
)


class SandboxFileViewerInput(BaseModel):
    """Input schema for sandbox file viewer tool."""

    path: str = Field(
        description=(
            "Absolute file path in the sandbox (e.g., /home/user/image.png). "
            "Use this to view images or text files that have been downloaded or "
            "created in the sandbox."
        )
    )


class SandboxImageViewerTool(BaseTool):
    """Read a file from the sandbox container and return its content.

    For image files, returns the visual content so the model can see it.
    For text files, returns the text content.

    Chat Shell sandboxes are E2B containers accessed via the executor_manager
    E2B proxy at: /executor-manager/e2b/proxy/{sandbox_id}/{envd_port}/files
    The sandbox_id equals str(task_id).
    """

    name: str = "view_sandbox_file"
    display_name: str = "查看沙箱文件"
    description: str = (
        "Read a file from the sandbox filesystem. "
        "For images (jpg, png, gif, webp, etc.), returns the visual content so you can see it. "
        "For text files, returns the text content. "
        "Use this after downloading or creating a file in the sandbox to view its contents."
    )
    args_schema: type[BaseModel] = SandboxFileViewerInput

    task_id: int = 0
    executor_manager_url: str = DEFAULT_EXECUTOR_MANAGER_URL
    auth_token: str = ""

    def _run(self, path: str, **_) -> str:
        raise NotImplementedError(
            "SandboxImageViewerTool only supports async execution"
        )

    async def _arun(self, path: str, **_) -> str | list[dict[str, Any]]:
        headers = {}
        if self.auth_token:
            headers["Authorization"] = f"Bearer {self.auth_token}"

        sandbox_id = str(self.task_id)
        url = (
            f"{self.executor_manager_url}/executor-manager/e2b/proxy"
            f"/{sandbox_id}/{_E2B_ENVD_PORT}/files"
        )
        params = {"path": path}

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(url, params=params, headers=headers)

            if response.status_code == 404:
                return json.dumps({"error": f"File not found in sandbox: {path}"})

            response.raise_for_status()

            content_type = (
                response.headers.get("content-type", "").split(";")[0].strip()
            )

            # Infer MIME type from extension if content-type is too generic
            if not content_type or content_type == "application/octet-stream":
                guessed, _ = mimetypes.guess_type(path)
                if guessed:
                    content_type = guessed

            if content_type in IMAGE_MIME_TYPES:
                b64_data = base64.b64encode(response.content).decode("utf-8")
                return [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{content_type};base64,{b64_data}"},
                    }
                ]

            # Return as text
            try:
                return response.content.decode("utf-8")
            except UnicodeDecodeError:
                return response.content.decode("latin-1")

        except httpx.HTTPStatusError as e:
            logger.warning(
                "[SandboxImageViewerTool] HTTP error reading %s: %s", path, e
            )
            return json.dumps(
                {"error": f"HTTP {e.response.status_code} reading file: {path}"}
            )
        except Exception as e:
            logger.warning("[SandboxImageViewerTool] Failed to read %s: %s", path, e)
            return json.dumps({"error": str(e)})
