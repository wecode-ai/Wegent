# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Bound document cleanup loading while concurrent vector indexes become ready."""

import logging
import re
import time

from pymilvus import MilvusClient
from pymilvus.client.prepare import Prepare
from pymilvus.client.types import LoadState
from pymilvus.client.utils import check_status
from pymilvus.exceptions import MilvusException

logger = logging.getLogger(__name__)

INDEX_READINESS_TIMEOUT_SECONDS = 5.0
INDEX_READINESS_POLL_SECONDS = 0.2


def _is_missing_vector_index(error: Exception) -> bool:
    return (
        isinstance(error, MilvusException)
        and error.code == 65535
        and re.search(
            r"there is no vector index on field:\s*\[(?:embedding|sparse_embedding)\]",
            error.message,
        )
        is not None
    )


def load_for_document_cleanup(client: MilvusClient, collection_name: str) -> None:
    """Keep normal load timeout; wait only for a recognized missing vector index."""
    try:
        client.load_collection(collection_name, timeout=20.0)
        return
    except MilvusException as error:
        if not _is_missing_vector_index(error):
            raise
        last_error: Exception = error

    started = time.monotonic()
    deadline = started + INDEX_READINESS_TIMEOUT_SECONDS
    attempts = 1
    ready = False
    load_requested = False

    def remaining_budget() -> float:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise last_error
        return remaining

    # Public synchronous SDK methods reuse timeout across RPCs and retries.
    # Reuse the authenticated channel, but issue single RPCs under our deadline.
    stub = client._get_connection()._stub
    try:
        while True:
            time.sleep(min(INDEX_READINESS_POLL_SECONDS, remaining_budget()))
            try:
                if not load_requested:
                    timeout = remaining_budget()
                    attempts += 1
                    status = stub.LoadCollection(
                        Prepare.load_collection(collection_name, None), timeout=timeout
                    )
                    check_status(status)
                    load_requested = True
                response = stub.GetLoadState(
                    Prepare.get_load_state(collection_name, None),
                    timeout=remaining_budget(),
                )
                check_status(response.status)
                remaining_budget()
                if response.state == LoadState.Loaded:
                    ready = True
                    return
            except Exception as error:
                last_error = error
                if not _is_missing_vector_index(error):
                    raise
                load_requested = False
    finally:
        log = logger.info if ready else logger.warning
        log(
            "[Milvus] index readiness %s: collection=%s attempts=%d "
            "elapsed=%.3fs last_error=%s",
            "ready" if ready else "failed",
            collection_name,
            attempts,
            time.monotonic() - started,
            last_error,
        )
