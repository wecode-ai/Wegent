# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Smart truncation strategies for different file formats.

Instead of simple text cutting, this module provides intelligent truncation
that preserves document structure and key information:
- Excel/CSV: Header + uniformly sampled rows (covering entire dataset)
- PDF: First pages + uniformly sampled middle pages + last pages
- Word: Opening paragraphs + uniformly sampled middle + closing paragraphs
- PowerPoint: First/last slides + uniformly sampled middle slides
- Text/Markdown: Head content + uniformly sampled middle + tail content

The truncation is based on max_length (character count), dynamically calculating
how many structural units (rows/pages/paragraphs/etc.) to keep to fill the
available space. For tabular data (Excel/CSV), uniform sampling ensures coverage
across the entire dataset (e.g., data from all 12 months in a yearly report).

This module re-exports all classes from the truncation_strategies subpackage
for backward compatibility.
"""

# Re-export all classes from the truncation_strategies subpackage
from .truncation_strategies import (
    BaseTruncationStrategy,
    CSVTruncationStrategy,
    ExcelTruncationStrategy,
    PDFTruncationStrategy,
    PowerPointTruncationStrategy,
    SmartTruncationConfig,
    SmartTruncationInfo,
    SmartTruncationManager,
    TextTruncationStrategy,
    TruncationType,
    WordTruncationStrategy,
    smart_truncation_manager,
)

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
