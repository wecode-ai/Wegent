# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Progress simulator for video generation.

When video generation APIs don't return real progress, this module provides
simulated progress based on elapsed time to reduce user anxiety.
"""

import logging
import math
import time
from typing import Dict

logger = logging.getLogger(__name__)

# Simulated progress configuration
# Video generation typically takes 60-180 seconds
# We simulate progress from 5% to 85% over this time
SIMULATED_PROGRESS_START = 5
SIMULATED_PROGRESS_END = 85
EXPECTED_GENERATION_TIME_SECONDS = 120  # Expected time for video generation


class ProgressSimulator:
    """Simulates progress for video generation jobs.

    When the video generation API doesn't return real progress (returns 0),
    this class calculates a simulated progress based on elapsed time.

    The progress follows an exponential curve that:
    - Starts at SIMULATED_PROGRESS_START (5%)
    - Approaches SIMULATED_PROGRESS_END (85%) asymptotically
    - Never exceeds 85% to leave room for actual completion

    Usage:
        simulator = ProgressSimulator()

        # When job starts
        simulator.start_job(job_id)

        # When checking progress
        api_progress = await provider.get_status(job_id)
        progress = simulator.get_progress(job_id, api_progress)

        # When job completes
        simulator.end_job(job_id)
    """

    def __init__(
        self,
        start_progress: int = SIMULATED_PROGRESS_START,
        end_progress: int = SIMULATED_PROGRESS_END,
        expected_time: float = EXPECTED_GENERATION_TIME_SECONDS,
    ):
        """Initialize progress simulator.

        Args:
            start_progress: Starting progress percentage (default: 5)
            end_progress: Maximum simulated progress percentage (default: 85)
            expected_time: Expected generation time in seconds (default: 120)
        """
        self._job_start_times: Dict[str, float] = {}
        self._start_progress = start_progress
        self._end_progress = end_progress
        self._expected_time = expected_time

    def start_job(self, job_id: str) -> None:
        """Record job start time.

        Args:
            job_id: Job ID
        """
        self._job_start_times[job_id] = time.time()

    def end_job(self, job_id: str) -> None:
        """Clean up job tracking.

        Args:
            job_id: Job ID
        """
        self._job_start_times.pop(job_id, None)

    def _calculate_simulated_progress(self, job_id: str) -> int:
        """Calculate simulated progress based on elapsed time.

        Args:
            job_id: Job ID

        Returns:
            Simulated progress percentage
        """
        start_time = self._job_start_times.get(job_id)
        if not start_time:
            return self._start_progress

        elapsed = time.time() - start_time
        # Calculate progress using a curve that slows down over time
        # This gives the impression of progress while not reaching 100%
        progress_range = self._end_progress - self._start_progress
        # Use a formula that approaches end_progress but never reaches it
        # progress = start + range * (1 - e^(-elapsed/expected_time))
        ratio = 1 - math.exp(-elapsed / self._expected_time)
        progress = self._start_progress + int(progress_range * ratio)
        return min(progress, self._end_progress)

    def get_progress(
        self, job_id: str, api_progress: int, is_running: bool = True
    ) -> int:
        """Get progress, using simulated progress if API returns 0.

        Args:
            job_id: Job ID
            api_progress: Progress returned by the API
            is_running: Whether the job is still running

        Returns:
            Progress percentage (either from API or simulated)
        """
        # If API returns real progress, use it
        if api_progress > 0:
            return api_progress

        # If job is not running (completed or failed), don't simulate
        if not is_running:
            return api_progress

        # Use simulated progress
        simulated = self._calculate_simulated_progress(job_id)
        logger.info(
            f"[ProgressSimulator] Using simulated progress: job_id={job_id}, "
            f"api_progress={api_progress}, simulated_progress={simulated}"
        )
        return simulated
