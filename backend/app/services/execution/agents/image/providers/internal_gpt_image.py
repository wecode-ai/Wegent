# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""GPT Image provider for the internal image generation gateway."""

import base64
from typing import Any, Dict, List, Optional

import httpx

from .gpt_image import GptImageProvider

INTERNAL_GPT_IMAGE_PREFIX = "/v1/image_generate/openai"
INTERNAL_GPT_IMAGE_GENERATIONS_PATH = f"{INTERNAL_GPT_IMAGE_PREFIX}/images/generations"
INTERNAL_GPT_IMAGE_EDITS_PATH = f"{INTERNAL_GPT_IMAGE_PREFIX}/images/edits"


class InternalGptImageProvider(GptImageProvider):
    generations_path = INTERNAL_GPT_IMAGE_GENERATIONS_PATH
    edits_path = INTERNAL_GPT_IMAGE_EDITS_PATH

    @staticmethod
    def _normalize_base_url(base_url: Optional[str]) -> str:
        normalized = GptImageProvider._normalize_base_url(base_url)
        if normalized.endswith(INTERNAL_GPT_IMAGE_PREFIX):
            return normalized[: -len(INTERNAL_GPT_IMAGE_PREFIX)]
        return normalized

    async def _post_request(
        self,
        client: httpx.AsyncClient,
        url: str,
        payload: Dict[str, Any],
        references: List[str],
    ) -> httpx.Response:
        if references:
            payload["image"] = await self._normalize_reference_images(
                client, references
            )
        return await client.post(
            url=url,
            json=payload,
            headers=self._request_headers(),
        )

    def _request_headers(self, include_content_type: bool = True) -> Dict[str, str]:
        return {
            "Content-Type": "application/json",
            **self.default_headers,
        }

    @classmethod
    async def _normalize_reference_images(
        cls,
        client: httpx.AsyncClient,
        references: List[str],
    ) -> List[str]:
        images: List[str] = []
        for reference in references:
            if reference.startswith("data:"):
                images.append(reference)
                continue
            content, mime_type = await cls._load_reference_image(client, reference)
            encoded = base64.b64encode(content).decode("ascii")
            images.append(f"data:{mime_type};base64,{encoded}")
        return images
