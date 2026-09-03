# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared helpers for task-level model override labels.

IM channels can pin a model onto every task they create (the channel default
model), while other surfaces persist an explicit per-task model choice. The
``modelOverrideSource`` label records where an override came from so that
continuation and execution code can decide whether a stale override may fall
back to the Bot's own model instead of staying pinned forever.
"""

import json
from typing import Any, Dict, Optional

# Values for the modelOverrideSource label.
MODEL_OVERRIDE_SOURCE_USER_SELECTION = "user_selection"
MODEL_OVERRIDE_SOURCE_CHANNEL_DEFAULT = "channel_default"
MODEL_OVERRIDE_SOURCE_DEVICE_DEFAULT = "device_default"

# Label key that records where a task-level model override came from.
MODEL_OVERRIDE_SOURCE_LABEL = "modelOverrideSource"

# Every label key that makes up a task-level model override. Readers in chat
# triggers and device routing rely on these keys; clearing code must remove
# them all so a stale override can never survive a "use Bot default" request.
MODEL_OVERRIDE_LABEL_KEYS = (
    "modelId",
    "forceOverrideBotModel",
    "forceOverrideBotModelType",
    MODEL_OVERRIDE_SOURCE_LABEL,
    "modelOptions",
)


def apply_model_override_labels(
    labels: Dict[str, Any],
    *,
    model_id: Optional[str],
    force_override: bool = False,
    model_type: Optional[str] = None,
    source: Optional[str] = None,
    model_options: Optional[Dict[str, Any]] = None,
) -> None:
    """Write model override entries into a task label dict."""
    if model_id:
        labels["modelId"] = model_id
    if force_override:
        labels["forceOverrideBotModel"] = "true"
    if model_type:
        labels["forceOverrideBotModelType"] = model_type
    if source:
        labels[MODEL_OVERRIDE_SOURCE_LABEL] = source
    if model_options:
        labels["modelOptions"] = json.dumps(model_options)


def clear_model_override_labels(labels: Dict[str, Any]) -> bool:
    """Remove every task-level model override entry from a label dict.

    Returns:
        True when at least one label was removed.
    """
    changed = False
    for key in MODEL_OVERRIDE_LABEL_KEYS:
        if key in labels:
            del labels[key]
            changed = True
    return changed
