# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Smart truncation strategies for different file formats.

This package provides intelligent truncation strategies that preserve
document structure and key information using head + uniform sampling + tail approach.
"""

from .base import (
    BaseTruncationStrategy,
    SmartTruncationConfig,
    SmartTruncationInfo,
    TruncationType,
)
from .excel import CSVTruncationStrategy, ExcelTruncationStrategy
from .manager import SmartTruncationManager, smart_truncation_manager
from .pdf import PDFTruncationStrategy
from .powerpoint import PowerPointTruncationStrategy
from .text import TextTruncationStrategy
from .word import WordTruncationStrategy

__all__ = [
    # Base classes and types
    "TruncationType",
    "SmartTruncationConfig",
    "SmartTruncationInfo",
    "BaseTruncationStrategy",
    # Strategies
    "ExcelTruncationStrategy",
    "CSVTruncationStrategy",
    "PDFTruncationStrategy",
    "WordTruncationStrategy",
    "PowerPointTruncationStrategy",
    "TextTruncationStrategy",
    # Manager
    "SmartTruncationManager",
    "smart_truncation_manager",
]
