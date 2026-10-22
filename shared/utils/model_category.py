# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Model category parsing shared by product adapters."""

from typing import Any, Mapping, Optional


def resolve_model_category(spec: Optional[Mapping[str, Any]]) -> str:
    """Return the normalized category of a Model spec.

    The CRD keeps the category at ``spec.modelType``; older payloads nest it in
    ``spec.modelConfig.modelType``. Enum members are unwrapped and unknown
    categories are returned lower-cased so callers can still report them.
    """
    model_type: Any = None
    if isinstance(spec, Mapping):
        model_type = spec.get("modelType")
        if model_type is None:
            model_config = spec.get("modelConfig") or {}
            if isinstance(model_config, Mapping):
                model_type = model_config.get("modelType")

    model_type = getattr(model_type, "value", model_type)
    return str(model_type or "llm").strip().lower()
