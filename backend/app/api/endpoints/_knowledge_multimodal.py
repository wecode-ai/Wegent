# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Multimodal field pass-through helpers for the knowledge API endpoints.

Isolated from endpoints/knowledge.py to minimize merge conflicts. The
create/update endpoints spread these kwargs into their orchestrator calls.

The reindex endpoint's ``payload: Optional[DocumentReindexRequest]`` parameter
and its single ``multimodal_prompt_override`` forwarding line remain in
knowledge.py because they are the FastAPI route signature and cannot be moved
out without duplicating the endpoint.
"""

from typing import Any, Dict

# The four multimodal spec fields, in a stable order. ``model_dump(by_alias=False,
# exclude_unset=True)`` keys mirror the snake_case attribute names below, so this
# tuple doubles as the canonical field list for create/update extraction.
_MULTIMODAL_FIELDS = (
    "multimodal_analysis_enabled",
    "multimodal_analysis_model_ref",
    "multimodal_analysis_video_prompt",
    "multimodal_analysis_image_prompt",
)


def multimodal_create_kwargs(data) -> Dict[str, Any]:
    """Extract multimodal fields for create_knowledge_base.

    ``enabled`` defaults to False when unset (create requires a concrete bool).
    Other fields pass through as-is (None = unset).
    """
    return {
        "multimodal_analysis_enabled": (
            data.multimodal_analysis_enabled
            if data.multimodal_analysis_enabled is not None
            else False
        ),
        "multimodal_analysis_model_ref": data.multimodal_analysis_model_ref,
        "multimodal_analysis_video_prompt": data.multimodal_analysis_video_prompt,
        "multimodal_analysis_image_prompt": data.multimodal_analysis_image_prompt,
    }


def multimodal_update_kwargs(data) -> Dict[str, Any]:
    """Extract multimodal fields for update_knowledge_base.

    Uses ``exclude_unset=True`` so that a client explicitly sending ``null``
    (intent: clear the field) is distinguished from omitting the field (intent:
    leave unchanged). Only fields the client actually sent are forwarded, which
    lets the orchestrator treat ``None`` as "clear" and "key absent" as "skip".
    """
    dumped = data.model_dump(exclude_unset=True)
    return {field: dumped[field] for field in _MULTIMODAL_FIELDS if field in dumped}
