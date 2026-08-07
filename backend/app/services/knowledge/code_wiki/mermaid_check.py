# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Structural checks on Mermaid diagrams in generated Markdown.

Diagrams are rendered in the browser, so a malformed one spoils a figure rather than a
page. Withholding an otherwise good page over it would cost more than it saves, so
these findings are returned to the writing agent as warnings and never block
publication.

The checks are structural on purpose: they catch the mistakes a model actually makes —
a misspelled diagram type, an unclosed fence, unbalanced brackets — without running
Mermaid itself, which is a JavaScript parser this service cannot host. What they
cannot do is certify that a diagram renders; they only report what is definitely
wrong. The warning contract is stable, so swapping in a real parser later would not
change the callers.
"""

import re
from dataclasses import dataclass
from typing import List, Sequence

FENCE_PATTERN = re.compile(r"^(\s*)(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$")

# Diagram types Mermaid recognises. A block starting with anything else will not
# render, and a misspelling here is the most common failure in generated diagrams.
# Tracks the Mermaid the frontend actually resolves to (11.15.x via ^11.4.0). A type
# missing here is reported as a broken diagram and sent back to the agent to "fix",
# which wastes a round on a diagram that renders perfectly well — so this list has to
# be widened whenever the pinned version gains a declaration.
#
# Newer types carry a "-beta" suffix that Mermaid drops as they stabilise, and both
# spellings are listed rather than guessed between: the cost of an extra entry is
# nothing, and the cost of a missing one is a wasted round trip through the model.
KNOWN_DIAGRAM_TYPES: frozenset[str] = frozenset(
    {
        "architecture-beta",
        "block-beta",
        "c4component",
        "c4container",
        "c4context",
        "c4deployment",
        "c4dynamic",
        "classdiagram",
        "classdiagram-v2",
        "erdiagram",
        "flowchart",
        "flowchart-elk",
        "gantt",
        "gitgraph",
        "graph",
        "journey",
        "kanban",
        "mindmap",
        "packet",
        "packet-beta",
        "pie",
        "quadrantchart",
        "radar",
        "radar-beta",
        "requirementdiagram",
        "sankey-beta",
        "sequencediagram",
        "statediagram",
        "statediagram-v2",
        "timeline",
        "treemap",
        "treemap-beta",
        "xychart-beta",
        "zenuml",
    }
)

BRACKET_PAIRS = {"(": ")", "[": "]", "{": "}"}

# Diagram types where brackets delimit nodes, so an unbalanced one is a real mistake.
# The check is limited to these because elsewhere brackets are not delimiters at all:
# an ER diagram writes cardinality as ``||--o{``, which is deliberately "unbalanced",
# and the text-heavy types put arbitrary prose in labels. Reporting those would send
# the agent off to fix diagrams that are already correct.
BRACKET_CHECKED_TYPES: frozenset[str] = frozenset(
    {
        "block-beta",
        "classdiagram",
        "flowchart",
        "graph",
        "mindmap",
        "statediagram",
        "statediagram-v2",
    }
)


@dataclass(frozen=True)
class MermaidWarning:
    """One problem found in a diagram, addressed to the agent that wrote it."""

    # 1-based line of the fence that opens the diagram, so the agent can find it.
    line: int
    message: str

    def __str__(self) -> str:
        return f"line {self.line}: {self.message}"


def _diagram_type_of(body: Sequence[str]) -> str:
    """First meaningful token of a diagram, lowercased; empty when there is none."""
    for line in _without_frontmatter(body):
        stripped = line.strip()
        if not stripped or stripped.startswith("%%"):
            continue
        # "flowchart TD", "stateDiagram-v2", "graph LR" — the type is the first token.
        return re.split(r"[\s:]", stripped, maxsplit=1)[0].lower()
    return ""


def _without_frontmatter(body: Sequence[str]) -> Sequence[str]:
    """Drop a leading ``--- ... ---`` block.

    Mermaid allows YAML frontmatter before the diagram type, which several of the
    types added for the pinned version use. Read as the diagram itself, the opening
    ``---`` becomes the type, and a diagram that renders is reported as unknown.
    """
    first = next((index for index, line in enumerate(body) if line.strip()), None)
    if first is None or body[first].strip() != "---":
        return body

    for index in range(first + 1, len(body)):
        if body[index].strip() == "---":
            return body[index + 1 :]
    # Unterminated: not frontmatter, whatever else it is.
    return body


def _unbalanced_bracket(body: Sequence[str]) -> str:
    """Report the first unbalanced bracket, ignoring anything inside quotes."""
    stack: List[str] = []
    for line in body:
        in_quote = False
        for char in line:
            if char == '"':
                in_quote = not in_quote
                continue
            if in_quote:
                continue
            if char in BRACKET_PAIRS:
                stack.append(char)
            elif char in BRACKET_PAIRS.values():
                if not stack:
                    return f"unexpected closing '{char}'"
                if BRACKET_PAIRS[stack.pop()] != char:
                    return f"mismatched closing '{char}'"
        if in_quote:
            return "unclosed quote"
    if stack:
        return f"unclosed '{stack[-1]}'"
    return ""


def check_mermaid_blocks(markdown: str) -> List[MermaidWarning]:
    """Find structural problems in the Mermaid diagrams of a Markdown document.

    Returns an empty list when nothing is definitely wrong. Nested fences inside other
    fenced blocks are skipped, so a Mermaid example quoted inside a code sample is not
    mistaken for a diagram.
    """
    warnings: List[MermaidWarning] = []
    lines = markdown.splitlines()

    index = 0
    while index < len(lines):
        match = FENCE_PATTERN.match(lines[index])
        if not match:
            index += 1
            continue

        _, marker, info = match.groups()
        opened_at = index + 1
        is_mermaid = info.lower() == "mermaid"

        body: List[str] = []
        index += 1
        closed = False
        while index < len(lines):
            closing = FENCE_PATTERN.match(lines[index])
            # A closing fence must use the same character and be at least as long as
            # the opening one. Length matters because wrapping an example in a longer
            # fence is how a diagram gets quoted rather than declared: without this,
            # the inner ``` ends the outer ````, and the rest of the example is read
            # as live markdown.
            if (
                closing
                and closing.group(2)[0] == marker[0]
                and len(closing.group(2)) >= len(marker)
                and not closing.group(3)
            ):
                closed = True
                index += 1
                break
            body.append(lines[index])
            index += 1

        if not is_mermaid:
            # A non-Mermaid fence is only consumed so its contents cannot be mistaken
            # for a diagram; problems inside it are not ours to report.
            continue

        if not closed:
            warnings.append(MermaidWarning(opened_at, "diagram fence is never closed"))
            continue

        diagram_type = _diagram_type_of(body)
        if not diagram_type:
            warnings.append(MermaidWarning(opened_at, "diagram is empty"))
            continue
        if diagram_type not in KNOWN_DIAGRAM_TYPES:
            warnings.append(
                MermaidWarning(
                    opened_at,
                    f"'{diagram_type}' is not a Mermaid diagram type, so this "
                    "diagram will not render",
                )
            )
            continue

        if diagram_type in BRACKET_CHECKED_TYPES:
            problem = _unbalanced_bracket(body)
            if problem:
                warnings.append(MermaidWarning(opened_at, problem))

    return warnings


def describe_warnings(warnings: Sequence[MermaidWarning]) -> str:
    """Render warnings as an instruction the writing agent can act on."""
    if not warnings:
        return ""
    listed = "\n".join(f"- {warning}" for warning in warnings)
    return (
        "The Mermaid diagrams below will not render. Fix them and write the page "
        f"again:\n{listed}"
    )
