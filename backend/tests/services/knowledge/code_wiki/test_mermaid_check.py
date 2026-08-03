# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for structural checks on Mermaid diagrams."""

import pytest

from app.services.knowledge.code_wiki.mermaid_check import (
    check_mermaid_blocks,
    describe_warnings,
)


def _fence(body: str, info: str = "mermaid") -> str:
    return f"```{info}\n{body}\n```"


def test_a_valid_diagram_produces_no_warnings():
    markdown = "# Architecture\n\n" + _fence("flowchart TD\n  A[Start] --> B[End]")

    assert check_mermaid_blocks(markdown) == []


def test_documents_without_diagrams_produce_no_warnings():
    assert check_mermaid_blocks("# Just prose\n\nNo diagrams here.") == []


def test_a_misspelled_diagram_type_is_reported():
    markdown = _fence("flowchat TD\n  A --> B")

    warnings = check_mermaid_blocks(markdown)

    assert len(warnings) == 1
    assert "flowchat" in warnings[0].message
    assert "not render" in warnings[0].message


def test_an_unclosed_fence_is_reported():
    markdown = "```mermaid\nflowchart TD\n  A --> B\n"

    warnings = check_mermaid_blocks(markdown)

    assert len(warnings) == 1
    assert "never closed" in warnings[0].message


def test_an_empty_diagram_is_reported():
    markdown = _fence("")

    warnings = check_mermaid_blocks(markdown)

    assert len(warnings) == 1
    assert "empty" in warnings[0].message


def test_an_unbalanced_bracket_is_reported():
    markdown = _fence("flowchart TD\n  A[Start --> B[End]")

    warnings = check_mermaid_blocks(markdown)

    assert len(warnings) == 1
    assert "unclosed '['" in warnings[0].message


def test_a_mismatched_closing_bracket_is_reported():
    markdown = _fence("flowchart TD\n  A[Start) --> B")

    warnings = check_mermaid_blocks(markdown)

    assert len(warnings) == 1
    assert "mismatched" in warnings[0].message


def test_brackets_inside_quoted_labels_are_not_misread():
    markdown = _fence('flowchart TD\n  A["build (release)"] --> B["ship"]')

    assert check_mermaid_blocks(markdown) == []


def test_an_unclosed_quote_is_reported():
    markdown = _fence('flowchart TD\n  A["Start --> B')

    warnings = check_mermaid_blocks(markdown)

    assert len(warnings) == 1
    assert "unclosed quote" in warnings[0].message


def test_comments_before_the_diagram_type_are_skipped():
    markdown = _fence("%% layout notes\nflowchart LR\n  A --> B")

    assert check_mermaid_blocks(markdown) == []


def test_diagram_type_with_a_direction_or_colon_is_accepted():
    assert check_mermaid_blocks(_fence("graph LR\n  A --> B")) == []
    assert check_mermaid_blocks(_fence("stateDiagram-v2\n  [*] --> Idle")) == []
    assert check_mermaid_blocks(_fence("pie title Share\n  'a' : 10")) == []


def test_a_mermaid_example_quoted_inside_another_fence_is_not_checked():
    """A code sample showing broken Mermaid is documentation, not a diagram."""
    markdown = "````markdown\n```mermaid\nflowchat TD\n```\n````"

    assert check_mermaid_blocks(markdown) == []


def test_entity_relationship_cardinality_is_not_mistaken_for_a_bracket_error():
    """ER diagrams write cardinality as ``||--o{``, which only looks unbalanced.

    Reporting it would send the agent off to fix a diagram that already renders.
    """
    markdown = _fence(
        "erDiagram\n"
        "  CUSTOMER ||--o{ ORDER : places\n"
        "  ORDER }|..|{ LINE_ITEM : contains"
    )

    assert check_mermaid_blocks(markdown) == []


def test_text_heavy_diagrams_may_contain_stray_brackets_in_labels():
    assert check_mermaid_blocks(_fence("gantt\n  title Release [Q3\n")) == []
    assert check_mermaid_blocks(_fence("journey\n  Browse [start: 3")) == []


def test_every_diagram_in_a_page_is_checked():
    markdown = "\n\n".join(
        [
            _fence("flowchart TD\n  A --> B"),
            _fence("nonsense\n  A --> B"),
            _fence("sequenceDiagram\n  Alice->>Bob: hi"),
            _fence("erDiagram\n  A ||--o{ B : has"),
        ]
    )

    warnings = check_mermaid_blocks(markdown)

    assert len(warnings) == 1
    assert "nonsense" in warnings[0].message


def test_warnings_carry_the_line_of_their_diagram():
    markdown = "# Title\n\nProse.\n\n" + _fence("flowchat TD\n  A --> B")

    warnings = check_mermaid_blocks(markdown)

    assert warnings[0].line == 5


def test_warnings_render_as_an_instruction_for_the_agent():
    warnings = check_mermaid_blocks(_fence("flowchat TD\n  A --> B"))

    described = describe_warnings(warnings)

    assert "write the page again" in described
    assert "flowchat" in described


def test_no_warnings_render_as_nothing():
    assert describe_warnings([]) == ""


def test_a_shorter_fence_does_not_close_a_longer_one():
    """A closing fence must be at least as long as the one it opens.

    Comparing only the fence character lets an inner ``` end an outer ````, which is
    exactly how a diagram gets quoted rather than declared. Here the document is
    genuinely unterminated, and treating the short fence as a close would hide that.
    """
    markdown = "````mermaid\nflowchart TD\n  A --> B\n```\n"

    warnings = check_mermaid_blocks(markdown)

    assert len(warnings) == 1
    assert "never closed" in warnings[0].message


def test_a_longer_fence_closes_normally():
    markdown = "````mermaid\nflowchart TD\n  A --> B\n````\n"

    assert check_mermaid_blocks(markdown) == []


@pytest.mark.parametrize(
    "declaration",
    ["kanban", "radar", "treemap", "classDiagram-v2", "flowchart-elk", "C4Container"],
)
def test_declarations_the_pinned_mermaid_supports_are_not_reported(declaration: str):
    """The frontend resolves Mermaid 11.15, and a type missing from the allow-list is
    sent back to the agent as a broken diagram — a wasted round spent "fixing" one
    that renders."""
    assert check_mermaid_blocks(_fence(f"{declaration}\n  A --> B")) == []


def test_frontmatter_does_not_hide_the_diagram_type():
    """Mermaid allows `--- ... ---` before the type, and several of the types the
    pinned version added use it. Read as the diagram, the opening `---` becomes the
    type and something that renders is reported as broken."""
    body = "---\nconfig:\n  theme: dark\n---\nradar-beta\n  axis a, b"

    assert check_mermaid_blocks(_fence(body)) == []


def test_an_unterminated_dash_line_is_not_treated_as_frontmatter():
    """Otherwise the whole diagram would be swallowed and nothing checked."""
    warnings = check_mermaid_blocks(_fence("---\nflowchat TD"))

    assert warnings
