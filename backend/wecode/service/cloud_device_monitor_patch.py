# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Cloud device monitor background job registration patch.

Auto-applies on import. Registers cloud device monitor worker
with the background jobs system.
"""

import logging
import threading

logger = logging.getLogger(__name__)

_patch_applied = False


def apply_patch():
    """Register cloud device monitor worker."""
    global _patch_applied

    if _patch_applied:
        return

    try:
        # Import and patch the jobs module
        from app.services import jobs
        from wecode.service.cloud_device_monitor_worker import (
            MONITOR_INTERVAL_SECONDS,
            cloud_device_monitor_worker,
        )

        original_start_background_jobs = jobs.start_background_jobs
        original_stop_background_jobs = jobs.stop_background_jobs

        def patched_start_background_jobs(app):
            """Start background jobs including cloud device monitor."""
            # Call original first
            original_start_background_jobs(app)

            # Start cloud device monitor
            app.state.cloud_device_monitor_stop_event = threading.Event()
            app.state.cloud_device_monitor_thread = threading.Thread(
                target=cloud_device_monitor_worker,
                args=(app.state.cloud_device_monitor_stop_event,),
                name="cloud-device-monitor-worker",
                daemon=True,
            )
            app.state.cloud_device_monitor_thread.start()
            logger.info(
                f"[cloud-device-monitor] worker started "
                f"(interval: {MONITOR_INTERVAL_SECONDS}s)"
            )

        def patched_stop_background_jobs(app):
            """Stop background jobs including cloud device monitor."""
            # Stop cloud device monitor first
            if hasattr(app.state, "cloud_device_monitor_stop_event"):
                app.state.cloud_device_monitor_stop_event.set()
                app.state.cloud_device_monitor_thread.join(timeout=5)
                logger.info("[cloud-device-monitor] worker stopped")

            # Call original
            original_stop_background_jobs(app)

        # Apply patches
        jobs.start_background_jobs = patched_start_background_jobs
        jobs.stop_background_jobs = patched_stop_background_jobs

        _patch_applied = True
        logger.info("[CloudDeviceMonitorPatch] Successfully applied")

    except Exception as e:
        logger.error(f"[CloudDeviceMonitorPatch] Failed to apply: {e}")


# Auto-apply on import
apply_patch()
