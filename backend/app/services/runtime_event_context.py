# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Source-turn context for automatic shared Runtime projections."""

from collections.abc import Mapping
from typing import Any


def runtime_event_is_private_discussion(payload: Mapping[str, Any]) -> bool:
    """Private turns retain their stream without updating shared Issue records."""
    return payload.get("conversationContext") == "private_discussion"
