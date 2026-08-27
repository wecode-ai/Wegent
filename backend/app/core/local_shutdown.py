# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Process-local shutdown state shared by web and Celery entrypoints."""

import threading

_shutdown_event = threading.Event()


def mark_local_shutdown() -> None:
    """Mark the current process as shutting down."""
    _shutdown_event.set()


def is_local_shutdown() -> bool:
    """Return True when the current process has started shutting down."""
    return _shutdown_event.is_set()


def reset_local_shutdown() -> None:
    """Reset local shutdown state for tests and manual recovery."""
    _shutdown_event.clear()
