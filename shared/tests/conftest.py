# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import gc
import sys
import threading
import time
import warnings

import pytest


@pytest.fixture(autouse=True, scope="session")
def cleanup_daemon_threads():
    """
    Ensure all daemon threads are cleaned up after tests.
    This prevents 'Fatal Python error: _enter_buffered_busy'
    at interpreter shutdown.
    """
    yield
    # Suppress warnings about unclosed resources during cleanup
    warnings.filterwarnings("ignore", category=ResourceWarning)
    warnings.filterwarnings("ignore", category=DeprecationWarning)

    # Shutdown telemetry providers if they were initialized
    try:
        from shared.telemetry.core import shutdown_telemetry

        shutdown_telemetry()
    except Exception:
        pass  # Telemetry may not have been initialized

    # Active wait for all non-daemon threads to complete
    main_thread = threading.main_thread()
    timeout = 3.0  # Max 3 seconds total wait
    check_interval = 0.05
    elapsed = 0.0

    while elapsed < timeout:
        # Get all alive non-daemon threads except main thread
        alive_threads = [
            t
            for t in threading.enumerate()
            if t is not main_thread and t.is_alive() and not t.daemon
        ]

        if not alive_threads:
            break

        # Wait a bit and check again
        time.sleep(check_interval)
        elapsed += check_interval

    # Force garbage collection to clean up thread objects
    gc.collect()

    # Final grace period for any remaining cleanup
    time.sleep(0.5)

    # Suppress daemon thread errors during interpreter shutdown
    # by replacing stderr with a null writer
    try:

        class NullWriter:
            def write(self, *args, **kwargs):
                pass

            def flush(self, *args, **kwargs):
                pass

        sys.stderr = NullWriter()
    except:  # noqa: E722
        pass
