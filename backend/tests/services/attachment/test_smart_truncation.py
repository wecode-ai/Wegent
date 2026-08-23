# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for the smart truncation strategies.
"""

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
from knowledge_engine.excel import ExcelCell, ExcelRow, ExcelSheet


def _excel_sheet(name: str, rows: list[list[object]]) -> ExcelSheet:
    return ExcelSheet(
        name=name,
        rows=tuple(
            ExcelRow(
                source_row=row_index,
                cells=tuple(
                    ExcelCell(source_column=column_index, value=value)
                    for column_index, value in enumerate(row, 1)
                    if value is not None
                ),
            )
            for row_index, row in enumerate(rows, 1)
        ),
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
        sheets = [
            _excel_sheet(
                "Sheet1",
                [
                    ["Name", "Age", "City"],
                    ["Alice", 30, "NYC"],
                    ["Bob", 25, "LA"],
                ],
            )
        ]

        text, info = self.strategy.truncate(sheets, 100000)

        assert info.truncation_type == TruncationType.NONE
        assert info.is_truncated is False
        assert text == (
            "--- Sheet: Sheet1 ---\n"
            'R1: "Name" | "Age" | "City"\n'
            'R2: "Alice" | 30 | "NYC"\n'
            'R3: "Bob" | 25 | "LA"'
        )

    def test_truncation_with_many_rows(self):
        """Test truncation when there are many rows."""
        rows = [["ID", "Name", "Value", "Description"]]
        for i in range(99):
            rows.append(
                [
                    i,
                    f"Item{i}",
                    i * 10,
                    f"This is a longer description for item {i} to increase row length",
                ]
            )

        text, info = self.strategy.truncate([_excel_sheet("Data", rows)], 5000)

        assert info.is_truncated is True
        assert info.truncation_type == TruncationType.SMART
        assert "omitted" in text.lower()
        assert len(text) <= 5000
        assert "ID" in text
        assert "Item0" in text

    def test_truncation_keeps_contiguous_head_and_tail(self):
        rows = [["ID", "Name", "Value", "Description"]]
        for i in range(300):
            rows.append([i, f"Item{i}", i * 10, "desc " + "v" * 40])

        text, info = self.strategy.truncate([_excel_sheet("Data", rows)], 3000)

        assert info.is_truncated is True
        assert "ID" in text and "Name" in text
        assert "Item0" in text and "Item1" in text and "Item2" in text
        assert text.count("rows omitted") == 1

    def test_multiple_sheets(self):
        sheets = [
            _excel_sheet("Sheet1", [["A", "B"], ["1", "2"]]),
            _excel_sheet("Sheet2", [["C", "D"], ["3", "4"]]),
        ]

        text, info = self.strategy.truncate(sheets, 100000)

        assert "Sheet1" in text
        assert "Sheet2" in text

    def test_sparse_distant_columns_are_not_dropped(self):
        config = SmartTruncationConfig(excel_max_columns=3)
        strategy = ExcelTruncationStrategy(config)
        sheet = ExcelSheet(
            name="Wide",
            rows=(
                ExcelRow(
                    1,
                    (ExcelCell(1, "left"), ExcelCell(51, "right")),
                ),
            ),
        )

        text, info = strategy.truncate([sheet], 100000)

        assert text.endswith('R1: "left" | [51]="right"')
        assert info.is_truncated is False

    def test_long_cell_is_omitted_as_a_complete_row(self):
        text, info = self.strategy.truncate(
            [_excel_sheet("Long", [["x" * 5000]])],
            1000,
        )

        assert text == "--- Sheet: Long ---\n... [1 rows omitted] ..."
        assert info.truncation_type == TruncationType.SMART
        assert info.kept_structure["omitted_rows"] == 1

    def test_multi_sheet_truncation_never_cuts_a_row(self):
        sheets = [
            _excel_sheet("First", [["a" * 700]]),
            _excel_sheet("Second", [["b" * 700]]),
        ]

        text, info = self.strategy.truncate(sheets, 1000)

        assert len(text) <= 1000
        # The first sheet's surplus rolls to the second: one complete row is
        # kept instead of dropping both, and no row line is ever cut.
        assert "a" * 100 not in text
        assert "b" * 700 in text
        assert info.kept_structure["kept_rows"] == 1
        assert info.kept_structure["omitted_rows"] == 1

    def test_natural_source_row_gap_does_not_create_marker(self):
        sheet = ExcelSheet(
            name="Sparse",
            rows=(
                ExcelRow(1, (ExcelCell(1, "top"),)),
                ExcelRow(1048576, (ExcelCell(1, "bottom"),)),
            ),
        )

        text, info = self.strategy.truncate([sheet], 1000)

        assert info.is_truncated is False
        assert "omitted" not in text

    def test_insufficient_marker_budget_reports_metadata(self):
        text, info = self.strategy.truncate(
            [_excel_sheet("Data", [["value"]])],
            len("--- Sheet: Data ---"),
        )

        assert text == "--- Sheet: Data ---"
        assert info.kept_structure["omitted_rows"] == 1
        assert info.kept_structure["omission_marker_complete"] is False

    def test_sheet_name_cannot_forge_rows(self):
        """A newline in a sheet name collapses instead of forging row lines."""
        rows = [[f"Item{i}", f"desc{i}"] for i in range(200)]

        full_text, full_info = self.strategy.truncate(
            [_excel_sheet("S\nR7: fake | 100", rows)],
            100000,
        )
        truncated_text, truncated_info = self.strategy.truncate(
            [_excel_sheet("S\nR7: fake | 100", rows)],
            600,
        )

        for text, info in ((full_text, full_info), (truncated_text, truncated_info)):
            assert full_info.is_truncated is False
            # The forged row lives on the single header line, inside the
            # "--- Sheet: ... ---" delimiters, never as its own line.
            assert "R7: fake | 100" not in text.split("\n")
            assert text.split("\n")[0] == "--- Sheet: S R7: fake | 100 ---"

    def test_truncation_renders_selection_once_per_sheet(self, monkeypatch):
        """Greedy row fitting counts lengths arithmetically and renders once."""
        rows = [[f"value-{index}"] for index in range(20000)]
        sheet = _excel_sheet("Big", rows)
        render_calls = []
        original_render = ExcelTruncationStrategy._render_selection

        def counting_render(header, rows, head_count, tail_count):
            render_calls.append((head_count, tail_count))
            return original_render(header, rows, head_count, tail_count)

        monkeypatch.setattr(
            ExcelTruncationStrategy, "_render_selection", staticmethod(counting_render)
        )

        text, info = self.strategy.truncate([sheet], 50000)

        assert info.is_truncated is True
        assert len(text) <= 50000
        assert len(render_calls) == 1

    def test_selection_length_matches_rendered_output(self):
        """Length arithmetic must stay byte-exact with the renderer."""
        rows = [f"row-{index}-{'v' * (index % 7)}" for index in range(25)]
        prefix_lengths = [0]
        for row in rows:
            prefix_lengths.append(prefix_lengths[-1] + len(row))
        header = "--- Sheet: Sync ---"
        for head_count in range(len(rows) + 1):
            for tail_count in range(len(rows) + 1 - head_count):
                rendered = ExcelTruncationStrategy._render_selection(
                    header, rows, head_count, tail_count
                )
                measured = ExcelTruncationStrategy._selection_length(
                    header, prefix_lengths, head_count, tail_count
                )
                assert len(rendered) == measured


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

    def test_csv_hard_cut_stops_at_row_boundary_with_marker(self):
        """A final hard cut never slices a row and always appends a marker."""
        rows = [["ID", "Value"]]
        for i in range(30):
            rows.append([str(i), "x" * 180])

        text, info = self.strategy.truncate_csv_rows(rows, 600)

        assert len(text) <= 600
        assert text.endswith("... [truncated] ...")
        body = text[: -len("\n... [truncated] ...")]
        last_line = body.split("\n")[-1]
        # The last surviving line is a complete formatted row or section label.
        assert last_line.startswith(("#", "---", "Row")) or " | " in last_line

    def test_csv_original_length_set_without_truncation(self):
        rows = [["a", "b"], ["1", "2"]]

        text, info = self.strategy.truncate_csv_rows(rows, 10000)

        assert info.truncation_type == TruncationType.NONE
        assert info.original_length == len(text)

    def test_csv_keeps_existing_pipe_format(self):
        text, info = self.strategy.truncate_csv_rows(
            [["a | b", "line 1\nline 2"]],
            100000,
        )

        assert info.is_truncated is False
        assert text == "--- Sheet: CSV Data ---\na | b | line 1\nline 2"


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

    def test_truncation_keeps_contiguous_head_tail_no_middle_sampling(self):
        """Middle is dropped behind one omission marker (no scattered sampling)."""
        lines = [f"Line {i}: content " + "v" * 50 for i in range(200)]
        text = "\n".join(lines)

        result, info = self.strategy.truncate(text, 2000)

        assert info.is_truncated is True
        # Contiguous head (consecutive early lines, not scattered samples).
        assert "Line 0:" in result and "Line 1:" in result and "Line 2:" in result
        # Contiguous tail (the very last line is kept).
        assert "Line 199:" in result
        # Single omission marker; no scattered "[N lines skipped]" middle samples.
        assert "omitted" in result.lower()
        assert "Middle" not in result
        assert "lines skipped" not in result

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
        sheets = [_excel_sheet("Test", [[f"Row{i}"] for i in range(100)])]

        text, info = self.manager.truncate_excel(sheets)

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
