# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Rule-based Q/A document unitization for indexing."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from llama_index.core import Document
from llama_index.core.schema import TextNode

MIN_QA_PAIRS_FOR_DOCUMENT = 2
MIN_QA_COVERAGE = 0.35

QUESTION_LINE_RE = re.compile(
    r"^\s*(?:[-*]\s*)?(?:\*\*)?"
    r"(?P<label>(?:Q(?:uestion)?|问题)\s*(?P<number>\d+)?)"
    r"\s*[：:.)、]\s*(?P<question>.+?)"
    r"(?:\*\*)?\s*$",
    re.IGNORECASE | re.MULTILINE,
)
ANSWER_LINE_RE = re.compile(
    r"^\s*(?:[-*]\s*)?(?:\*\*)?"
    r"(?:A(?:nswer)?|答案|答)\s*[：:.)、]\s*"
    r"(?:\*\*)?\s*(?P<inline>.*?)\s*$",
    re.IGNORECASE | re.MULTILINE,
)
MARKDOWN_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+(.+?)\s*$", re.MULTILINE)
DECORATION_RE = re.compile(r"^[\s*_`#>\-~]+|[\s*_`#>\-~]+$")


@dataclass(frozen=True, slots=True)
class QAPairUnit:
    """Detected Q/A unit with source offsets."""

    qa_id: str
    question: str
    answer: str
    section_path: str | None
    start: int
    end: int
    confidence: float

    @property
    def text(self) -> str:
        return f"Q: {self.question}\n\nA: {self.answer}".strip()


def build_qa_pair_nodes(documents: list[Document]) -> list[TextNode] | None:
    """Return one node per Q/A pair when a document is clearly Q/A structured."""
    all_units: list[tuple[QAPairUnit, dict[str, Any]]] = []

    for document_index, document in enumerate(documents):
        text = document.text or ""
        units = extract_qa_pairs(text, document_index=document_index)
        if units:
            all_units.extend((unit, dict(document.metadata or {})) for unit in units)

    if not _is_confident_qa_document(documents, [unit for unit, _ in all_units]):
        return None

    nodes: list[TextNode] = []
    for index, (unit, source_metadata) in enumerate(all_units):
        metadata = {
            **source_metadata,
            "node_role": "qa_pair",
            "qa_id": unit.qa_id,
            "qa_index": index,
            "question": unit.question,
            "qa_confidence": unit.confidence,
            "source_position": f"{unit.start}:{unit.end}",
        }
        if unit.section_path:
            metadata["heading_path"] = unit.section_path

        nodes.append(
            TextNode(
                text=unit.text,
                metadata=metadata,
                excluded_embed_metadata_keys=[
                    "qa_id",
                    "qa_index",
                    "qa_confidence",
                    "source_position",
                ],
                excluded_llm_metadata_keys=[
                    "qa_id",
                    "qa_index",
                    "qa_confidence",
                    "source_position",
                ],
            )
        )

    return nodes


def extract_qa_pairs(text: str, *, document_index: int = 0) -> list[QAPairUnit]:
    """Extract Q/A pairs from Markdown-like or plain text content."""
    question_matches = list(QUESTION_LINE_RE.finditer(text))
    units: list[QAPairUnit] = []

    for match_index, question_match in enumerate(question_matches):
        next_start = (
            question_matches[match_index + 1].start()
            if match_index + 1 < len(question_matches)
            else len(text)
        )
        block = text[question_match.end() : next_start]
        answer_match = ANSWER_LINE_RE.search(block)
        if answer_match is None:
            continue

        answer_prefix_end = question_match.end() + answer_match.end()
        inline_answer = answer_match.group("inline").strip()
        answer_body = text[answer_prefix_end:next_start].strip()
        answer = _clean_answer_text(
            f"{inline_answer}\n{answer_body}".strip() if inline_answer else answer_body
        )
        question = _clean_boundary_text(question_match.group("question"))
        if not question or not answer:
            continue

        qa_number = question_match.group("number")
        qa_id = (
            f"doc{document_index + 1}-q{int(qa_number):04d}"
            if qa_number is not None
            else f"doc{document_index + 1}-q{len(units) + 1:04d}"
        )
        units.append(
            QAPairUnit(
                qa_id=qa_id,
                question=question,
                answer=answer,
                section_path=_extract_section_path(text, question_match.start()),
                start=question_match.start(),
                end=next_start,
                confidence=_score_pair_confidence(
                    question=question,
                    answer=answer,
                    has_number=qa_number is not None,
                ),
            )
        )

    return units


def _is_confident_qa_document(
    documents: list[Document],
    units: list[QAPairUnit],
) -> bool:
    if len(units) < MIN_QA_PAIRS_FOR_DOCUMENT:
        return False

    total_chars = sum(len(document.text or "") for document in documents)
    if total_chars <= 0:
        return False

    covered_chars = sum(unit.end - unit.start for unit in units)
    return covered_chars / total_chars >= MIN_QA_COVERAGE


def _extract_section_path(text: str, offset: int) -> str | None:
    headings = list(MARKDOWN_HEADING_RE.finditer(text[:offset]))
    if not headings:
        return None
    return _clean_boundary_text(headings[-1].group(1)) or None


def _clean_boundary_text(text: str) -> str:
    normalized = DECORATION_RE.sub("", text.strip())
    return re.sub(r"\s+", " ", normalized).strip()


def _clean_answer_text(text: str) -> str:
    lines = text.strip().splitlines()
    while lines and _is_trailing_section_marker(lines[-1]):
        lines.pop()
    return "\n".join(lines).strip()


def _is_trailing_section_marker(line: str) -> bool:
    stripped = line.strip()
    if bool(stripped) and set(stripped) <= {"-"}:
        return True
    return bool(MARKDOWN_HEADING_RE.match(line))


def _score_pair_confidence(
    *,
    question: str,
    answer: str,
    has_number: bool,
) -> float:
    score = 0.75
    if has_number:
        score += 0.1
    if len(question) >= 6 and len(answer) >= 20:
        score += 0.1
    if question.endswith(("?", "？")):
        score += 0.05
    return min(score, 1.0)
