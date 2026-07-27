# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any, Dict, Optional

from pydantic import ValidationError

from app.schemas.kind import ModelCapabilities


def normalize_model_capabilities(value: Any) -> Optional[Dict[str, bool]]:
    """Normalize legacy capability data to the canonical response shape."""
    if not isinstance(value, dict):
        return None

    try:
        normalized = ModelCapabilities.model_validate(value, strict=True).model_dump(
            exclude_none=True
        )
    except ValidationError:
        return None

    return normalized or None
