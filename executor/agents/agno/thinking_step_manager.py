#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import re
from typing import Any, Callable, Dict, List, Optional

from shared.logger import setup_logger
from shared.models.task import ExecutionResult, ThinkingStep
from shared.status import TaskStatus

logger = setup_logger("thinking_step_manager")


class ThinkingStepManager:
    """
    Class for managing thinking steps, encapsulating functions like adding thinking steps and progress tracking
    """

    def __init__(
        self, progress_reporter: Optional[Callable] = None, state_manager=None
    ):
        """
        Initialize ThinkingStepManager

        Args:
            progress_reporter: Progress report callback function with signature (progress, status, message, result)
                              (kept for backward compatibility, prefer using state_manager)
            state_manager: Optional ProgressStateManager instance for unified progress reporting
        """
        self.thinking_steps: List[ThinkingStep] = []
        self._current_progress: int = 50
        self.progress_reporter = progress_reporter
        self.state_manager = state_manager

    def add_thinking_step(
        self,
        title: str,
        report_immediately: bool = True,
        use_i18n_keys: bool = False,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Add a thinking step

        Args:
            title: Step title (or i18n key if use_i18n_keys is True)
            report_immediately: Whether to report this thinking step immediately (default True)
            use_i18n_keys: Whether to use i18n key directly instead of English text (default False)
            details: Additional details for the thinking step (optional)
        """
        thinking_step = ThinkingStep(title=title, details=details)
        self.thinking_steps.append(thinking_step)
        logger.info(f"Added thinking step: {title}")

        # Report this thinking step if immediate reporting is needed
        if report_immediately:
            # Prefer using state_manager for unified reporting (includes workbench)
            if self.state_manager:
                self.state_manager.report_progress(
                    progress=self._current_progress,
                    status=TaskStatus.RUNNING.value,
                    message=f"Thinking: {title}",
                )
            # Fallback to legacy progress_reporter if state_manager not available
            elif self.progress_reporter:
                self.progress_reporter(
                    progress=self._current_progress,
                    status=TaskStatus.RUNNING.value,
                    message=f"Thinking: {title}",
                    result=ExecutionResult(thinking=self.thinking_steps).dict(),
                )

    def _text_to_i18n_key(self, text: str) -> str:
        return text

    def add_thinking_step_by_key(
        self,
        title_key: str,
        report_immediately: bool = True,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Add a thinking step using i18n key

        Args:
            title_key: i18n key for step title
            report_immediately: Whether to report this thinking step immediately (default True)
            details: Additional details for the thinking step (optional)
        """
        self.add_thinking_step(
            title=title_key,
            report_immediately=report_immediately,
            use_i18n_keys=True,
            details=details,
        )

    def _is_i18n_key(self, text: str) -> bool:
        """
        Check if text is an i18n key

        Args:
            text: Text to check

        Returns:
            bool: True if it's an i18n key, otherwise False
        """
        # i18n keys usually contain dots and do not contain spaces
        return "." in text and " " not in text and len(text) > 3

    def update_progress(self, progress: int) -> None:
        """
        Update current progress value for thinking steps

        Args:
            progress: Current progress value (0-100)
        """
        self._current_progress = progress

    def get_thinking_steps(self) -> List[ThinkingStep]:
        """
        Get all thinking steps

        Returns:
            List[ThinkingStep]: List of thinking steps
        """
        return self.thinking_steps

    def clear_thinking_steps(self) -> None:
        """
        Clear all thinking steps
        """
        self.thinking_steps.clear()
        logger.info("Cleared all thinking steps")

    def set_progress_reporter(self, progress_reporter: Callable) -> None:
        """
        Set progress report callback function

        Args:
            progress_reporter: Progress report callback function with signature (progress, status, message, result)
        """
        self.progress_reporter = progress_reporter

    def set_state_manager(self, state_manager) -> None:
        """
        Set state manager for unified progress reporting

        Args:
            state_manager: ProgressStateManager instance
        """
        self.state_manager = state_manager
