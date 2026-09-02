# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Process entry point for non-Celery scheduler backends."""

from __future__ import annotations

import signal
import threading

from app.core.logging import setup_logging
from app.core.scheduler import start_scheduler, stop_scheduler


def main() -> None:
    """Own one configured scheduler until the supervisor terminates it."""
    setup_logging()
    stopped = threading.Event()
    for handled_signal in (signal.SIGINT, signal.SIGTERM):
        signal.signal(handled_signal, lambda *_: stopped.set())

    scheduler = start_scheduler()
    if scheduler is None:
        raise RuntimeError("Configured scheduler backend failed to start")
    try:
        stopped.wait()
    finally:
        stop_scheduler()


if __name__ == "__main__":
    main()
