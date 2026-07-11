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
MIN_QA_COVERAGE = 0.8

QUESTION_LINE_RE = re.compile(
    r"^\s*(?:[-*]\s*)?(?:\*\*)?"
    r"(?P<label>(?:Q(?:uestion)?|问题)\s*(?P<number>\d+)?)"
    r"\s*[：:.)、]\s*(?P<question>.+?)"
    r"(?:\*\*)?\s*$",
    re.IGNORECASE,
)
ANSWER_LINE_RE = re.compile(
    r"^\s*(?:[-*]\s*)?(?:\*\*)?"
    r"(?:A(?:nswer)?|答案|答)\s*[：:.)、]\s*"
    r"(?:\*\*)?\s*(?P<inline>.*?)\s*$",
    re.IGNORECASE,
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

    @property
    def retrieval_text(self) -> str:
        parts = []
        if self.section_path:
            parts.append(f"Section: {self.section_path}")
        parts.append(f"Question: {self.question}")
        digest = _answer_digest(self.answer)
        if digest:
            parts.append(f"Answer summary: {digest}")
        return "\n".join(parts)


@dataclass(frozen=True, slots=True)
class QAUnitizationResult:
    """Q/A nodes and uncovered prose documents from one input batch."""

    qa_nodes: list[TextNode]
    prose_documents: list[Document]


@dataclass(frozen=True, slots=True)
class _SourceLine:
    """One physical source line and its original offsets."""

    text: str
    start: int
    end: int

    @property
    def is_blank(self) -> bool:
        return not self.text.strip()


def build_qa_pair_nodes(documents: list[Document]) -> list[TextNode] | None:
    """Return Q/A nodes and uncovered prose for a clear Q/A document."""
    result = unitize_qa_documents(documents)
    if result is None:
        return None

    prose_nodes = [
        TextNode(text=document.text, metadata=dict(document.metadata or {}))
        for document in result.prose_documents
    ]
    return [*result.qa_nodes, *prose_nodes]


def unitize_qa_documents(
    documents: list[Document],
) -> QAUnitizationResult | None:
    """Unitize documents when blank-line-bounded Q/A blocks cover most content."""
    extracted: list[tuple[str, list[QAPairUnit], dict[str, Any]]] = []
    all_units: list[tuple[QAPairUnit, dict[str, Any]]] = []

    for document_index, document in enumerate(documents):
        text = document.text or ""
        metadata = dict(document.metadata or {})
        units = extract_qa_pairs(text, document_index=document_index)
        extracted.append((text, units, metadata))
        all_units.extend((unit, metadata) for unit in units)

    units_only = [unit for unit, _ in all_units]
    if not _is_confident_qa_document(documents, units_only):
        return None

    qa_nodes = [
        _build_qa_node(unit=unit, index=index, source_metadata=metadata)
        for index, (unit, metadata) in enumerate(all_units)
    ]
    prose_documents: list[Document] = []
    for text, units, metadata in extracted:
        prose_documents.extend(
            _build_uncovered_documents(
                text=text,
                units=units,
                source_metadata=metadata,
            )
        )
    return QAUnitizationResult(
        qa_nodes=qa_nodes,
        prose_documents=prose_documents,
    )


def extract_qa_pairs(text: str, *, document_index: int = 0) -> list[QAPairUnit]:
    """Extract Q/A blocks whose question starts a block and answer has no blanks."""
    lines = _source_lines(text)
    question_matches = [
        match
        for line in lines
        if (match := QUESTION_LINE_RE.fullmatch(line.text)) is not None
    ]
    reserved_numbers = {
        int(match.group("number"))
        for match in question_matches
        if match.group("number") is not None
    }
    next_implicit_number = (max(reserved_numbers) + 1) if reserved_numbers else 1
    units: list[QAPairUnit] = []
    line_index = 0

    while line_index < len(lines):
        question_line = lines[line_index]
        question_match = QUESTION_LINE_RE.fullmatch(question_line.text)
        if question_match is None or not _starts_after_blank(lines, line_index):
            line_index += 1
            continue

        answer_index = _next_non_blank_line(lines, line_index + 1)
        if answer_index is None:
            break
        answer_match = ANSWER_LINE_RE.fullmatch(lines[answer_index].text)
        if answer_match is None:
            line_index += 1
            continue

        answer_end_index = answer_index + 1
        while answer_end_index < len(lines) and not lines[answer_end_index].is_blank:
            answer_end_index += 1

        answer_lines = [answer_match.group("inline").strip()]
        answer_lines.extend(
            line.text.strip() for line in lines[answer_index + 1 : answer_end_index]
        )
        question = _clean_boundary_text(question_match.group("question"))
        answer = "\n".join(line for line in answer_lines if line).strip()
        if not question or not answer:
            line_index += 1
            continue

        qa_number = question_match.group("number")
        if qa_number is not None:
            qa_sequence = int(qa_number)
        else:
            qa_sequence = next_implicit_number
            next_implicit_number += 1
        end = lines[answer_end_index - 1].end
        units.append(
            QAPairUnit(
                qa_id=f"doc{document_index + 1}-q{qa_sequence:04d}",
                question=question,
                answer=answer,
                section_path=_extract_section_path(text, question_line.start),
                start=question_line.start,
                end=end,
                confidence=_score_pair_confidence(
                    question=question,
                    answer=answer,
                    has_number=qa_number is not None,
                ),
            )
        )
        line_index = answer_end_index

    return units


def _source_lines(text: str) -> list[_SourceLine]:
    lines: list[_SourceLine] = []
    offset = 0
    for raw_line in text.splitlines(keepends=True):
        content = raw_line.rstrip("\r\n")
        lines.append(
            _SourceLine(text=content, start=offset, end=offset + len(raw_line))
        )
        offset += len(raw_line)
    if offset < len(text) or not lines:
        lines.append(_SourceLine(text=text[offset:], start=offset, end=len(text)))
    return lines


def _starts_after_blank(lines: list[_SourceLine], index: int) -> bool:
    return index == 0 or lines[index - 1].is_blank


def _next_non_blank_line(
    lines: list[_SourceLine],
    start: int,
) -> int | None:
    for index in range(start, len(lines)):
        if not lines[index].is_blank:
            return index
    return None


def _build_qa_node(
    *,
    unit: QAPairUnit,
    index: int,
    source_metadata: dict[str, Any],
) -> TextNode:
    metadata = {
        **source_metadata,
        "node_role": "qa_pair",
        "qa_id": unit.qa_id,
        "qa_index": index,
        "question": unit.question,
        "retrieval_text": unit.retrieval_text,
        "display_text": unit.text,
        "qa_confidence": unit.confidence,
        "source_position": f"{unit.start}:{unit.end}",
    }
    if unit.section_path:
        metadata["heading_path"] = unit.section_path
    excluded_keys = [
        "qa_id",
        "qa_index",
        "question",
        "qa_confidence",
        "source_position",
        "retrieval_text",
        "display_text",
    ]
    return TextNode(
        text=unit.text,
        metadata=metadata,
        excluded_embed_metadata_keys=excluded_keys,
        excluded_llm_metadata_keys=excluded_keys,
    )


def _build_uncovered_documents(
    *,
    text: str,
    units: list[QAPairUnit],
    source_metadata: dict[str, Any],
) -> list[Document]:
    documents: list[Document] = []
    cursor = 0
    for unit in sorted(units, key=lambda item: item.start):
        documents.extend(
            _build_prose_document(
                text[cursor : unit.start],
                offset=cursor,
                source_metadata=source_metadata,
            )
        )
        cursor = unit.end
    documents.extend(
        _build_prose_document(
            text[cursor:],
            offset=cursor,
            source_metadata=source_metadata,
        )
    )
    return documents


def _build_prose_document(
    text: str,
    *,
    offset: int,
    source_metadata: dict[str, Any],
) -> list[Document]:
    cleaned = text.strip()
    if not _has_substantive_prose(cleaned):
        return []
    return [
        Document(
            text=cleaned,
            metadata={
                **source_metadata,
                "node_role": "chunk",
                "source_position": f"{offset}:{offset + len(text)}",
            },
        )
    ]


def _has_substantive_prose(text: str) -> bool:
    without_headings = MARKDOWN_HEADING_RE.sub("", text)
    return bool(DECORATION_RE.sub("", without_headings.strip()))


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


def _answer_digest(answer: str, limit: int = 240) -> str:
    normalized = re.sub(r"\s+", " ", answer).strip()
    if len(normalized) <= limit:
        return normalized
    return normalized[:limit].rstrip() + "..."
