# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Stable fingerprints for immutable document-index inputs."""

import hashlib
import json
from typing import Any


def publication_fingerprint(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def has_captured_version_storage(record: Any) -> bool:
    """Identify versions whose storage was recorded when they were staged."""
    if (
        not isinstance(record, dict)
        or record.get("storage_captured_at_staging") is not True
    ):
        return False
    reference = record.get("doc_ref")
    if not isinstance(reference, str):
        return False
    document, _, generation = reference.partition("@")
    return (
        document == str(record.get("document_id"))
        and generation.isascii()
        and generation.isdecimal()
    )
