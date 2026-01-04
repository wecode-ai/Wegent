# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Smart truncation manager for coordinating truncation strategies.
"""

from typing import Any, Dict, List, Optional, Tuple

from .base import (
    BaseTruncationStrategy,
    SmartTruncationConfig,
    SmartTruncationInfo,
)
from .excel import CSVTruncationStrategy, ExcelTruncationStrategy
from .pdf import PDFTruncationStrategy
from .powerpoint import PowerPointTruncationStrategy
from .text import TextTruncationStrategy
from .word import WordTruncationStrategy


class SmartTruncationManager:
    """Manager for applying smart truncation strategies."""

    def __init__(self, config: Optional[SmartTruncationConfig] = None):
        self.config = config or SmartTruncationConfig()
        self._strategies = {
            "excel": ExcelTruncationStrategy(self.config),
            "csv": CSVTruncationStrategy(self.config),
            "pdf": PDFTruncationStrategy(self.config),
            "word": WordTruncationStrategy(self.config),
            "powerpoint": PowerPointTruncationStrategy(self.config),
            "text": TextTruncationStrategy(self.config),
        }

    def get_strategy(self, file_type: str) -> Optional[BaseTruncationStrategy]:
        """Get the appropriate truncation strategy for a file type."""
        return self._strategies.get(file_type.lower())

    def truncate_excel(
        self, sheets_data: List[Dict[str, Any]], max_length: Optional[int] = None
    ) -> Tuple[str, SmartTruncationInfo]:
        """Truncate Excel data."""
        strategy = self._strategies["excel"]
        return strategy.truncate(sheets_data, max_length or self.config.max_length)

    def truncate_csv(
        self, rows: List[List[str]], max_length: Optional[int] = None
    ) -> Tuple[str, SmartTruncationInfo]:
        """Truncate CSV data."""
        strategy: CSVTruncationStrategy = self._strategies["csv"]
        return strategy.truncate_csv_rows(rows, max_length or self.config.max_length)

    def truncate_pdf(
        self, pages_text: List[str], max_length: Optional[int] = None
    ) -> Tuple[str, SmartTruncationInfo]:
        """Truncate PDF data."""
        strategy = self._strategies["pdf"]
        return strategy.truncate(pages_text, max_length or self.config.max_length)

    def truncate_word(
        self, paragraphs: List[str], max_length: Optional[int] = None
    ) -> Tuple[str, SmartTruncationInfo]:
        """Truncate Word document data."""
        strategy = self._strategies["word"]
        return strategy.truncate(paragraphs, max_length or self.config.max_length)

    def truncate_powerpoint(
        self, slides_text: List[str], max_length: Optional[int] = None
    ) -> Tuple[str, SmartTruncationInfo]:
        """Truncate PowerPoint data."""
        strategy = self._strategies["powerpoint"]
        return strategy.truncate(slides_text, max_length or self.config.max_length)

    def truncate_text(
        self, text: str, max_length: Optional[int] = None
    ) -> Tuple[str, SmartTruncationInfo]:
        """Truncate plain text or markdown."""
        strategy = self._strategies["text"]
        return strategy.truncate(text, max_length or self.config.max_length)


# Global manager instance with default config
smart_truncation_manager = SmartTruncationManager()
