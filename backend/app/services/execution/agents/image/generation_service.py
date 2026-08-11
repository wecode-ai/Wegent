# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Image generation service used by the MCP tool."""

import time
import uuid
from copy import deepcopy
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.mcp_server.auth import TaskTokenInfo
from app.services.context import context_service
from app.services.execution.agents.generation_context import (
    resolve_generation_context,
    resolve_generation_model,
)
from app.services.execution.agents.video.materials import (
    normalize_reference_materials,
)

from .attachment_uploader import upload_image_attachment
from .providers import get_image_provider


class ImageGenerationService:
    async def generate(
        self,
        db: Session,
        token_info: TaskTokenInfo,
        prompt: str,
        size: Optional[str] = None,
        max_images: int = 1,
        reference_images: Optional[list[str | int]] = None,
    ) -> dict[str, Any]:
        """Generate images with the current or first available image model."""
        prompt_text = (prompt or "").strip()
        if not prompt_text:
            raise ValueError("prompt is required")
        if max_images < 1 or max_images > 15:
            raise ValueError("max_images must be between 1 and 15")

        context = resolve_generation_context(db, token_info, prompt_text)
        model_config = deepcopy(
            resolve_generation_model(db, context, prompt_text, "image")
        )
        image_config = dict(model_config.get("imageConfig") or {})
        image_config["max_images"] = max_images
        image_config["sequential_image_generation"] = (
            "auto" if max_images > 1 else "disabled"
        )
        if size and size.strip():
            image_config["size"] = size.strip()
        model_config["imageConfig"] = image_config

        descriptors = normalize_reference_materials(
            db,
            reference_images,
            "image",
            token_info.user_id,
        )
        self._validate_reference_images(image_config, descriptors)

        protocol = model_config.get("protocol") or "seedream"
        result = await get_image_provider(protocol, model_config).generate(
            prompt=prompt_text,
            reference_images=[item["url"] for item in descriptors],
        )
        if not result.images:
            raise ValueError("No images generated")

        images: list[dict[str, Any]] = []
        image_urls: list[str] = []
        attachment_ids: list[int] = []
        output_format = image_config.get("output_format") or (
            "png" if protocol == "gpt-image" else "jpeg"
        )
        mime_subtype = "jpeg" if output_format == "jpg" else output_format

        for index, image in enumerate(result.images):
            image_url = image.url
            if not image_url and image.b64_json:
                image_url = f"data:image/{mime_subtype};base64,{image.b64_json}"
            if not image_url:
                continue
            attachment_id = await upload_image_attachment(
                image_url=image_url,
                image_size=image.size,
                user_id=token_info.user_id,
                task_id=token_info.task_id,
                subtask_id=token_info.subtask_id,
                index=index,
            )
            persisted_url = context_service.build_attachment_url(attachment_id)
            image_urls.append(persisted_url)
            attachment_ids.append(attachment_id)
            images.append(
                {
                    "url": persisted_url,
                    "size": image.size,
                    "attachment_id": attachment_id,
                }
            )

        if not images:
            raise ValueError("No valid images generated")

        result_data = {
            "value": "Image generation completed",
            "blocks": [
                {
                    "id": f"image-{uuid.uuid4().hex[:8]}",
                    "type": "image",
                    "status": "done",
                    "is_placeholder": False,
                    "image_urls": image_urls,
                    "image_attachment_ids": attachment_ids,
                    "image_count": len(image_urls),
                    "timestamp": int(time.time() * 1000),
                }
            ],
            "usage": result.usage,
        }
        return {
            "type": "images",
            "succ": 1,
            "status": "completed",
            "message": "Image generation completed",
            "model": result.model,
            "images": images,
            "persisted": True,
            "result_data": result_data,
        }

    @staticmethod
    def _validate_reference_images(
        image_config: dict[str, Any],
        descriptors: list[dict[str, Any]],
    ) -> None:
        if not descriptors:
            return
        capabilities = image_config.get("capabilities") or {}
        if capabilities.get("supports_image_input") is False:
            raise ValueError("This model does not support reference images")
        limit = capabilities.get("max_reference_images")
        if limit is None:
            limit = image_config.get("max_reference_images")
        if isinstance(limit, int) and limit >= 0 and len(descriptors) > limit:
            raise ValueError(f"Too many reference images: {len(descriptors)} > {limit}")
        allowed_formats = {
            str(value).lower().lstrip(".")
            for value in capabilities.get("image_formats") or []
        }
        for descriptor in descriptors:
            extension = str(descriptor.get("file_extension") or "").lower().lstrip(".")
            normalized_extension = "jpeg" if extension == "jpg" else extension
            normalized_allowed = {
                "jpeg" if value == "jpg" else value for value in allowed_formats
            }
            if (
                normalized_allowed
                and normalized_extension
                and normalized_extension not in normalized_allowed
            ):
                raise ValueError(f"Unsupported reference image format: {extension}")


image_generation_service = ImageGenerationService()
