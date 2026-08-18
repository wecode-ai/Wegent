# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Optional Seedance asset-library staging for reference images."""

import asyncio
import logging
from typing import Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

_ASSET_URL_PREFIX = "asset://"
_ACTIVE_STATUS = "Active"


def asset_library_enabled() -> bool:
    """Return whether Seedance asset staging is configured."""
    return bool(
        settings.SEEDANCE_ASSET_GROUP_ID.strip()
        and settings.SEEDANCE_ASSET_BASE_URL.strip()
    )


def _asset_endpoint(action: str) -> str:
    return f"{settings.SEEDANCE_ASSET_BASE_URL.rstrip('/')}/{action}"


async def _create_asset(
    client: httpx.AsyncClient,
    image_url: str,
    wecode_user: str,
) -> tuple[Optional[str], bool]:
    response = await client.post(
        _asset_endpoint("CreateAsset"),
        json={
            "GroupId": settings.SEEDANCE_ASSET_GROUP_ID.strip(),
            "URL": image_url,
            "AssetType": "Image",
        },
        headers={
            "Content-Type": "application/json",
            "wecode-user": wecode_user,
        },
    )
    if response.status_code >= 400:
        logger.warning(
            "[SeedanceAsset] CreateAsset failed: status=%s, response=%s",
            response.status_code,
            response.text[:2000],
        )
        return None, False

    payload = response.json()
    asset_id = payload.get("Id") if isinstance(payload, dict) else None
    if not isinstance(asset_id, str) or not asset_id.strip():
        return None, False
    return asset_id.strip(), payload.get("Status") == _ACTIVE_STATUS


async def _wait_until_active(
    client: httpx.AsyncClient,
    asset_id: str,
    wecode_user: str,
) -> bool:
    interval = max(1, settings.SEEDANCE_ASSET_STATUS_POLL_INTERVAL_SECONDS)
    timeout = max(interval, settings.SEEDANCE_ASSET_STATUS_TIMEOUT_SECONDS)
    elapsed = 0

    while elapsed <= timeout:
        response = await client.post(
            _asset_endpoint("GetAsset"),
            json={"Id": asset_id},
            headers={
                "Content-Type": "application/json",
                "wecode-user": wecode_user,
            },
        )
        if response.status_code >= 400:
            logger.warning(
                "[SeedanceAsset] GetAsset failed: asset_id=%s, status=%s, response=%s",
                asset_id,
                response.status_code,
                response.text[:2000],
            )
            return False

        payload = response.json()
        if isinstance(payload, dict) and payload.get("Status") == _ACTIVE_STATUS:
            return True

        if elapsed + interval > timeout:
            break
        await asyncio.sleep(interval)
        elapsed += interval

    return False


async def _stage_image(
    client: httpx.AsyncClient,
    image_url: str,
    wecode_user: str,
) -> Optional[str]:
    try:
        asset_id, active = await _create_asset(client, image_url, wecode_user)
        if not asset_id:
            return None
        if not active and not await _wait_until_active(
            client,
            asset_id,
            wecode_user,
        ):
            logger.warning(
                "[SeedanceAsset] Asset did not become active: asset_id=%s",
                asset_id,
            )
            return None
        return f"{_ASSET_URL_PREFIX}{asset_id}"
    except Exception:
        logger.warning("[SeedanceAsset] Failed to stage reference image", exc_info=True)
        return None


async def prepare_seedance_reference_images(
    client: httpx.AsyncClient,
    reference_images: Optional[list],
    reference_image: Optional[str],
    wecode_user: Optional[str],
) -> tuple[Optional[list], Optional[str]]:
    """Replace HTTP image URLs with active Seedance asset URLs when configured."""
    if not asset_library_enabled() or not wecode_user:
        return reference_images, reference_image

    prepared_images: Optional[list] = None
    if reference_images:
        prepared_images = []
        for image in reference_images:
            if not isinstance(image, dict):
                continue
            prepared = dict(image)
            image_url = prepared.get("url")
            if isinstance(image_url, str) and image_url.startswith(
                ("http://", "https://")
            ):
                asset_url = await _stage_image(client, image_url, wecode_user)
                if asset_url:
                    prepared["url"] = asset_url
            prepared_images.append(prepared)

    prepared_reference_image = reference_image
    if prepared_images is None and isinstance(reference_image, str):
        if reference_image.startswith(("http://", "https://")):
            asset_url = await _stage_image(client, reference_image, wecode_user)
            if asset_url:
                prepared_reference_image = asset_url

    return prepared_images, prepared_reference_image
