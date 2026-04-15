# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from typing import Final

FILE_AWARE_PARSER_SUBTYPE_BY_EXTENSION: Final[dict[str, str]] = {
    ".md": "markdown_sentence",
    ".txt": "sentence",
    ".pdf": "recursive_character",
    ".doc": "recursive_character",
    ".docx": "recursive_character",
}

FILE_AWARE_EXTENSIONS: Final[frozenset[str]] = frozenset(
    FILE_AWARE_PARSER_SUBTYPE_BY_EXTENSION
)
DEFAULT_FILE_AWARE_PARSER_SUBTYPE: Final[str] = "recursive_character"


def resolve_file_aware_parser_subtype(file_extension: str) -> str:
    """Resolve the parser subtype used by file-aware splitting."""
    return FILE_AWARE_PARSER_SUBTYPE_BY_EXTENSION.get(
        file_extension.lower(),
        DEFAULT_FILE_AWARE_PARSER_SUBTYPE,
    )


def supports_file_aware_split(file_extension: str) -> bool:
    """Return whether the extension is routed through the file-aware adapter."""
    return file_extension.lower() in FILE_AWARE_EXTENSIONS
