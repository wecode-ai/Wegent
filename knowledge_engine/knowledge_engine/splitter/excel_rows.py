# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Row-atomic Excel chunking for the knowledge ingestion pipeline.

Excel structural integrity is a format-correctness property: a chunk must
never cut a serialized row. This module parses the canonical row text that
ExcelSourceReader produced (still intact at this point, so parsing fails
fast instead of guessing), packs whole physical rows into size-bounded
nodes, and falls back to explicit cell fragments only for values that
cannot fit whole. Retrieval and display text are generated directly from
the structured rows, so no post-split salvage is needed.
"""

from __future__ import annotations

from dataclasses import dataclass

from llama_index.core.schema import BaseNode, Document, TextNode

from knowledge_engine.excel import (
    MAX_EXCEL_CONTEXT_NAME,
    ExcelCell,
    ExcelCellFragment,
    ExcelRow,
    dumps_excel_value,
    format_excel_fragment_readable,
    format_excel_retrieval_prefix,
    format_excel_row_readable,
    format_excel_sheet_header,
    parse_excel_row_line,
    serialize_excel_fragment,
    serialize_excel_row,
)
from knowledge_engine.splitter.hierarchical import HierarchicalNodes
from knowledge_engine.storage.base import (
    DISPLAY_TEXT_METADATA_KEY,
    RETRIEVAL_TEXT_METADATA_KEY,
)

EXCEL_ROWS_PARSER_SUBTYPE = "excel_rows"

# Matches the smallest chunk_size the splitter config models allow, below
# which even a single coordinate line cannot fit.
MIN_EXCEL_CHUNK_BUDGET = 128


class _BudgetExhausted(ValueError):
    """A fragment cannot fit under the current budget.

    Only this signal may trigger the prefix-degradation retry in
    `_document_lines_with_context`: a shorter prefix frees fragment room.
    Upstream data corruption also raises ValueError and must propagate
    instead of being retried against a degraded context.
    """


@dataclass(frozen=True)
class _ChunkLine:
    """One atomic chunk line in both canonical and readable form."""

    canonical: str
    readable: str


@dataclass(frozen=True)
class _Budget:
    """Independent size bounds for the two text forms of one node level.

    ``retrieval`` bounds the embedded text (readable lines plus the sheet
    prefix); ``canonical`` bounds the stored display text (canonical lines
    plus the sheet header). Both prefixes are paid out of their own budget,
    so neither form can exceed the configured chunk size.
    """

    retrieval: int
    canonical: int

    def reduced_by_prefixes(
        self, retrieval_prefix: str, display_prefix: str
    ) -> _Budget:
        return _Budget(
            retrieval=self.retrieval - len(retrieval_prefix),
            canonical=self.canonical - len(display_prefix),
        )


@dataclass(frozen=True)
class _SheetContext:
    """Per-document sheet context rendered once and budgeted per line."""

    retrieval_prefix: str
    display_prefix: str


def _sheet_context(
    document: Document, *, name_cap: int = MAX_EXCEL_CONTEXT_NAME
) -> _SheetContext:
    """Render the sheet context prefixes from the document's sheet name."""
    sheet_name = document.metadata.get("sheet_name") or ""
    header = format_excel_sheet_header(sheet_name, name_cap=name_cap)
    return _SheetContext(
        retrieval_prefix=format_excel_retrieval_prefix(sheet_name, name_cap=name_cap),
        display_prefix=f"{header}\n" if header else "",
    )


def _document_lines_with_context(
    document: Document, chunk_size: int
) -> tuple[_SheetContext, list[_ChunkLine]]:
    """Build lines with sheet context, degrading context before row data.

    Row data outranks context: if a cell fragment cannot fit under the
    full-width prefixes (only possible near the minimum chunk budget),
    the prefixes are dropped and the lines are rebuilt once. Normal rows
    never trigger this because they fit whole or split into cell groups
    without fragmenting values.
    """
    context = _sheet_context(document)
    budget = _Budget(retrieval=chunk_size, canonical=chunk_size)
    try:
        lines = _document_lines(
            document,
            budget.reduced_by_prefixes(
                context.retrieval_prefix, context.display_prefix
            ),
        )
    except _BudgetExhausted:
        # Only budget starvation is retried against a degraded context;
        # parse failures are data corruption and propagate unchanged.
        context = _sheet_context(document, name_cap=0)
        lines = _document_lines(
            document,
            budget.reduced_by_prefixes(
                context.retrieval_prefix, context.display_prefix
            ),
        )
    return context, lines


def build_excel_row_nodes(
    *,
    documents: list[Document],
    chunk_size: int,
) -> list[TextNode]:
    """Pack whole Excel rows into size-bounded flat nodes."""
    _assert_budget(chunk_size)
    nodes: list[TextNode] = []
    for document in documents:
        # Both sheet prefixes are part of the node text, so each is paid
        # out of its own budget rather than appended afterwards; context
        # degrades before row data ever does.
        context, lines = _document_lines_with_context(document, chunk_size)
        metadata = dict(document.metadata or {})
        for chunk in _pack_lines(
            lines,
            _Budget(retrieval=chunk_size, canonical=chunk_size).reduced_by_prefixes(
                context.retrieval_prefix, context.display_prefix
            ),
        ):
            nodes.append(_lines_to_node(chunk, metadata, context))
    return nodes


def build_excel_hierarchical_nodes(
    *,
    documents: list[Document],
    parent_chunk_size: int,
    child_chunk_size: int,
) -> HierarchicalNodes:
    """Pack Excel rows into row-atomic parent and child nodes."""
    _assert_budget(parent_chunk_size)
    _assert_budget(child_chunk_size)
    if parent_chunk_size < child_chunk_size:
        raise ValueError(
            f"parent_chunk_size {parent_chunk_size} must be at least "
            f"child_chunk_size {child_chunk_size} for Excel row packing"
        )
    parent_nodes: list[BaseNode] = []
    child_nodes: list[BaseNode] = []
    for document in documents:
        context, lines = _document_lines_with_context(document, child_chunk_size)
        parent_budget = _Budget(
            retrieval=parent_chunk_size, canonical=parent_chunk_size
        ).reduced_by_prefixes(context.retrieval_prefix, context.display_prefix)
        child_budget = _Budget(
            retrieval=child_chunk_size, canonical=child_chunk_size
        ).reduced_by_prefixes(context.retrieval_prefix, context.display_prefix)
        # Lines are split at the child budget so every line fits both levels.
        metadata = dict(document.metadata or {})
        for parent_lines in _pack_lines(lines, parent_budget):
            parent = _lines_to_node(
                parent_lines,
                metadata,
                context,
                extra={"node_role": "parent"},
            )
            parent_nodes.append(parent)
            for child_lines in _pack_lines(parent_lines, child_budget):
                child_nodes.append(
                    _lines_to_node(
                        child_lines,
                        metadata,
                        context,
                        extra={
                            "node_role": "child",
                            "parent_node_id": parent.node_id,
                        },
                    )
                )
    return HierarchicalNodes(parent_nodes=parent_nodes, child_nodes=child_nodes)


def _assert_budget(budget: int) -> None:
    if budget < MIN_EXCEL_CHUNK_BUDGET:
        raise ValueError(
            f"Excel chunk budget {budget} is below the minimum "
            f"{MIN_EXCEL_CHUNK_BUDGET} required for a coordinate line"
        )


def _document_lines(document: Document, budget: _Budget) -> list[_ChunkLine]:
    text = document.text or ""
    if not text.strip():
        return []
    lines: list[_ChunkLine] = []
    for raw_line in text.split("\n"):
        # The text is the untouched canonical output of the reader, so a
        # parse failure here means an upstream stage corrupted it.
        row = parse_excel_row_line(raw_line)
        lines.extend(_row_to_lines(row, raw_line, budget))
    return lines


def _row_to_lines(row: ExcelRow, canonical: str, budget: _Budget) -> list[_ChunkLine]:
    readable = format_excel_row_readable(row)
    if len(canonical) <= budget.canonical and len(readable) <= budget.retrieval:
        return [_ChunkLine(canonical=canonical, readable=readable)]
    return _split_row_lines(row, budget)


def _split_row_lines(row: ExcelRow, budget: _Budget) -> list[_ChunkLine]:
    """Split an overlong row into cell groups, fragmenting long values."""
    canonical_overhead = len(f'{{"source_row":{row.source_row},"cells":[') + 2
    readable_overhead = len(f"Row {row.source_row}, ")
    lines: list[_ChunkLine] = []
    group: list[ExcelCell] = []
    canonical_len = canonical_overhead
    readable_len = readable_overhead
    for cell in row.cells:
        cell_canonical_len, cell_readable_len = _cell_lengths(cell)
        if (
            canonical_overhead + cell_canonical_len > budget.canonical
            or readable_overhead + cell_readable_len > budget.retrieval
        ):
            if group:
                lines.append(_cell_group_line(row.source_row, group))
                group = []
                canonical_len = canonical_overhead
                readable_len = readable_overhead
            lines.extend(_cell_fragment_lines(row.source_row, cell, budget))
            continue
        next_canonical = canonical_len + cell_canonical_len + (1 if group else 0)
        next_readable = readable_len + cell_readable_len + (2 if group else 0)
        if group and (
            next_canonical > budget.canonical or next_readable > budget.retrieval
        ):
            lines.append(_cell_group_line(row.source_row, group))
            group = []
            canonical_len = canonical_overhead
            readable_len = readable_overhead
            next_canonical = canonical_len + cell_canonical_len
            next_readable = readable_len + cell_readable_len
        group.append(cell)
        canonical_len = next_canonical
        readable_len = next_readable
    if group:
        lines.append(_cell_group_line(row.source_row, group))
    return lines


def _cell_lengths(cell: ExcelCell) -> tuple[int, int]:
    """Return the cell's lengths within canonical and readable row lines."""
    canonical = len(f"[{cell.source_column},{dumps_excel_value(cell.value)}]")
    readable = len(f"Column {cell.source_column}: {dumps_excel_value(cell.value)}")
    return canonical, readable


def _cell_group_line(source_row: int, group: list[ExcelCell]) -> _ChunkLine:
    """Render one cell group as a complete canonical row line."""
    return _ChunkLine(
        canonical=serialize_excel_row(ExcelRow(source_row, tuple(group))),
        readable=format_excel_row_readable(ExcelRow(source_row, tuple(group))),
    )


def _cell_fragment_lines(
    source_row: int,
    cell: ExcelCell,
    budget: _Budget,
) -> list[_ChunkLine]:
    """Split one overlong cell value into coordinate-bearing fragments."""
    if isinstance(cell.value, str):
        text, encoding = cell.value, "text"
    else:
        # Structured values (e.g. formulas) fragment their JSON encoding.
        text, encoding = dumps_excel_value(cell.value), "json"
    # A fragment holds at least one character, so there can never be more
    # fragments than value characters and this digit width is always enough.
    digits = len(str(max(1, len(text))))
    pieces = _split_value(text, source_row, cell.source_column, digits, budget)
    return [
        _fragment_line(
            ExcelCellFragment(
                source_row=source_row,
                source_column=cell.source_column,
                fragment_index=index,
                fragment_count=len(pieces),
                value=piece,
                encoding=encoding,
            ),
            budget,
        )
        for index, piece in enumerate(pieces, start=1)
    ]


# Memoized escaped lengths for _split_value: overlong cell values repeat a
# small alphabet of characters, so the per-character json.dumps cost drops
# to one call per distinct character. Bounded so pathological inputs cannot
# grow the cache without limit; beyond the cap it recomputes, still correct.
_ESCAPED_CHAR_LENGTHS: dict[str, int] = {}
_ESCAPED_CHAR_CACHE_CAP = 4096


def _escaped_char_length(char: str) -> int:
    """Return len(json.dumps(char)) - 2, memoized per distinct character."""
    length = _ESCAPED_CHAR_LENGTHS.get(char)
    if length is None:
        length = len(dumps_excel_value(char)) - 2  # strip the quotes
        if len(_ESCAPED_CHAR_LENGTHS) < _ESCAPED_CHAR_CACHE_CAP:
            _ESCAPED_CHAR_LENGTHS[char] = length
    return length


def _split_value(
    value: str,
    source_row: int,
    source_column: int,
    digits: int,
    budget: _Budget,
) -> list[str]:
    """Split a value so every fragment fits both text-form budgets."""
    # The canonical JSON wrapper is far heavier than the readable line, so
    # each form constrains only itself and the value splits to fit both.
    value_budget = min(
        budget.canonical
        - _fragment_overhead(source_row, source_column, digits, form="canonical"),
        budget.retrieval
        - _fragment_overhead(source_row, source_column, digits, form="readable"),
    )
    if value_budget < 16:
        raise _BudgetExhausted(
            f"chunk budget canonical={budget.canonical} "
            f"retrieval={budget.retrieval} leaves no room for a fragment "
            f"of row {source_row} column {source_column}"
        )
    pieces: list[str] = []
    current = ""
    current_escaped_len = 0
    for char in value:
        # JSON escaping is per-character independent under ensure_ascii=False.
        char_escaped_len = _escaped_char_length(char)
        if current and current_escaped_len + char_escaped_len > value_budget - 2:
            pieces.append(current)
            current = ""
            current_escaped_len = 0
        current += char
        current_escaped_len += char_escaped_len
    pieces.append(current)
    return pieces


def _fragment_overhead(
    source_row: int, source_column: int, digits: int, *, form: str
) -> int:
    """Return the non-value length of one form's fragment line."""
    marker = int("9" * digits)
    fragment = ExcelCellFragment(source_row, source_column, marker, marker, "")
    if form == "canonical":
        rendered = serialize_excel_fragment(fragment)
    else:
        rendered = format_excel_fragment_readable(fragment)
    # The value contributes only its JSON-escaped length on top of the form.
    return len(rendered) - len('""')


def _fragment_line(fragment: ExcelCellFragment, budget: _Budget) -> _ChunkLine:
    canonical = serialize_excel_fragment(fragment)
    readable = format_excel_fragment_readable(fragment)
    if len(canonical) > budget.canonical or len(readable) > budget.retrieval:
        raise _BudgetExhausted(
            f"Excel fragment at row {fragment.source_row} "
            f"column {fragment.source_column} exceeds the chunk budget "
            f"canonical={budget.canonical} retrieval={budget.retrieval}"
        )
    return _ChunkLine(canonical=canonical, readable=readable)


def _pack_lines(lines: list[_ChunkLine], budget: _Budget) -> list[list[_ChunkLine]]:
    """Greedily pack atomic lines into chunks that fit both budgets."""
    chunks: list[list[_ChunkLine]] = []
    current: list[_ChunkLine] = []
    canonical_len = 0
    readable_len = 0
    for line in lines:
        next_canonical = canonical_len + len(line.canonical) + (1 if current else 0)
        next_readable = readable_len + len(line.readable) + (1 if current else 0)
        if current and (
            next_canonical > budget.canonical or next_readable > budget.retrieval
        ):
            chunks.append(current)
            current = []
            canonical_len = 0
            readable_len = 0
        if len(line.canonical) > budget.canonical or len(line.readable) > (
            budget.retrieval
        ):
            raise ValueError(
                f"Excel chunk line of {max(len(line.canonical), len(line.readable))} "
                f"characters exceeds the chunk budget canonical="
                f"{budget.canonical} retrieval={budget.retrieval}"
            )
        current.append(line)
        canonical_len += len(line.canonical) + (1 if canonical_len else 0)
        readable_len += len(line.readable) + (1 if readable_len else 0)
    if current:
        chunks.append(current)
    return chunks


def _lines_to_node(
    lines: list[_ChunkLine],
    base_metadata: dict,
    context: _SheetContext,
    *,
    extra: dict | None = None,
) -> TextNode:
    metadata = {
        **base_metadata,
        RETRIEVAL_TEXT_METADATA_KEY: context.retrieval_prefix
        + "\n".join(line.readable for line in lines),
        DISPLAY_TEXT_METADATA_KEY: context.display_prefix
        + "\n".join(line.canonical for line in lines),
        **(extra or {}),
    }
    return TextNode(
        text="\n".join(line.canonical for line in lines),
        metadata=metadata,
        excluded_embed_metadata_keys=[
            RETRIEVAL_TEXT_METADATA_KEY,
            DISPLAY_TEXT_METADATA_KEY,
        ],
        excluded_llm_metadata_keys=[
            RETRIEVAL_TEXT_METADATA_KEY,
            DISPLAY_TEXT_METADATA_KEY,
        ],
    )
