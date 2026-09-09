# SPDX-License-Identifier: Apache-2.0
"""Read host-validated, non-secret configuration for local auth callbacks."""

from __future__ import annotations

import json
import os
import re

from .transport import AuthError, _unique_object


def local_configuration() -> dict[str, str]:
    """Return declared local settings; never merge them into process environment."""
    raw = os.environ.get("WEGENT_PLUGIN_AUTH_LOCAL_CONFIGURATION")
    if raw is None:
        return {}
    try:
        if len(raw.encode("utf-8")) > 16384:
            raise ValueError
        value = json.loads(raw, object_pairs_hook=_unique_object)
        if (
            not isinstance(value, dict)
            or len(value) > 16
            or any(
                not re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", name)
                or not isinstance(setting, str)
                or not setting
                or len(setting.encode("utf-8")) > 4096
                or "\x00" in setting
                for name, setting in value.items()
            )
        ):
            raise ValueError
        return value
    except (ValueError, TypeError, RecursionError):
        raise AuthError("Invalid local authentication configuration") from None
