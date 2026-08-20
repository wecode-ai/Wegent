# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Independent Excel and CSV truncation strategies."""

from dataclasses import dataclass
from typing import Any, Dict, List, Sequence, Tuple

from knowledge_engine.excel import (
    ExcelSheet,
    format_excel_row_compact,
    format_excel_sheet_header,
    serialize_excel_sheet_compact,
)

from .base import BaseTruncationStrategy, SmartTruncationInfo, TruncationType


@dataclass(frozen=True)
class _SheetTruncationResult:
    """Outcome of truncating one sheet, named instead of positional."""

    text: str
    kept_rows: int
    omitted_rows: int
    marker_complete: bool


class ExcelTruncationStrategy(BaseTruncationStrategy):
    """Truncate sparse Excel rows without cutting a serialized row."""

    def truncate(
        self,
        sheets: Sequence[ExcelSheet],
        max_length: int,
    ) -> Tuple[str, SmartTruncationInfo]:
        """Keep complete physical rows within a strict character budget."""
        populated_sheets = [sheet for sheet in sheets if sheet.rows]
        total_rows = sum(len(sheet.rows) for sheet in populated_sheets)
        full_text = "\n\n".join(
            serialize_excel_sheet_compact(sheet) for sheet in populated_sheets
        )
        info = SmartTruncationInfo(
            truncation_type=TruncationType.SMART,
            original_length=len(full_text),
            original_structure={
                "total_sheets": len(populated_sheets),
                "total_rows": total_rows,
            },
        )
        if len(full_text) <= max_length:
            info.truncation_type = TruncationType.NONE
            info.truncated_length = len(full_text)
            return full_text, info

        separator_length = max(0, len(populated_sheets) - 1) * 2
        available = max(0, max_length - separator_length)
        remaining_budget = available
        text_parts: list[str] = []
        kept_rows = 0
        omitted_rows = 0
        all_markers_complete = True
        for index, sheet in enumerate(populated_sheets):
            # Sheets that underuse their budget pass the surplus onward.
            budget = remaining_budget // (len(populated_sheets) - index)
            result = self._truncate_sheet(sheet, budget)
            if result.text:
                text_parts.append(result.text)
            remaining_budget -= len(result.text)
            kept_rows += result.kept_rows
            omitted_rows += result.omitted_rows
            if result.omitted_rows and not result.marker_complete:
                all_markers_complete = False

        result = "\n\n".join(text_parts)
        info.is_truncated = True
        info.truncated_length = len(result)
        info.kept_structure = {
            "kept_rows": kept_rows,
            "omitted_rows": omitted_rows,
            "sampling_method": "head_tail_contiguous",
            "omission_marker_complete": all_markers_complete,
        }
        info.summary_message = (
            "[Smart Truncation Applied - Head + Tail (contiguous)]\n"
            f"Total: {total_rows} rows across {len(populated_sheets)} sheet(s)\n"
            f"Kept: {kept_rows} complete rows\n"
            f"Omitted: {omitted_rows} rows"
        )
        return result, info

    def _truncate_sheet(
        self,
        sheet: ExcelSheet,
        max_length: int,
    ) -> _SheetTruncationResult:
        header = format_excel_sheet_header(sheet.name)
        rows = [format_excel_row_compact(row) for row in sheet.rows]
        total_rows = len(rows)
        if len(header) > max_length:
            return _SheetTruncationResult("", 0, total_rows, False)

        # Count rows with exact length arithmetic and render once, so the
        # greedy fit stays O(n) instead of re-joining the selection per row.
        prefix_lengths = [0]
        for row in rows:
            prefix_lengths.append(prefix_lengths[-1] + len(row))

        if self._selection_length(header, prefix_lengths, 0, 0) > max_length:
            return _SheetTruncationResult(header, 0, total_rows, False)

        head_count = 0
        tail_count = 0
        prefer_head = True
        while head_count + tail_count < total_rows:
            directions = ("head", "tail") if prefer_head else ("tail", "head")
            accepted = False
            for direction in directions:
                next_head = head_count + (direction == "head")
                next_tail = tail_count + (direction == "tail")
                if (
                    self._selection_length(
                        header,
                        prefix_lengths,
                        next_head,
                        next_tail,
                    )
                    <= max_length
                ):
                    head_count = next_head
                    tail_count = next_tail
                    prefer_head = direction != "head"
                    accepted = True
                    break
            if not accepted:
                break

        kept_rows = head_count + tail_count
        omitted_rows = total_rows - kept_rows
        best_text = self._render_selection(header, rows, head_count, tail_count)
        return _SheetTruncationResult(
            best_text, kept_rows, omitted_rows, omitted_rows > 0
        )

    @staticmethod
    def _omission_marker(omitted_rows: int) -> str:
        return f"... [{omitted_rows} rows omitted] ..."

    @classmethod
    def _selection_length(
        cls,
        header: str,
        prefix_lengths: list[int],
        head_count: int,
        tail_count: int,
    ) -> int:
        """Return the exact rendered length of a head/tail selection."""
        total_rows = len(prefix_lengths) - 1
        omitted_rows = total_rows - head_count - tail_count
        line_count = 1 + head_count + tail_count + (1 if omitted_rows else 0)
        content_length = len(header) + prefix_lengths[head_count]
        if tail_count:
            content_length += (
                prefix_lengths[total_rows] - prefix_lengths[total_rows - tail_count]
            )
        if omitted_rows:
            content_length += len(cls._omission_marker(omitted_rows))
        return content_length + line_count - 1

    @classmethod
    def _render_selection(
        cls,
        header: str,
        rows: list[str],
        head_count: int,
        tail_count: int,
    ) -> str:
        omitted_rows = len(rows) - head_count - tail_count
        lines = [header]
        lines.extend(rows[:head_count])
        if omitted_rows:
            lines.append(cls._omission_marker(omitted_rows))
        if tail_count:
            lines.extend(rows[len(rows) - tail_count :])
        return "\n".join(lines)


class CSVTruncationStrategy(BaseTruncationStrategy):
    """Preserve the established dense CSV formatting and truncation."""

    HEAD_RATIO = 0.5
    MIDDLE_RATIO = 0.0
    TAIL_RATIO = 0.5

    def truncate(
        self,
        sheets_data: List[Dict[str, Any]],
        max_length: int,
    ) -> Tuple[str, SmartTruncationInfo]:
        info = SmartTruncationInfo(truncation_type=TruncationType.SMART)
        total_rows = sum(len(sheet.get("rows", [])) for sheet in sheets_data)
        total_sheets = len(sheets_data)
        info.original_structure = {
            "total_sheets": total_sheets,
            "total_rows": total_rows,
        }

        full_text_parts = []
        for sheet in sheets_data:
            sheet_name = sheet.get("name", "Sheet")
            rows = sheet.get("rows", [])
            if rows:
                formatted_rows = self._format_rows(rows, self.config.excel_max_columns)
                full_text_parts.append(
                    f"--- Sheet: {sheet_name} ---\n" + "\n".join(formatted_rows)
                )
        full_text = "\n\n".join(full_text_parts)
        info.original_length = len(full_text)
        if len(full_text) <= max_length:
            info.truncation_type = TruncationType.NONE
            info.truncated_length = len(full_text)
            return full_text, info

        text_parts = []
        kept_rows_total = 0
        omitted_rows_total = 0
        for sheet in sheets_data:
            sheet_name = sheet.get("name", "Sheet")
            rows = sheet.get("rows", [])
            if not rows:
                continue
            sheet_text, kept_rows, omitted_rows = self._truncate_sheet_smart(
                sheet_name,
                rows,
                max_length // max(1, total_sheets),
            )
            text_parts.append(sheet_text)
            kept_rows_total += kept_rows
            omitted_rows_total += omitted_rows

        result_text = "\n\n".join(text_parts)
        if len(result_text) > max_length:
            result_text = self._cut_at_row_boundary(result_text, max_length)
            info.truncation_type = TruncationType.SIMPLE
        info.is_truncated = True
        info.truncated_length = len(result_text)
        info.kept_structure = {
            "kept_rows": kept_rows_total,
            "omitted_rows": omitted_rows_total,
            "sampling_method": "head_tail_contiguous",
        }
        info.summary_message = (
            "[Smart Truncation Applied - Head + Tail (contiguous)]\n"
            f"Total: {total_rows} rows across {total_sheets} sheet(s)\n"
            f"Kept: {kept_rows_total} rows "
            "(contiguous head + tail; middle dropped by default)\n"
            f"Omitted: {omitted_rows_total} rows"
        )
        return result_text, info

    @staticmethod
    def _cut_at_row_boundary(text: str, max_length: int) -> str:
        """Cut at the last complete line and append a truncation marker."""
        marker = "\n... [truncated] ..."
        text_budget = max(0, max_length - len(marker))
        last_boundary = text.rfind("\n", 0, text_budget)
        if last_boundary > 0:
            return text[:last_boundary] + marker
        return text[:text_budget] + marker

    def _truncate_sheet_smart(
        self,
        sheet_name: str,
        rows: List[List[Any]],
        max_length: int,
    ) -> Tuple[str, int, int]:
        max_columns = self.config.excel_max_columns
        total_rows = len(rows)
        all_formatted = self._format_rows(rows, max_columns)
        full_text = f"--- Sheet: {sheet_name} ---\n" + "\n".join(all_formatted)
        if len(full_text) <= max_length:
            return full_text, total_rows, 0

        avg_row_len = len(full_text) / max(1, total_rows)
        max_rows_to_keep = max(5, int((max_length - 300) / avg_row_len))
        header_count = min(self.config.excel_header_rows, total_rows)
        data_rows_total = total_rows - header_count
        data_rows_to_keep = max_rows_to_keep - header_count
        if data_rows_to_keep <= 0:
            data_rows_to_keep = 3
        if data_rows_to_keep >= data_rows_total:
            return self._cut_at_row_boundary(full_text, max_length), total_rows, 0

        head_count = max(1, int(data_rows_to_keep * self.HEAD_RATIO))
        tail_count = max(1, int(data_rows_to_keep * self.TAIL_RATIO))
        remainder = max(0, data_rows_to_keep - head_count - tail_count)
        middle_count = 0 if self.MIDDLE_RATIO <= 0 else max(1, remainder)
        if not middle_count:
            head_count += remainder

        middle_start = header_count + head_count
        middle_end = total_rows - tail_count
        middle_available = middle_end - middle_start
        if middle_available <= 0:
            head_count = data_rows_to_keep // 2
            tail_count = data_rows_to_keep - head_count
            middle_count = 0
            middle_available = 0

        header_section = rows[:header_count]
        head_section = rows[header_count : header_count + head_count]
        tail_section = rows[total_rows - tail_count :] if tail_count else []
        middle_section = self._sample_middle_rows(
            rows,
            middle_start,
            middle_available,
            middle_count,
        )

        parts = [f"--- Sheet: {sheet_name} ---"]
        if header_section:
            parts.append("# Header")
            parts.extend(self._format_rows(header_section, max_columns))
        if head_section:
            parts.append(
                f"\n# Head Data (rows {header_count + 1}-"
                f"{header_count + len(head_section)})"
            )
            parts.extend(self._format_rows(head_section, max_columns))
        self._append_middle_or_gap(
            parts,
            middle_section,
            middle_start,
            middle_end,
            header_count + head_count - 1,
            total_rows - tail_count,
            max_columns,
            bool(tail_section),
        )
        if not middle_section and head_section and tail_section:
            gap = total_rows - tail_count - (header_count + head_count)
            if gap > 0:
                parts.append(f"\n... [{gap} rows omitted] ...")
        if tail_section:
            parts.append(
                f"\n# Tail Data (rows {total_rows - tail_count + 1}-{total_rows})"
            )
            parts.extend(self._format_rows(tail_section, max_columns))

        kept_rows = (
            header_count + len(head_section) + len(middle_section) + len(tail_section)
        )
        return "\n".join(parts), kept_rows, total_rows - kept_rows

    def _sample_middle_rows(
        self,
        rows: List[List[Any]],
        start: int,
        available: int,
        count: int,
    ) -> List[Tuple[int, List[Any]]]:
        if count <= 0 or available <= 0:
            return []
        if count >= available:
            indices = list(range(available))
        else:
            indices = self._uniform_sample_indices(
                available,
                count,
                include_endpoints=True,
            )
        return [(start + index, rows[start + index]) for index in indices]

    def _append_middle_or_gap(
        self,
        parts: List[str],
        middle: List[Tuple[int, List[Any]]],
        middle_start: int,
        middle_end: int,
        previous_index: int,
        tail_start: int,
        max_columns: int,
        has_tail: bool,
    ) -> None:
        if not middle:
            return
        parts.append(
            f"\n# Middle Data ({len(middle)} rows sampled from rows "
            f"{middle_start + 1}-{middle_end})"
        )
        for row_index, row_data in middle:
            gap = row_index - previous_index - 1
            if gap > 0:
                parts.append(f"  ... [{gap} rows skipped] ...")
            parts.append(
                f"[Row {row_index + 1}] "
                f"{self._format_single_row(row_data, max_columns)}"
            )
            previous_index = row_index
        if has_tail and tail_start - previous_index - 1 > 0:
            parts.append(f"  ... [{tail_start - previous_index - 1} rows skipped] ...")

    def _format_rows(self, rows: List[List[Any]], max_columns: int) -> List[str]:
        return [self._format_single_row(row, max_columns) for row in rows]

    @staticmethod
    def _format_single_row(row: List[Any], max_columns: int) -> str:
        if len(row) > max_columns:
            display_row = row[:max_columns]
            suffix = f" | ... (+{len(row) - max_columns} columns)"
        else:
            display_row = row
            suffix = ""
        return (
            " | ".join(str(cell) if cell is not None else "" for cell in display_row)
            + suffix
        )

    def truncate_csv_rows(
        self,
        rows: List[List[str]],
        max_length: int,
    ) -> Tuple[str, SmartTruncationInfo]:
        """Wrap CSV rows as the established single pseudo-sheet."""
        return self.truncate([{"name": "CSV Data", "rows": rows}], max_length)
