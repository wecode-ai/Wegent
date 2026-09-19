# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Embedding space identity used by storage index contracts.

Two indexes may share a dimension and still be incompatible because a different
model produced their vectors. The identity is derived once, by the embedding
factory, from the normalized provider protocol and the model ID actually sent
to that provider, and read back from the model instance it was attached to.
Endpoint, credentials, class path, database, collection name, encoding format
and configured dimension describe deployment or output formatting rather than
the vector space, so none of them participates in the identity.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from knowledge_engine.embedding.errors import EmbeddingSpaceConfigurationError

SPACE_DIGEST_PREFIX = "sha256"
EMBEDDING_SPACE_ID_ATTRIBUTE = "embedding_space_id"


def derive_embedding_space_id(*, protocol: str, model_id: str) -> str:
    """Return the stable digest of one normalized provider/model pair."""
    payload = json.dumps(
        {"protocol": protocol, "model_id": model_id},
        sort_keys=True,
        separators=(",", ":"),
    )
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return f"{SPACE_DIGEST_PREFIX}:{digest}"


def read_embedding_space_id(embed_model: Any) -> str:
    """Read the space identity the embedding factory attached to one model.

    A model the factory did not build carries no identity, so a storage index
    cannot tell which vectors it would receive. That is a configuration error,
    never a value to guess.
    """
    space_id = getattr(embed_model, EMBEDDING_SPACE_ID_ATTRIBUTE, None)
    if not isinstance(space_id, str) or not space_id:
        raise EmbeddingSpaceConfigurationError(
            f"Embedding model '{type(embed_model).__name__}' does not declare a "
            "stable embedding space; it must be created by "
            "'create_embedding_model_from_runtime_config', which attaches "
            f"'{EMBEDDING_SPACE_ID_ATTRIBUTE}'."
        )
    return space_id
