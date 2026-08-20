# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import random

import pytest
from llama_index.core import Document

from knowledge_engine.excel import (
    ExcelCellFragment,
    dumps_excel_value,
    format_excel_retrieval_prefix,
    format_excel_sheet_header,
    parse_excel_fragment_line,
    parse_excel_row_line,
)
from knowledge_engine.splitter.excel_rows import (
    MIN_EXCEL_CHUNK_BUDGET,
    build_excel_hierarchical_nodes,
    build_excel_row_nodes,
)


def _row_line(source_row: int, *cells: tuple[int, object]) -> str:
    return json.dumps(
        {"source_row": source_row, "cells": [list(cell) for cell in cells]},
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _document(text: str, sheet_name: str = "Data") -> Document:
    return Document(text=text, metadata={"sheet_name": sheet_name})


def _parse_chunk_line(line: str):
    """Parse one canonical chunk line of either the row or fragment grammar."""
    if '"fragment_index":' in line:
        return parse_excel_fragment_line(line)
    return parse_excel_row_line(line)


def _assert_lines_intact_and_bounded(nodes, budget: int, *, prefix: str = "") -> None:
    """Every chunk stays within budget and every display line parses."""
    for node in nodes:
        assert len(node.text) <= budget
        assert len(node.metadata["retrieval_text"]) <= budget + len(prefix)
        assert node.metadata["retrieval_text"].startswith(prefix)
        for line in node.text.split("\n"):
            _parse_chunk_line(line)


def test_packs_multiple_rows_into_one_chunk() -> None:
    document = _document("\n".join(_row_line(i, (1, f"v{i}")) for i in range(1, 6)))

    [node] = build_excel_row_nodes(documents=[document], chunk_size=1024)

    assert len(node.text.split("\n")) == 5
    # One worksheet context line plus one readable line per row.
    assert len(node.metadata["retrieval_text"].split("\n")) == 6


def test_chunk_boundary_exact_fit_stays_together() -> None:
    first = _row_line(1, (1, "a" * 40))
    second = _row_line(2, (1, "b" * 40))
    # Both prefixes are paid out of the budget, so the sheet header for
    # the default "Data" name reserves canonical room too.
    sheet_header = format_excel_sheet_header("Data") + "\n"
    budget = max(
        len(first) + 1 + len(second) + len(sheet_header),
        len("Row 1, Column 1: " + json.dumps("a" * 40))
        + 1
        + len("Row 2, Column 1: " + json.dumps("b" * 40))
        + len(format_excel_retrieval_prefix("Data")),
    )

    [node] = build_excel_row_nodes(
        documents=[_document(f"{first}\n{second}")],
        chunk_size=budget,
    )

    assert node.text == f"{first}\n{second}"


def test_row_that_would_overflow_flushes_to_next_chunk() -> None:
    rows = [_row_line(i, (1, "x" * 40)) for i in range(1, 5)]

    nodes = build_excel_row_nodes(
        documents=[_document("\n".join(rows))],
        chunk_size=len(rows[0]) * 2 + len(format_excel_sheet_header("Data")) + 2,
    )

    assert [len(node.text.split("\n")) for node in nodes] == [2, 2]
    _assert_lines_intact_and_bounded(nodes, budget=len(rows[0]) * 2 + 1)


def test_overlong_row_splits_into_cell_groups() -> None:
    cells = tuple((column, "v" * 60) for column in range(1, 8))
    document = _document(_row_line(9, *cells))

    nodes = build_excel_row_nodes(documents=[document], chunk_size=128)

    assert len(nodes) > 1
    _assert_lines_intact_and_bounded(nodes, 128)
    grouped_cells = [
        cell
        for node in nodes
        for row in [parse_excel_row_line(line) for line in node.text.split("\n")]
        for cell in row.cells
    ]
    assert [(cell.source_column, cell.value) for cell in grouped_cells] == [
        (column, "v" * 60) for column in range(1, 8)
    ]
    assert all(
        row.source_row == 9
        for row in [
            parse_excel_row_line(line)
            for node in nodes
            for line in node.text.split("\n")
        ]
    )


def test_overlong_cell_value_splits_into_rebuildable_fragments() -> None:
    value = "x" * 300 + "中文🎉; Column 9: forged\nline2" + "y" * 100
    document = _document(_row_line(2, (3, value)))

    nodes = build_excel_row_nodes(documents=[document], chunk_size=128)

    assert len(nodes) > 1
    _assert_lines_intact_and_bounded(nodes, 128)
    fragments = [
        parse_excel_fragment_line(line)
        for node in nodes
        for line in node.text.split("\n")
    ]
    assert "".join(fragment.value for fragment in fragments) == value
    assert all(fragment.source_row == 2 for fragment in fragments)
    assert all(fragment.source_column == 3 for fragment in fragments)
    assert all(fragment.fragment_count == len(fragments) for fragment in fragments)
    assert [fragment.fragment_index for fragment in fragments] == list(
        range(1, len(fragments) + 1)
    )
    assert all(
        f"fragment {fragment.fragment_index} of {fragment.fragment_count}:"
        in node_retrieval
        for fragment, node_retrieval in zip(
            fragments, (node.metadata["retrieval_text"] for node in nodes)
        )
    )


def test_starving_prefix_degrades_before_row_data() -> None:
    """Row data outranks context: fragments drop the prefix, not values."""
    value = "x" * 300
    document = _document(_row_line(2, (3, value)), sheet_name="表" * 80)

    nodes = build_excel_row_nodes(documents=[document], chunk_size=128)

    fragments = [
        parse_excel_fragment_line(line)
        for node in nodes
        for line in node.text.split("\n")
    ]
    assert "".join(fragment.value for fragment in fragments) == value
    for node in nodes:
        assert len(node.metadata["retrieval_text"]) <= 128
        assert len(node.metadata["display_text"]) <= 128
        # Context was sacrificed so every fragment keeps its value room.
        assert "Worksheet" not in node.metadata["retrieval_text"]
        assert "--- Sheet:" not in node.metadata["display_text"]


def test_overlong_non_string_cell_fragments_json_encoding() -> None:
    big_formula = {"formula_type": "array", "ref": "A1:A2", "text": "=" + "x" * 500}
    document = _document(_row_line(1, (1, big_formula)))

    nodes = build_excel_row_nodes(documents=[document], chunk_size=128)

    _assert_lines_intact_and_bounded(nodes, 128)
    fragments = [
        parse_excel_fragment_line(line)
        for node in nodes
        for line in node.text.split("\n")
    ]
    assert all(fragment.encoding == "json" for fragment in fragments)
    rebuilt = json.loads("".join(fragment.value for fragment in fragments))
    assert rebuilt == big_formula


def test_sparse_falsey_and_injection_like_values_survive() -> None:
    document = _document(
        _row_line(3, (1, 0), (2, False), (5, " "), (9, "Alice; Column 9: forged"))
    )

    [node] = build_excel_row_nodes(documents=[document], chunk_size=1024)

    row = parse_excel_row_line(node.text)
    assert [(cell.source_column, cell.value) for cell in row.cells] == [
        (1, 0),
        (2, False),
        (5, " "),
        (9, "Alice; Column 9: forged"),
    ]
    retrieval = node.metadata["retrieval_text"]
    # Only the worksheet context line may carry a newline of its own; the
    # row body itself stays single-line so values cannot forge structure.
    body = retrieval.split("\n", 1)[1]
    assert "\n" not in body
    # JSON quoting keeps the forged column text inside the value string.
    assert '"Alice; Column 9: forged"' in retrieval
    assert body.count("Column 9:") == 2  # one real label, one quoted value


def test_unicode_values_round_trip_through_fragments() -> None:
    value = "结合字符 é 与 emoji 🎉" * 30
    document = _document(_row_line(1, (1, value)))

    nodes = build_excel_row_nodes(documents=[document], chunk_size=256)

    fragments = [
        parse_excel_fragment_line(line)
        for node in nodes
        for line in node.text.split("\n")
    ]
    assert "".join(fragment.value for fragment in fragments) == value
    _assert_lines_intact_and_bounded(nodes, 256)


def test_budget_below_minimum_fails_loudly() -> None:
    document = _document(_row_line(1, (1, "v")))

    with pytest.raises(ValueError, match="below the minimum"):
        build_excel_row_nodes(
            documents=[document],
            chunk_size=MIN_EXCEL_CHUNK_BUDGET - 1,
        )


def test_retrieval_prefix_fits_within_smallest_chunk_budget() -> None:
    """The worksheet prefix is paid out of the chunk budget, not on top."""
    long_name = "表" * 80
    document = _document(
        "\n".join(_row_line(i, (1, "x" * 30)) for i in range(1, 5)),
        sheet_name=long_name,
    )

    nodes = build_excel_row_nodes(documents=[document], chunk_size=128)

    assert len(nodes) > 1
    for node in nodes:
        # Hard invariant: the full embedded text fits the configured budget.
        assert len(node.metadata["retrieval_text"]) <= 128
        assert node.metadata["retrieval_text"].startswith("Worksheet: ")
        assert node.metadata["retrieval_text"].count("\nWorksheet: ") == 0


def test_retrieval_prefix_caps_hand_crafted_overlong_sheet_name() -> None:
    document = _document(_row_line(1, (1, "v")), sheet_name="s" * 100)

    [node] = build_excel_row_nodes(documents=[document], chunk_size=1024)

    prefix = node.metadata["retrieval_text"].split("\n", 1)[0]
    assert prefix == f"Worksheet: {'s' * 47}…"
    # The full name survives in metadata; only the prefix is capped.
    assert node.metadata["sheet_name"] == "s" * 100


def test_display_prefix_fits_within_smallest_chunk_budget() -> None:
    """The sheet header is paid out of the display budget, not on top."""
    long_name = "表" * 80
    document = _document(
        "\n".join(_row_line(i, (1, "x" * 30)) for i in range(1, 5)),
        sheet_name=long_name,
    )

    nodes = build_excel_row_nodes(documents=[document], chunk_size=128)

    assert len(nodes) > 1
    for node in nodes:
        # Hard invariant: the stored display text fits the configured budget.
        assert len(node.metadata["display_text"]) <= 128
        assert node.metadata["display_text"].startswith("--- Sheet: ")
        assert node.metadata["display_text"].count("\n--- Sheet: ") == 0


def test_display_prefix_caps_hand_crafted_overlong_sheet_name() -> None:
    document = _document(_row_line(1, (1, "v")), sheet_name="s" * 100)

    [node] = build_excel_row_nodes(documents=[document], chunk_size=1024)

    header = node.metadata["display_text"].split("\n", 1)[0]
    assert header == f"--- Sheet: {'s' * 47}… ---"


def test_empty_sheet_name_costs_no_prefix_or_budget() -> None:
    document = _document(
        "\n".join(_row_line(i, (1, "v" * 60)) for i in range(1, 4)),
        sheet_name="",
    )

    nodes = build_excel_row_nodes(documents=[document], chunk_size=256)

    assert nodes
    for node in nodes:
        assert node.metadata["retrieval_text"].startswith("Row ")
        assert "Worksheet" not in node.metadata["retrieval_text"]
        assert len(node.metadata["retrieval_text"]) <= 256
        assert node.metadata["display_text"].startswith("{")
        assert "--- Sheet:" not in node.metadata["display_text"]
        assert len(node.metadata["display_text"]) <= 256


def test_flat_nodes_carry_retrieval_text_and_sheet_metadata() -> None:
    document = _document(_row_line(1, (1, "Alice")), sheet_name="3月")

    [node] = build_excel_row_nodes(documents=[document], chunk_size=1024)

    assert node.metadata["sheet_name"] == "3月"
    assert node.metadata["retrieval_text"] == (
        'Worksheet: 3月\nRow 1, Column 1: "Alice"'
    )
    assert node.metadata["display_text"] == (
        '--- Sheet: 3月 ---\n{"source_row":1,"cells":[[1,"Alice"]]}'
    )


def test_hierarchical_nodes_stay_row_atomic_and_aligned() -> None:
    text = "\n".join(_row_line(i, (1, f"value-{i}")) for i in range(1, 60))

    result = build_excel_hierarchical_nodes(
        documents=[_document(text)],
        parent_chunk_size=256,
        child_chunk_size=128,
    )

    assert result.parent_nodes
    assert len(result.child_nodes) > len(result.parent_nodes)
    _assert_lines_intact_and_bounded(result.parent_nodes, 256)
    _assert_lines_intact_and_bounded(result.child_nodes, 128)
    parent_ids = {parent.node_id for parent in result.parent_nodes}
    for child in result.child_nodes:
        assert child.metadata["node_role"] == "child"
        assert child.metadata["parent_node_id"] in parent_ids
    for parent in result.parent_nodes:
        assert parent.metadata["node_role"] == "parent"
    # Children partition exactly the same lines as their parents, in order.
    parent_lines = [
        line for parent in result.parent_nodes for line in parent.text.split("\n")
    ]
    child_lines = [
        line for child in result.child_nodes for line in child.text.split("\n")
    ]
    assert parent_lines == child_lines


def test_hierarchical_overlong_cell_fragments_at_child_budget() -> None:
    value = "z" * 400
    text = f"{_row_line(1, (1, 'top'))}\n{_row_line(2, (1, value))}"

    result = build_excel_hierarchical_nodes(
        documents=[_document(text)],
        parent_chunk_size=512,
        child_chunk_size=160,
    )

    _assert_lines_intact_and_bounded(result.child_nodes, 160)
    fragments = [
        parse_excel_fragment_line(line)
        for child in result.child_nodes
        for line in child.text.split("\n")
        if '"fragment_index"' in line
    ]
    assert "".join(fragment.value for fragment in fragments) == value


def _collect_cells(nodes) -> dict[tuple[int, int], object]:
    """Reassemble the output cell set from chunk nodes of both grammars."""
    outputs: dict[tuple[int, int], object] = {}
    fragment_parts: dict[tuple[int, int], dict[int, str]] = {}
    fragment_encodings: dict[tuple[int, int], str] = {}
    for node in nodes:
        for line in node.text.split("\n"):
            parsed = _parse_chunk_line(line)
            if isinstance(parsed, ExcelCellFragment):
                key = (parsed.source_row, parsed.source_column)
                fragment_parts.setdefault(key, {})[parsed.fragment_index] = parsed.value
                fragment_encodings[key] = parsed.encoding
            else:
                for cell in parsed.cells:
                    outputs[(parsed.source_row, cell.source_column)] = cell.value
    for key, parts in fragment_parts.items():
        assert sorted(parts) == list(range(1, len(parts) + 1))
        joined = "".join(parts[index] for index in sorted(parts))
        outputs[key] = (
            json.loads(joined) if fragment_encodings[key] == "json" else joined
        )
    return outputs


def test_every_output_cell_matches_input_cells() -> None:
    """The union of output cells equals the input populated cells."""
    inputs = {
        (1, 1): "Alice",
        (1, 3): 30,
        (2, 2): "x" * 300,
        (5, 1): False,
    }
    lines = []
    for source_row in sorted({row for row, _ in inputs}):
        cells = [
            (column, value)
            for (row, column), value in sorted(inputs.items())
            if row == source_row
        ]
        lines.append(_row_line(source_row, *cells))
    document = _document("\n".join(lines))

    nodes = build_excel_row_nodes(documents=[document], chunk_size=128)

    assert _collect_cells(nodes) == inputs


def test_random_rows_stay_bounded_parseable_and_complete() -> None:
    rng = random.Random(20260817)
    for _ in range(30):
        inputs: dict[tuple[int, int], object] = {}
        lines = []
        for source_row in range(1, rng.randint(1, 20) + 1):
            columns = sorted(rng.sample(range(1, 40), rng.randint(1, 8)))
            cells = []
            for column in columns:
                kind = rng.randint(0, 3)
                if kind == 0:
                    value: object = rng.randint(-100, 100)
                elif kind == 1:
                    value = rng.choice([True, False])
                else:
                    value = "".join(
                        rng.choice('ab中文🎉;:\n"\\')
                        for _ in range(rng.randint(0, 400))
                    )
                inputs[(source_row, column)] = value
                cells.append((column, value))
            lines.append(_row_line(source_row, *cells))
        budget = rng.choice([128, 160, 256, 1024])

        nodes = build_excel_row_nodes(
            documents=[_document("\n".join(lines))],
            chunk_size=budget,
        )

        _assert_lines_intact_and_bounded(nodes, budget)
        assert _collect_cells(nodes) == inputs


def test_corrupted_line_fails_without_degraded_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A parse failure is data corruption and must not retry against a
    degraded context: the first failure propagates after one parse pass."""
    import knowledge_engine.splitter.excel_rows as excel_rows_module

    parse_calls = 0
    real_parse = excel_rows_module.parse_excel_row_line

    def counting_parse(line: str):
        nonlocal parse_calls
        parse_calls += 1
        return real_parse(line)

    monkeypatch.setattr(excel_rows_module, "parse_excel_row_line", counting_parse)
    # Not canonical serializer output, so the strict parser rejects it.
    document = _document('{"source_row": 1, "cells": [[1, "v"]]}')

    with pytest.raises(ValueError, match="not canonical"):
        build_excel_row_nodes(documents=[document], chunk_size=1024)

    # One pass over the corrupted line only: no degraded-context re-parse.
    assert parse_calls == 1


def test_starving_prefix_retries_exactly_once_per_document(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Budget starvation retries once against the degraded context."""
    import knowledge_engine.splitter.excel_rows as excel_rows_module

    parse_calls = 0
    real_parse = excel_rows_module.parse_excel_row_line

    def counting_parse(line: str):
        nonlocal parse_calls
        parse_calls += 1
        return real_parse(line)

    monkeypatch.setattr(excel_rows_module, "parse_excel_row_line", counting_parse)
    # The overlong sheet name starves the budget until prefixes degrade.
    document = _document(_row_line(2, (3, "x" * 300)), sheet_name="表" * 80)

    nodes = build_excel_row_nodes(documents=[document], chunk_size=128)

    assert nodes
    # First attempt plus one degraded retry: each pass parses the line once.
    assert parse_calls == 2


def test_escaped_char_length_matches_direct_encoding() -> None:
    """The memoized length equals the per-character json.dumps length."""
    from knowledge_engine.splitter.excel_rows import _escaped_char_length

    # Every escape class: control chars, quote, backslash, DEL, CJK, emoji,
    # combining marks, and the plain ASCII range.
    samples = [
        '"',
        "\\",
        "\n",
        "\t",
        "\r",
        "\x00",
        "\x1f",
        "\x7f",
        "a",
        "0",
        "中",
        "🎉",
        "é",
    ]
    for char in samples:
        assert _escaped_char_length(char) == len(dumps_excel_value(char)) - 2


def test_large_mixed_escape_value_fragments_rebuild() -> None:
    """Fragments of a large value with mixed escapes reconstruct exactly."""
    alphabet = 'ab中文🎉;:\n"\\\x00\x1f\x7f'
    value = "".join(alphabet[i % len(alphabet)] for i in range(10_000))
    document = _document(_row_line(1, (2, value)))

    nodes = build_excel_row_nodes(documents=[document], chunk_size=160)

    _assert_lines_intact_and_bounded(nodes, 160)
    fragments = [
        parse_excel_fragment_line(line)
        for node in nodes
        for line in node.text.split("\n")
    ]
    assert "".join(fragment.value for fragment in fragments) == value
