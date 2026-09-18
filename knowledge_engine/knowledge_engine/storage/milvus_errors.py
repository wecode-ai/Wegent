# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Turning PyMilvus RPC failures into the stable storage error.

Keeping this separate from the Milvus adapter's request lifecycle keeps the
one question that matters here - the server could not answer this attempt -
out of the code that owns schema, filters and client lifetimes.
"""

from __future__ import annotations

from knowledge_engine.storage.errors import StorageBackendError


def rpc_failure(error: BaseException) -> StorageBackendError:
    """Turn one SDK RPC failure into a stable storage error.

    The message is intentionally generic: the raw SDK message can carry the
    connection target. The SDK error type travels in the details and the
    original exception stays as the error's cause.
    """
    return StorageBackendError(
        "Milvus could not complete this operation.",
        details={"sdk_error": type(error).__name__},
    )
