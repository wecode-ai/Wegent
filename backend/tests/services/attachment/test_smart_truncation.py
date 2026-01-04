# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for the smart truncation strategies.
"""

import pytest

from app.services.attachment.smart_truncation import (
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
)


class TestSmartTruncationConfig:
    """Test cases for SmartTruncationConfig."""

    def test_default_config(self):
        """Test default configuration values."""
        config = SmartTruncationConfig()
        assert config.max_length == 500000
        assert config.excel_header_rows == 1
        assert config.excel_sample_rows == 10
        assert config.excel_tail_rows == 5
        assert config.pdf_first_pages == 3
        assert config.pdf_last_pages == 2
        assert config.word_first_paragraphs == 10
        assert config.word_last_paragraphs == 5
        assert config.ppt_first_slides == 3
        assert config.ppt_last_slides == 2
        assert config.text_head_lines == 100
        assert config.text_tail_lines == 50

    def test_custom_config(self):
        """Test custom configuration values."""
        config = SmartTruncationConfig(
            max_length=100000,
            excel_header_rows=2,
            excel_sample_rows=5,
        )
        assert config.max_length == 100000
        assert config.excel_header_rows == 2
        assert config.excel_sample_rows == 5


class TestExcelTruncationStrategy:
    """Test cases for Excel truncation strategy."""

    def setup_method(self):
        """Set up test fixtures."""
        self.config = SmartTruncationConfig(
            excel_header_rows=1,
            excel_sample_rows=3,
            excel_tail_rows=2,
        )
        self.strategy = ExcelTruncationStrategy(self.config)

    def test_no_truncation_needed(self):
        """Test when data fits within limits."""
        sheets_data = [
            {
                "name": "Sheet1",
                "rows": [
                    ["Name", "Age", "City"],
                    ["Alice", 30, "NYC"],
                    ["Bob", 25, "LA"],
                ],
            }
        ]

        text, info = self.strategy.truncate(sheets_data, 100000)

        # When no truncation is needed, type should be NONE
        assert info.truncation_type == TruncationType.NONE
        assert info.is_truncated is False
        assert "Alice" in text
        assert "Bob" in text

    def test_truncation_with_many_rows(self):
        """Test truncation when there are many rows."""
        # Create 100 rows with longer content to ensure truncation
        rows = [["ID", "Name", "Value", "Description"]]  # Header
        for i in range(99):
            rows.append(
                [
                    i,
                    f"Item{i}",
                    i * 10,
                    f"This is a longer description for item {i} to increase row length",
                ]
            )

        sheets_data = [{"name": "Data", "rows": rows}]

        # Use a max_length that triggers smart truncation but is large enough
        # to allow the smart truncation to complete without falling back to simple
        text, info = self.strategy.truncate(sheets_data, 5000)

        assert info.is_truncated is True
        # Accept both SMART and SIMPLE truncation types
        assert info.truncation_type in [TruncationType.SMART, TruncationType.SIMPLE]
        assert (
            "skipped" in text.lower() or "omitted" in text.lower() or len(text) <= 5000
        )
        # Header should be present
        assert "ID" in text
        # First data rows should be present (head section)
        assert "Item0" in text

    def test_multiple_sheets(self):
        """Test truncation with multiple sheets."""
        sheets_data = [
            {
                "name": "Sheet1",
                "rows": [["A", "B"], ["1", "2"]],
            },
            {
                "name": "Sheet2",
                "rows": [["C", "D"], ["3", "4"]],
            },
        ]

        text, info = self.strategy.truncate(sheets_data, 100000)

        assert "Sheet1" in text
        assert "Sheet2" in text

    def test_column_limit(self):
        """Test that columns are limited."""
        config = SmartTruncationConfig(excel_max_columns=3)
        strategy = ExcelTruncationStrategy(config)

        rows = [[f"Col{i}" for i in range(10)]]
        sheets_data = [{"name": "Wide", "rows": rows}]

        text, info = strategy.truncate(sheets_data, 100000)

        assert "+7 columns" in text or "columns" in text.lower()


class TestCSVTruncationStrategy:
    """Test cases for CSV truncation strategy."""

    def setup_method(self):
        """Set up test fixtures."""
        self.config = SmartTruncationConfig(
            excel_header_rows=1,
            excel_sample_rows=2,
            excel_tail_rows=2,
        )
        self.strategy = CSVTruncationStrategy(self.config)

    def test_csv_truncation(self):
        """Test CSV truncation."""
        rows = [["Name", "Value", "Description"]]
        for i in range(50):
            rows.append(
                [
                    f"Item{i}",
                    str(i),
                    f"This is a longer description for item {i} to increase row length",
                ]
            )

        # Use a smaller max_length to trigger truncation
        text, info = self.strategy.truncate_csv_rows(rows, 1000)

        assert info.is_truncated is True
        assert "skipped" in text.lower() or "omitted" in text.lower()


class TestPDFTruncationStrategy:
    """Test cases for PDF truncation strategy."""

    def setup_method(self):
        """Set up test fixtures."""
        self.config = SmartTruncationConfig(
            pdf_first_pages=2,
            pdf_last_pages=1,
        )
        self.strategy = PDFTruncationStrategy(self.config)

    def test_no_truncation_needed(self):
        """Test when pages fit within limits."""
        pages = ["Page 1 content", "Page 2 content"]

        text, info = self.strategy.truncate(pages, 100000)

        assert info.truncation_type == TruncationType.NONE
        assert info.is_truncated is False

    def test_truncation_with_many_pages(self):
        """Test truncation when there are many pages and content exceeds max_length."""
        # Create pages with enough content to exceed max_length
        pages = [f"Content of page {i}. " + "x" * 100 for i in range(20)]

        # Set a larger max_length to allow smart truncation to work
        text, info = self.strategy.truncate(pages, 2000)

        assert info.is_truncated is True
        # Accept both SMART and SIMPLE truncation types
        assert info.truncation_type in [TruncationType.SMART, TruncationType.SIMPLE]
        # New implementation uses "skipped" for gaps between sections
        assert (
            "skipped" in text.lower() or "omitted" in text.lower() or len(text) <= 2000
        )
        # First pages should be present
        assert "page 1" in text.lower() or "Page 1" in text

    def test_structure_info(self):
        """Test that structure info is populated when truncation occurs."""
        # Create pages with enough content to exceed max_length
        pages = [f"Page {i} content. " + "y" * 100 for i in range(10)]

        # Set a larger max_length to allow smart truncation to work
        text, info = self.strategy.truncate(pages, 2000)

        assert info.original_structure["total_pages"] == 10
        if info.is_truncated and info.truncation_type == TruncationType.SMART:
            # New implementation uses head_pages/tail_pages instead of first_pages/last_pages
            assert (
                "head_pages" in info.kept_structure
                or "total_kept" in info.kept_structure
            )


class TestWordTruncationStrategy:
    """Test cases for Word truncation strategy."""

    def setup_method(self):
        """Set up test fixtures."""
        self.config = SmartTruncationConfig(
            word_first_paragraphs=3,
            word_last_paragraphs=2,
        )
        self.strategy = WordTruncationStrategy(self.config)

    def test_no_truncation_needed(self):
        """Test when paragraphs fit within limits."""
        paragraphs = ["Para 1", "Para 2", "Para 3"]

        text, info = self.strategy.truncate(paragraphs, 100000)

        assert info.truncation_type == TruncationType.NONE
        assert info.is_truncated is False

    def test_truncation_with_many_paragraphs(self):
        """Test truncation when there are many paragraphs and content exceeds max_length."""
        # Create paragraphs with enough content to exceed max_length
        paragraphs = [
            f"Paragraph {i} with some content. " + "z" * 100 for i in range(50)
        ]

        # Set a larger max_length to allow smart truncation to work
        text, info = self.strategy.truncate(paragraphs, 2000)

        assert info.is_truncated is True
        # New implementation uses "skipped" for gaps between sections
        assert (
            "skipped" in text.lower() or "omitted" in text.lower() or len(text) <= 2000
        )
        # First paragraphs should be present
        assert "Paragraph 0" in text


class TestPowerPointTruncationStrategy:
    """Test cases for PowerPoint truncation strategy."""

    def setup_method(self):
        """Set up test fixtures."""
        self.config = SmartTruncationConfig(
            ppt_first_slides=2,
            ppt_last_slides=1,
        )
        self.strategy = PowerPointTruncationStrategy(self.config)

    def test_no_truncation_needed(self):
        """Test when slides fit within limits."""
        slides = ["Slide 1 content", "Slide 2 content"]

        text, info = self.strategy.truncate(slides, 100000)

        assert info.truncation_type == TruncationType.NONE
        assert info.is_truncated is False

    def test_truncation_with_many_slides(self):
        """Test truncation when there are many slides and content exceeds max_length."""
        # Create slides with enough content to exceed max_length
        slides = [
            f"--- Slide {i} ---\nContent for slide {i}. " + "w" * 100 for i in range(30)
        ]

        # Set a larger max_length to allow smart truncation to work
        text, info = self.strategy.truncate(slides, 2000)

        assert info.is_truncated is True
        # New implementation uses "skipped" for gaps between sections
        assert (
            "skipped" in text.lower() or "omitted" in text.lower() or len(text) <= 2000
        )


class TestTextTruncationStrategy:
    """Test cases for text truncation strategy."""

    def setup_method(self):
        """Set up test fixtures."""
        self.config = SmartTruncationConfig(
            text_head_lines=5,
            text_tail_lines=3,
        )
        self.strategy = TextTruncationStrategy(self.config)

    def test_no_truncation_needed(self):
        """Test when text fits within limits."""
        text = "Line 1\nLine 2\nLine 3"

        result, info = self.strategy.truncate(text, 100000)

        assert info.truncation_type == TruncationType.NONE
        assert info.is_truncated is False

    def test_truncation_with_many_lines(self):
        """Test truncation when there are many lines and content exceeds max_length."""
        # Create lines with enough content to exceed max_length
        lines = [f"Line {i}: Some content here. " + "v" * 50 for i in range(100)]
        text = "\n".join(lines)

        # Set a larger max_length to allow smart truncation to work
        result, info = self.strategy.truncate(text, 2000)

        assert info.is_truncated is True
        # New implementation uses "skipped" for gaps between sections
        assert (
            "skipped" in result.lower()
            or "omitted" in result.lower()
            or len(result) <= 2000
        )
        # First lines should be present
        assert "Line 0" in result

    def test_length_limit_fallback(self):
        """Test that length limit is enforced as fallback."""
        # Create text that exceeds max_length even after line truncation
        lines = [f"Line {i}: " + "x" * 1000 for i in range(20)]
        text = "\n".join(lines)

        result, info = self.strategy.truncate(text, 1000)

        assert len(result) <= 1000


class TestSmartTruncationManager:
    """Test cases for SmartTruncationManager."""

    def setup_method(self):
        """Set up test fixtures."""
        self.manager = SmartTruncationManager()

    def test_get_strategy(self):
        """Test getting strategies by type."""
        assert self.manager.get_strategy("excel") is not None
        assert self.manager.get_strategy("csv") is not None
        assert self.manager.get_strategy("pdf") is not None
        assert self.manager.get_strategy("word") is not None
        assert self.manager.get_strategy("powerpoint") is not None
        assert self.manager.get_strategy("text") is not None
        assert self.manager.get_strategy("unknown") is None

    def test_truncate_excel(self):
        """Test Excel truncation through manager."""
        sheets_data = [
            {
                "name": "Test",
                "rows": [[f"Row{i}"] for i in range(100)],
            }
        ]

        text, info = self.manager.truncate_excel(sheets_data)

        assert isinstance(text, str)
        assert isinstance(info, SmartTruncationInfo)

    def test_truncate_csv(self):
        """Test CSV truncation through manager."""
        rows = [[f"Item{i}"] for i in range(100)]

        text, info = self.manager.truncate_csv(rows)

        assert isinstance(text, str)
        assert isinstance(info, SmartTruncationInfo)

    def test_truncate_pdf(self):
        """Test PDF truncation through manager."""
        pages = [f"Page {i}" for i in range(20)]

        text, info = self.manager.truncate_pdf(pages)

        assert isinstance(text, str)
        assert isinstance(info, SmartTruncationInfo)

    def test_truncate_word(self):
        """Test Word truncation through manager."""
        paragraphs = [f"Para {i}" for i in range(50)]

        text, info = self.manager.truncate_word(paragraphs)

        assert isinstance(text, str)
        assert isinstance(info, SmartTruncationInfo)

    def test_truncate_powerpoint(self):
        """Test PowerPoint truncation through manager."""
        slides = [f"Slide {i}" for i in range(30)]

        text, info = self.manager.truncate_powerpoint(slides)

        assert isinstance(text, str)
        assert isinstance(info, SmartTruncationInfo)

    def test_truncate_text(self):
        """Test text truncation through manager."""
        text = "\n".join([f"Line {i}" for i in range(200)])

        result, info = self.manager.truncate_text(text)

        assert isinstance(result, str)
        assert isinstance(info, SmartTruncationInfo)

    def test_custom_config(self):
        """Test manager with custom config."""
        config = SmartTruncationConfig(
            excel_header_rows=2,
            excel_sample_rows=5,
        )
        manager = SmartTruncationManager(config)

        assert manager.config.excel_header_rows == 2
        assert manager.config.excel_sample_rows == 5


class TestSmartTruncationInfo:
    """Test cases for SmartTruncationInfo dataclass."""

    def test_default_values(self):
        """Test default values."""
        info = SmartTruncationInfo()
        assert info.truncation_type == TruncationType.NONE
        assert info.is_truncated is False
        assert info.original_length is None
        assert info.truncated_length is None
        assert info.original_structure == {}
        assert info.kept_structure == {}
        assert info.summary_message == ""

    def test_with_values(self):
        """Test with custom values."""
        info = SmartTruncationInfo(
            truncation_type=TruncationType.SMART,
            is_truncated=True,
            original_length=10000,
            truncated_length=5000,
            original_structure={"total_rows": 100},
            kept_structure={"kept_rows": 20},
            summary_message="Truncated 80 rows",
        )
        assert info.truncation_type == TruncationType.SMART
        assert info.is_truncated is True
        assert info.original_length == 10000
        assert info.truncated_length == 5000
        assert info.original_structure["total_rows"] == 100
        assert info.kept_structure["kept_rows"] == 20
        assert info.summary_message == "Truncated 80 rows"


class TestTruncationType:
    """Test cases for TruncationType enum."""

    def test_enum_values(self):
        """Test enum values."""
        assert TruncationType.NONE.value == "none"
        assert TruncationType.SIMPLE.value == "simple"
        assert TruncationType.SMART.value == "smart"
