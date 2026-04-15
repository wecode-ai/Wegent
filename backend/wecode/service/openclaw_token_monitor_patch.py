# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenClaw token monitor background job registration patch.

Auto-applies on import. Registers OpenClaw token monitor worker
with the background jobs system.
"""

import logging
import threading

logger = logging.getLogger(__name__)

_patch_applied = False


def apply_patch():
    """Register OpenClaw token monitor worker."""
    global _patch_applied

    if _patch_applied:
        return

    # Import settings to check if monitoring is enabled
    from app.core.config import settings

    if not settings.OPENCLAW_TOKEN_ALERT_ENABLED:
        logger.info(
            "[OpenClawTokenMonitorPatch] Monitoring is disabled, skipping registration"
        )
        _patch_applied = True
        return

    try:
        # Import and patch the jobs module
        from app.services import jobs
        from wecode.service.openclaw_token_monitor_worker import (
            MONITOR_INTERVAL_SECONDS,
            openclaw_token_monitor_worker,
        )

        original_start_background_jobs = jobs.start_background_jobs
        original_stop_background_jobs = jobs.stop_background_jobs

        def patched_start_background_jobs(app):
            """Start background jobs including OpenClaw token monitor."""
            # Call original first
            original_start_background_jobs(app)

            # Start OpenClaw token monitor
            app.state.openclaw_token_monitor_stop_event = threading.Event()
            app.state.openclaw_token_monitor_thread = threading.Thread(
                target=openclaw_token_monitor_worker,
                args=(app.state.openclaw_token_monitor_stop_event,),
                name="openclaw-token-monitor-worker",
                daemon=True,
            )
            app.state.openclaw_token_monitor_thread.start()
            logger.info(
                f"[openclaw-token-monitor] worker started "
                f"(interval: {MONITOR_INTERVAL_SECONDS}s)"
            )

        def patched_stop_background_jobs(app):
            """Stop background jobs including OpenClaw token monitor."""
            # Stop OpenClaw token monitor first
            if hasattr(app.state, "openclaw_token_monitor_stop_event"):
                app.state.openclaw_token_monitor_stop_event.set()
                app.state.openclaw_token_monitor_thread.join(timeout=5)
                logger.info("[openclaw-token-monitor] worker stopped")

            # Call original
            original_stop_background_jobs(app)

        # Apply patches
        jobs.start_background_jobs = patched_start_background_jobs
        jobs.stop_background_jobs = patched_stop_background_jobs

        _patch_applied = True
        logger.info("[OpenClawTokenMonitorPatch] Successfully applied")

    except Exception as e:
        logger.error(f"[OpenClawTokenMonitorPatch] Failed to apply: {e}")


# Auto-apply on import
apply_patch()
