# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Canonical device-identity selection shared by route and device resolvers.

A logical Device CRD registers under a stable name, while queued executions
and deliveries may persist the desktop App registration id. Several active
Device CRDs can point at the same App installation (for example an ephemeral
verification device claiming the App's ``appDeviceId``). Resolvers must pick
one canonical device instead of failing on that ambiguity.
"""

from typing import Sequence

from app.models.kind import Kind
from app.schemas.device import DeviceType


def device_kind_type(device: Kind) -> DeviceType:
    """Read the persisted device type with a stable default."""

    spec = device.json.get("spec", {}) if isinstance(device.json, dict) else {}
    raw_type = spec.get("deviceType", DeviceType.LOCAL.value)
    try:
        return DeviceType(raw_type)
    except (TypeError, ValueError):
        return DeviceType.LOCAL


def preferred_device(matches: Sequence[Kind]) -> Kind | None:
    """Choose one canonical device among several sharing a single identity.

    ``appDeviceId`` belongs to a desktop App installation, so the App
    registration is authoritative when it collides with a non-App device
    (for example an ephemeral verification device that reused the App id).
    Two App registrations sharing the channel are genuinely ambiguous and stay
    unresolved rather than forwarding a run to an arbitrary installation.
    """

    if not matches:
        return None
    if len(matches) == 1:
        return matches[0]
    app_matches = [
        device for device in matches if device_kind_type(device) == DeviceType.APP
    ]
    if len(app_matches) == 1:
        return app_matches[0]
    return None
