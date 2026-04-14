# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helpers for managing persisted device display names."""

from typing import Any, Dict


def resolve_device_display_name(device_json: Dict[str, Any], fallback_name: str) -> str:
    """Return the persisted display name if present, otherwise the reported name."""
    spec = device_json.get("spec", {})
    metadata = device_json.get("metadata", {})
    return spec.get("displayName") or metadata.get("displayName") or fallback_name


def set_device_display_name(device_json: Dict[str, Any], display_name: str) -> None:
    """Write a device display name consistently into spec and metadata."""
    spec = device_json.setdefault("spec", {})
    spec["displayName"] = display_name

    metadata = device_json.setdefault("metadata", {})
    metadata["displayName"] = display_name
