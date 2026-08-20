# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Excel source reader that preserves worksheet identity."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

from fsspec import AbstractFileSystem
from llama_index.core.readers.base import BaseReader
from llama_index.core.schema import Document

from knowledge_engine.excel import read_excel_sheets, serialize_excel_rows


class ExcelSourceReader(BaseReader):
    """Read each worksheet into a separate document with sheet metadata."""

    def load_data(
        self,
        file: Path,
        extra_info: Optional[Dict[str, Any]] = None,
        fs: Optional[AbstractFileSystem] = None,
    ) -> List[Document]:
        """Load non-empty worksheets as independently indexed documents."""
        if fs is None:
            # Dispatch happens upstream on the declared extension, so the
            # path may carry no suffix; openpyxl rejects suffixless paths
            # by name, so feed it the bytes instead.
            sheets = read_excel_sheets(Path(file).read_bytes())
        else:
            with fs.open(file, "rb") as source:
                sheets = read_excel_sheets(source)

        return [
            Document(
                text=serialize_excel_rows(sheet.rows),
                metadata={**(extra_info or {}), "sheet_name": sheet.name},
            )
            for sheet in sheets
            if sheet.rows
        ]
