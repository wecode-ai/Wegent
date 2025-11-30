#!/usr/bin/env python
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Output Parser for detecting waiting signals in agent output.
This module analyzes agent execution output to determine if the agent
has performed actions that require waiting for external events.
"""

import re
from dataclasses import dataclass
from enum import Enum
from typing import List, Optional, Tuple

from shared.logger import setup_logger

logger = setup_logger("output_parser")


class WaitingSignalType(str, Enum):
    """Types of waiting signals that can be detected."""
    CI_PIPELINE = "ci_pipeline"
    APPROVAL = "approval"
    EXTERNAL_API = "external_api"
    NONE = "none"


@dataclass
class WaitingSignal:
    """Represents a detected waiting signal."""
    signal_type: WaitingSignalType
    pattern_matched: str
    context: str  # Surrounding context where the pattern was found
    confidence: float  # 0.0 to 1.0


# Detection patterns for various waiting signals
# Each pattern is a tuple of (regex_pattern, signal_type, confidence)
WAITING_SIGNAL_PATTERNS: List[Tuple[str, WaitingSignalType, float]] = [
    # Git push patterns (high confidence - CI usually triggered)
    (r'git\s+push(?:\s+[\w\-/]+)*', WaitingSignalType.CI_PIPELINE, 0.9),
    (r'Successfully\s+pushed\s+to', WaitingSignalType.CI_PIPELINE, 0.9),
    (r'To\s+(?:https?://)?[\w\.\-]+[:/][\w\-]+/[\w\-]+\.git', WaitingSignalType.CI_PIPELINE, 0.85),

    # GitHub PR patterns
    (r'gh\s+pr\s+create', WaitingSignalType.CI_PIPELINE, 0.95),
    (r'Pull\s+request\s+#?\d+\s+created', WaitingSignalType.CI_PIPELINE, 0.9),
    (r'https://github\.com/[\w\-]+/[\w\-]+/pull/\d+', WaitingSignalType.CI_PIPELINE, 0.9),

    # GitLab MR patterns
    (r'glab\s+mr\s+create', WaitingSignalType.CI_PIPELINE, 0.95),
    (r'Merge\s+request\s+!?\d+\s+created', WaitingSignalType.CI_PIPELINE, 0.9),
    (r'https://[\w\.\-]+/[\w\-]+/[\w\-]+/-/merge_requests/\d+', WaitingSignalType.CI_PIPELINE, 0.9),

    # Direct CI trigger patterns
    (r'CI\s+pipeline\s+(?:started|triggered)', WaitingSignalType.CI_PIPELINE, 0.95),
    (r'workflow\s+(?:run|started|triggered)', WaitingSignalType.CI_PIPELINE, 0.8),

    # Approval patterns (lower confidence - might be false positives)
    (r'waiting\s+for\s+approval', WaitingSignalType.APPROVAL, 0.9),
    (r'requires?\s+approval', WaitingSignalType.APPROVAL, 0.8),
    (r'pending\s+review', WaitingSignalType.APPROVAL, 0.7),

    # External API call patterns
    (r'waiting\s+for\s+(?:external\s+)?(?:api|service|response)', WaitingSignalType.EXTERNAL_API, 0.8),
    (r'async\s+(?:job|task)\s+(?:submitted|started)', WaitingSignalType.EXTERNAL_API, 0.7),
]


class OutputParser:
    """
    Parser for detecting waiting signals in agent output.

    This class analyzes the output from agent executions to determine
    if the agent has performed actions that require waiting for external
    events (like CI pipelines, approvals, etc.).
    """

    def __init__(self, confidence_threshold: float = 0.7):
        """
        Initialize the output parser.

        Args:
            confidence_threshold: Minimum confidence score to consider a signal valid
        """
        self.confidence_threshold = confidence_threshold
        self._compiled_patterns = [
            (re.compile(pattern, re.IGNORECASE | re.MULTILINE), signal_type, confidence)
            for pattern, signal_type, confidence in WAITING_SIGNAL_PATTERNS
        ]

    def detect_waiting_signal(self, output: str) -> Optional[WaitingSignal]:
        """
        Detect if the output contains a waiting signal.

        Args:
            output: The agent output to analyze

        Returns:
            WaitingSignal if a signal is detected, None otherwise
        """
        if not output:
            return None

        best_signal: Optional[WaitingSignal] = None
        best_confidence = 0.0

        for compiled_pattern, signal_type, base_confidence in self._compiled_patterns:
            matches = compiled_pattern.finditer(output)

            for match in matches:
                # Calculate confidence based on pattern and context
                confidence = self._calculate_confidence(
                    output, match, base_confidence
                )

                if confidence > best_confidence and confidence >= self.confidence_threshold:
                    # Extract context around the match
                    start = max(0, match.start() - 100)
                    end = min(len(output), match.end() + 100)
                    context = output[start:end]

                    best_signal = WaitingSignal(
                        signal_type=signal_type,
                        pattern_matched=match.group(),
                        context=context,
                        confidence=confidence,
                    )
                    best_confidence = confidence

        if best_signal:
            logger.info(
                f"Detected waiting signal: type={best_signal.signal_type}, "
                f"pattern='{best_signal.pattern_matched}', "
                f"confidence={best_signal.confidence:.2f}"
            )

        return best_signal

    def _calculate_confidence(
        self, output: str, match: re.Match, base_confidence: float
    ) -> float:
        """
        Calculate confidence score based on pattern match and context.

        Args:
            output: Full output text
            match: Regex match object
            base_confidence: Base confidence from pattern definition

        Returns:
            Adjusted confidence score
        """
        confidence = base_confidence

        # Get surrounding context
        start = max(0, match.start() - 200)
        end = min(len(output), match.end() + 200)
        context = output[start:end].lower()

        # Boost confidence for certain context indicators
        positive_indicators = [
            'success', 'completed', 'created', 'pushed',
            'submitted', 'triggered', 'started'
        ]
        negative_indicators = [
            'error', 'failed', 'rejected', 'denied', 'dry-run', 'simulation'
        ]

        for indicator in positive_indicators:
            if indicator in context:
                confidence = min(1.0, confidence + 0.05)

        for indicator in negative_indicators:
            if indicator in context:
                confidence = max(0.0, confidence - 0.1)

        # Check if the pattern appears in a command output vs. just documentation
        if match.start() > 0:
            # If preceded by common command prompt indicators, boost confidence
            pre_context = output[max(0, match.start() - 50):match.start()].lower()
            if any(ind in pre_context for ind in ['$', '>', '→', 'output:', 'result:']):
                confidence = min(1.0, confidence + 0.1)

        return confidence

    def should_wait(self, output: str) -> Tuple[bool, Optional[str]]:
        """
        Determine if the agent should enter waiting state based on output.

        Args:
            output: The agent output to analyze

        Returns:
            Tuple of (should_wait, waiting_for_type)
        """
        signal = self.detect_waiting_signal(output)

        if signal and signal.signal_type != WaitingSignalType.NONE:
            return True, signal.signal_type.value

        return False, None


# Global parser instance
output_parser = OutputParser()


def detect_waiting_signal(output: str) -> Optional[str]:
    """
    Convenience function to detect waiting signals.

    Args:
        output: Agent output to analyze

    Returns:
        waiting_for type string if signal detected, None otherwise
    """
    should_wait, waiting_for = output_parser.should_wait(output)
    return waiting_for if should_wait else None
