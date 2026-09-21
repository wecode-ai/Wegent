# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal Runtime desktop capability contract."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.schemas.device import register_runtime_feature_normalizer


class RuntimeDesktopFeatures(BaseModel):
    """Live RFB desktop capability exposed by a cloud Runtime."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    version: int = Field(..., ge=1)
    available: bool
    protocol: Literal["rfb"]
    transport: Literal["websocket"]
    clipboard: Literal["none", "text", "extended-text"] = "none"


def normalize_desktop_feature(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    try:
        return RuntimeDesktopFeatures.model_validate(value).model_dump()
    except ValidationError:
        return None


register_runtime_feature_normalizer("desktop", normalize_desktop_feature)
