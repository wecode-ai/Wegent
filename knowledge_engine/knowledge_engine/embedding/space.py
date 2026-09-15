# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Embedding space identity used by storage index contracts.

Two indexes may share a dimension and still be incompatible because a
different model produced their vectors. The digest below is derived only from
values that affect model output; credentials and endpoints are deliberately
excluded so that key rotation does not invalidate an index.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from knowledge_engine.embedding.vectors import read_model_name

SPACE_DIGEST_PREFIX = "sha256"


def compute_embedding_space(embed_model) -> str:
    """Return a stable, credential-free digest of the embedding space."""
    identity: dict[str, Any] = {
        "provider": f"{type(embed_model).__module__}.{type(embed_model).__qualname__}",
        "model": read_model_name(embed_model),
        "configured_dimensions": _positive_int(
            getattr(embed_model, "_configured_dimension", None)
        ),
        "encoding_format": _optional_str(
            getattr(embed_model, "_encoding_format", None)
        ),
        "explicit_space": _optional_str(
            getattr(embed_model, "embedding_space_id", None)
        ),
    }
    payload = json.dumps(identity, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return f"{SPACE_DIGEST_PREFIX}:{digest}"


def _positive_int(value: Any) -> int | None:
    return (
        value
        if isinstance(value, int) and not isinstance(value, bool) and value > 0
        else None
    )


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None
