# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Excel and CSV truncation strategies using head + uniform sampling + tail approach.
"""

from typing import Any, Dict, List, Tuple

from .base import (
    BaseTruncationStrategy,
    SmartTruncationInfo,
    TruncationType,
)


class ExcelTruncationStrategy(BaseTruncationStrategy):
    """
    Smart truncation for Excel files using head + uniform sampling + tail strategy.

    This strategy preserves:
    1. Header row(s) - column names
    2. Head data rows - initial data that may contain important context
    3. Uniformly sampled middle rows - coverage across the entire dataset
    4. Tail data rows - may contain summary/conclusion data

    This ensures coverage of all data ranges (e.g., data from all 12 months
    in a yearly report) while preserving potentially important head/tail data.
    """

    # Distribution ratios for head/middle/tail (should sum to 1.0)
    HEAD_RATIO = 0.25  # 25% for head data rows
    MIDDLE_RATIO = 0.50  # 50% for uniformly sampled middle rows
    TAIL_RATIO = 0.25  # 25% for tail data rows

    def truncate(
        self, sheets_data: List[Dict[str, Any]], max_length: int
    ) -> Tuple[str, SmartTruncationInfo]:
        """
        Truncate Excel data with head + uniform sampling + tail strategy.

        Args:
            sheets_data: List of sheet data, each containing:
                - name: Sheet name
                - rows: List of row data (each row is a list of cell values)
            max_length: Maximum allowed length

        Returns:
            Tuple of (formatted_text, truncation_info)
        """
        info = SmartTruncationInfo(truncation_type=TruncationType.SMART)

        total_rows = sum(len(sheet.get("rows", [])) for sheet in sheets_data)
        total_sheets = len(sheets_data)

        info.original_structure = {
            "total_sheets": total_sheets,
            "total_rows": total_rows,
        }

        # First, format all content to check if truncation is needed
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

        # If content fits, no truncation needed
        if len(full_text) <= max_length:
            info.truncation_type = TruncationType.NONE
            info.is_truncated = False
            info.truncated_length = len(full_text)
            return full_text, info

        # Need truncation - apply smart truncation per sheet
        text_parts = []
        kept_rows_total = 0
        omitted_rows_total = 0

        for sheet in sheets_data:
            sheet_name = sheet.get("name", "Sheet")
            rows = sheet.get("rows", [])

            if not rows:
                continue

            sheet_text, kept_rows, omitted_rows = self._truncate_sheet_smart(
                sheet_name, rows, max_length // max(1, total_sheets)
            )
            text_parts.append(sheet_text)
            kept_rows_total += kept_rows
            omitted_rows_total += omitted_rows

        result_text = "\n\n".join(text_parts)

        # Final length check - if still too long, do simple truncation
        if len(result_text) > max_length:
            result_text = result_text[:max_length]
            info.truncation_type = TruncationType.SIMPLE

        info.is_truncated = True
        info.original_length = len(full_text)
        info.truncated_length = len(result_text)
        info.kept_structure = {
            "kept_rows": kept_rows_total,
            "omitted_rows": omitted_rows_total,
            "sampling_method": "head_uniform_tail",
        }

        info.summary_message = (
            f"[Smart Truncation Applied - Head + Uniform Sampling + Tail]\n"
            f"Total: {total_rows} rows across {total_sheets} sheet(s)\n"
            f"Kept: {kept_rows_total} rows (head + uniformly sampled middle + tail)\n"
            f"Omitted: {omitted_rows_total} rows"
        )

        return result_text, info

    def _truncate_sheet_smart(
        self, sheet_name: str, rows: List[List[Any]], max_length: int
    ) -> Tuple[str, int, int]:
        """
        Truncate a single sheet using head + uniform sampling + tail strategy.

        Distribution:
        - Header rows (always kept)
        - Head data rows (~25% of available space)
        - Middle rows (uniformly sampled, ~50% of available space)
        - Tail data rows (~25% of available space)

        Returns:
            Tuple of (sheet_text, kept_rows, omitted_rows)
        """
        max_columns = self.config.excel_max_columns
        total_rows = len(rows)

        # Format all rows first to estimate average row length
        all_formatted = self._format_rows(rows, max_columns)
        full_text = f"--- Sheet: {sheet_name} ---\n" + "\n".join(all_formatted)

        # If fits, return all
        if len(full_text) <= max_length:
            return full_text, total_rows, 0

        # Estimate average row length
        avg_row_len = len(full_text) / max(1, total_rows)

        # Calculate how many rows we can keep
        # Reserve space for sheet header and section markers (~300 chars)
        overhead = 300
        available_length = max_length - overhead
        max_rows_to_keep = max(5, int(available_length / avg_row_len))

        # Header rows are always kept
        header_count = min(self.config.excel_header_rows, total_rows)
        data_rows_total = total_rows - header_count

        # Calculate how many data rows we can keep
        data_rows_to_keep = max_rows_to_keep - header_count
        if data_rows_to_keep <= 0:
            data_rows_to_keep = 3  # At least keep some data

        # Ensure we don't exceed available data rows
        if data_rows_to_keep >= data_rows_total:
            # No truncation needed for this sheet
            return full_text[:max_length], total_rows, 0

        # Distribute data rows: head (25%), middle (50%), tail (25%)
        head_count = max(1, int(data_rows_to_keep * self.HEAD_RATIO))
        tail_count = max(1, int(data_rows_to_keep * self.TAIL_RATIO))
        middle_count = max(1, data_rows_to_keep - head_count - tail_count)

        # Adjust if we don't have enough middle rows to sample from
        middle_start = header_count + head_count
        middle_end = total_rows - tail_count
        middle_available = middle_end - middle_start

        if middle_available <= 0:
            # Not enough rows for middle section, just do head + tail
            head_count = data_rows_to_keep // 2
            tail_count = data_rows_to_keep - head_count
            middle_count = 0
            middle_available = 0

        # Extract sections
        header_section = rows[:header_count]
        head_section = rows[header_count : header_count + head_count]
        tail_section = rows[total_rows - tail_count :] if tail_count > 0 else []

        # Sample middle section uniformly
        if middle_count > 0 and middle_available > 0:
            if middle_count >= middle_available:
                # Keep all middle rows
                middle_indices = list(range(middle_available))
            else:
                # Uniform sampling
                middle_indices = self._uniform_sample_indices(
                    middle_available, middle_count, include_endpoints=True
                )
            middle_section = [
                (middle_start + idx, rows[middle_start + idx]) for idx in middle_indices
            ]
        else:
            middle_section = []

        # Format output
        parts = [f"--- Sheet: {sheet_name} ---"]

        # Header
        if header_section:
            parts.append("# Header")
            parts.extend(self._format_rows(header_section, max_columns))

        # Head data rows
        if head_section:
            parts.append(
                f"\n# Head Data (rows {header_count + 1}-{header_count + len(head_section)})"
            )
            parts.extend(self._format_rows(head_section, max_columns))

        # Middle sampled rows
        if middle_section:
            parts.append(
                f"\n# Middle Data ({len(middle_section)} rows sampled from rows {middle_start + 1}-{middle_end})"
            )
            prev_idx = header_count + head_count - 1
            for row_idx, row_data in middle_section:
                gap = row_idx - prev_idx - 1
                if gap > 0:
                    parts.append(f"  ... [{gap} rows skipped] ...")
                formatted = self._format_single_row(row_data, max_columns)
                parts.append(f"[Row {row_idx + 1}] {formatted}")
                prev_idx = row_idx

            # Gap before tail
            if tail_section:
                gap_to_tail = (total_rows - tail_count) - prev_idx - 1
                if gap_to_tail > 0:
                    parts.append(f"  ... [{gap_to_tail} rows skipped] ...")
        elif head_section and tail_section:
            # No middle section, show gap between head and tail
            gap = total_rows - tail_count - (header_count + head_count)
            if gap > 0:
                parts.append(f"\n... [{gap} rows omitted] ...")

        # Tail data rows
        if tail_section:
            parts.append(
                f"\n# Tail Data (rows {total_rows - tail_count + 1}-{total_rows})"
            )
            parts.extend(self._format_rows(tail_section, max_columns))

        sheet_text = "\n".join(parts)
        kept_rows = (
            header_count + len(head_section) + len(middle_section) + len(tail_section)
        )
        omitted_rows = total_rows - kept_rows

        return sheet_text, kept_rows, omitted_rows

    def _format_rows(self, rows: List[List[Any]], max_columns: int) -> List[str]:
        """Format rows as pipe-separated strings."""
        formatted = []
        for row in rows:
            formatted.append(self._format_single_row(row, max_columns))
        return formatted

    def _format_single_row(self, row: List[Any], max_columns: int) -> str:
        """Format a single row as pipe-separated string."""
        if len(row) > max_columns:
            display_row = row[:max_columns]
            suffix = f" | ... (+{len(row) - max_columns} columns)"
        else:
            display_row = row
            suffix = ""

        row_str = " | ".join(
            str(cell) if cell is not None else "" for cell in display_row
        )
        return row_str + suffix


class CSVTruncationStrategy(ExcelTruncationStrategy):
    """Smart truncation for CSV files (reuses Excel strategy)."""

    def truncate_csv_rows(
        self, rows: List[List[str]], max_length: int
    ) -> Tuple[str, SmartTruncationInfo]:
        """
        Truncate CSV data.

        Args:
            rows: List of rows (each row is a list of cell values)
            max_length: Maximum allowed length

        Returns:
            Tuple of (formatted_text, truncation_info)
        """
        # Wrap as single sheet
        sheets_data = [{"name": "CSV Data", "rows": rows}]
        return self.truncate(sheets_data, max_length)
