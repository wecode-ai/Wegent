# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0


def get_model_capability_description(capability: object) -> str | None:
    """Read a model summary from text or existing publication metadata."""
    if isinstance(capability, str):
        return capability
    if isinstance(capability, dict):
        description = capability.get("description")
        if isinstance(description, str):
            return description
    return None
