# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Evaluate current splitter behavior on Q&A-style documents.

This script is intentionally offline: it does not call Celery, knowledge_runtime,
databases, embedding providers, or vector stores. It reuses the current
knowledge_engine ingestion pipeline to produce splitter outputs for a .txt and
.md version of the same source content, then writes a baseline report.
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from llama_index.core import Document

from knowledge_engine.ingestion.pipeline import build_ingestion_result

QUESTION_LINE_RE = re.compile(
    r"^\s*(?:\*\*)?(Q(?P<number>\d+)[：:]\s*(?P<question>.+?))(?:\*\*)?\s*$",
    re.MULTILINE,
)
ANSWER_LINE_RE = re.compile(r"^\s*(?:\*\*)?A[：:](?:\*\*)?\s*$", re.MULTILINE)


@dataclass(frozen=True)
class QAPair:
    index: int
    qid: str
    question: str
    answer: str
    section_path: str
    start: int
    end: int


@dataclass(frozen=True)
class ChunkInfo:
    index: int
    content: str
    char_count: int
    token_count_estimate: int
    metadata: dict[str, Any]


def _normalize_text(text: str) -> str:
    text = re.sub(r"[*_`>#\-\|\[\]\(\)~]+", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip().lower()


def _extract_heading_before(content: str, offset: int) -> str:
    headings = list(
        re.finditer(r"^\s{0,3}#{1,6}\s+(.+?)\s*$", content[:offset], re.MULTILINE)
    )
    if not headings:
        return ""
    return headings[-1].group(1).strip()


def extract_qa_pairs(content: str) -> list[QAPair]:
    """Extract simple Q/A blocks from Markdown-like content."""
    matches = list(QUESTION_LINE_RE.finditer(content))
    pairs: list[QAPair] = []

    for idx, match in enumerate(matches):
        next_start = (
            matches[idx + 1].start() if idx + 1 < len(matches) else len(content)
        )
        block = content[match.end() : next_start]
        answer_match = ANSWER_LINE_RE.search(block)
        if answer_match is None:
            continue

        answer_start = match.end() + answer_match.end()
        answer = content[answer_start:next_start].strip()
        pairs.append(
            QAPair(
                index=len(pairs),
                qid=f"Q{match.group('number')}",
                question=match.group("question").strip().rstrip("*").strip(),
                answer=answer,
                section_path=_extract_heading_before(content, match.start()),
                start=match.start(),
                end=next_start,
            )
        )

    return pairs


def build_chunks(
    content: str, *, file_extension: str
) -> tuple[list[ChunkInfo], dict[str, Any]]:
    """Run the current runtime default splitter for one file extension."""
    result = build_ingestion_result(
        documents=[Document(text=content)],
        splitter_config=None,
        file_extension=file_extension,
        embed_model=None,
    )
    chunks = [
        ChunkInfo(
            index=idx,
            content=node.text or "",
            char_count=len(node.text or ""),
            token_count_estimate=len(node.text or "") // 4,
            metadata=dict(node.metadata or {}),
        )
        for idx, node in enumerate(result.index_nodes)
    ]
    splitter = result.normalized_splitter_config
    splitter_summary = {
        "chunk_strategy": splitter.chunk_strategy,
        "format_enhancement": splitter.format_enhancement,
        "parser_subtype": result.parser_subtype,
        "flat_config": (
            splitter.flat_config.model_dump() if splitter.flat_config else None
        ),
        "markdown_enhancement": splitter.markdown_enhancement.model_dump(),
    }
    return chunks, splitter_summary


def _chunk_question_ids(chunk_content: str) -> list[str]:
    return [
        f"Q{match.group('number')}"
        for match in QUESTION_LINE_RE.finditer(chunk_content)
    ]


def evaluate_chunks(qa_pairs: list[QAPair], chunks: list[ChunkInfo]) -> dict[str, Any]:
    """Evaluate chunk quality for Q/A retrieval boundaries."""
    chunk_norms = [_normalize_text(chunk.content) for chunk in chunks]
    rows: list[dict[str, Any]] = []

    for pair in qa_pairs:
        question_norm = _normalize_text(pair.question)
        answer_norm = _normalize_text(pair.answer)
        answer_probe = _normalize_text(pair.answer[:240])

        question_chunk_indexes = [
            idx for idx, text in enumerate(chunk_norms) if question_norm in text
        ]
        answer_start_chunk_indexes = [
            idx
            for idx, text in enumerate(chunk_norms)
            if answer_probe and answer_probe in text
        ]
        full_answer_chunk_indexes = [
            idx
            for idx, text in enumerate(chunk_norms)
            if answer_norm and answer_norm in text
        ]

        question_chunk = question_chunk_indexes[0] if question_chunk_indexes else None
        same_chunk_answer_start = (
            question_chunk in answer_start_chunk_indexes
            if question_chunk is not None
            else False
        )
        same_chunk_full_answer = (
            question_chunk in full_answer_chunk_indexes
            if question_chunk is not None
            else False
        )

        rows.append(
            {
                "qid": pair.qid,
                "section_path": pair.section_path,
                "question": pair.question,
                "answer_chars": len(pair.answer),
                "question_chunk": question_chunk,
                "question_found": question_chunk is not None,
                "answer_start_found": bool(answer_start_chunk_indexes),
                "same_chunk_answer_start": same_chunk_answer_start,
                "same_chunk_full_answer": same_chunk_full_answer,
                "question_chunk_qids": (
                    _chunk_question_ids(chunks[question_chunk].content)
                    if question_chunk is not None
                    else []
                ),
            }
        )

    mixed_chunks = []
    for chunk in chunks:
        qids = _chunk_question_ids(chunk.content)
        if len(qids) > 1:
            mixed_chunks.append(
                {
                    "chunk_index": chunk.index,
                    "qids": qids,
                    "char_count": chunk.char_count,
                }
            )

    total = len(rows)
    question_found = sum(1 for row in rows if row["question_found"])
    same_start = sum(1 for row in rows if row["same_chunk_answer_start"])
    same_full = sum(1 for row in rows if row["same_chunk_full_answer"])
    return {
        "summary": {
            "qa_pairs": total,
            "chunks": len(chunks),
            "question_found": question_found,
            "same_chunk_answer_start": same_start,
            "same_chunk_full_answer": same_full,
            "mixed_qa_chunks": len(mixed_chunks),
            "question_found_rate": round(question_found / total, 4) if total else 0,
            "same_chunk_answer_start_rate": (
                round(same_start / total, 4) if total else 0
            ),
            "same_chunk_full_answer_rate": round(same_full / total, 4) if total else 0,
        },
        "rows": rows,
        "mixed_chunks": mixed_chunks,
    }


def _write_json(path: Path, payload: Any) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _sample_chunk_lines(chunks: list[ChunkInfo], limit: int = 5) -> list[str]:
    lines = []
    for chunk in chunks[:limit]:
        preview = " ".join(chunk.content.split())[:180]
        lines.append(
            f"| {chunk.index} | {chunk.char_count} | "
            f"{chunk.metadata.get('parser_subtype', '')} | {preview} |"
        )
    return lines


def _failure_rows(rows: list[dict[str, Any]], limit: int = 8) -> list[dict[str, Any]]:
    failures = [
        row
        for row in rows
        if not row["same_chunk_answer_start"] or len(row["question_chunk_qids"]) > 1
    ]
    return failures[:limit]


def build_report(
    *,
    source_path: Path,
    output_dir: Path,
    qa_pairs: list[QAPair],
    results: dict[str, dict[str, Any]],
    chunks_by_kind: dict[str, list[ChunkInfo]],
    splitter_by_kind: dict[str, dict[str, Any]],
) -> str:
    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines = [
        "---",
        "sidebar_position: 1",
        "---",
        "",
        "# Q&A 文档当前分片评估基线",
        "",
        "## 背景",
        "",
        "本报告用于完成“更优阶段 0：评估与可观测性先行”。它不调用 Celery、数据库、knowledge_runtime 或向量库，只复用当前 `knowledge_engine` runtime 默认 splitter，对同一份 Q&A 内容生成 `.txt` 和 `.md` 两种样本并离线评估。",
        "",
        f"- 生成时间：{generated_at}",
        f"- 原始文件：`{source_path}`",
        f"- 输出目录：`{output_dir}`",
        f"- 抽取 Q&A 数量：{len(qa_pairs)}",
        "",
        "## 样本文件",
        "",
        "| 类型 | 路径 |",
        "| --- | --- |",
        f"| txt | `{output_dir / 'qa_marketing_sample.txt'}` |",
        f"| md | `{output_dir / 'qa_marketing_sample.md'}` |",
        "",
        "## 分片配置",
        "",
        "| 类型 | chunk_strategy | format_enhancement | parser_subtype | chunk_size | chunk_overlap | markdown_enhancement |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]

    for kind in ["txt", "md"]:
        splitter = splitter_by_kind[kind]
        flat = splitter.get("flat_config") or {}
        markdown = splitter.get("markdown_enhancement") or {}
        lines.append(
            f"| {kind} | {splitter.get('chunk_strategy')} | "
            f"{splitter.get('format_enhancement')} | "
            f"{splitter.get('parser_subtype')} | "
            f"{flat.get('chunk_size')} | {flat.get('chunk_overlap')} | "
            f"{markdown.get('enabled')} |"
        )

    lines.extend(
        [
            "",
            "## 评估摘要",
            "",
            "| 类型 | chunks | Q&A | question found | answer start same chunk | full answer same chunk | mixed Q&A chunks |",
            "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    for kind in ["txt", "md"]:
        summary = results[kind]["summary"]
        lines.append(
            f"| {kind} | {summary['chunks']} | {summary['qa_pairs']} | "
            f"{summary['question_found']} ({summary['question_found_rate']:.0%}) | "
            f"{summary['same_chunk_answer_start']} ({summary['same_chunk_answer_start_rate']:.0%}) | "
            f"{summary['same_chunk_full_answer']} ({summary['same_chunk_full_answer_rate']:.0%}) | "
            f"{summary['mixed_qa_chunks']} |"
        )

    lines.extend(
        [
            "",
            "## 前 5 个分片预览",
            "",
        ]
    )
    for kind in ["txt", "md"]:
        lines.extend(
            [
                f"### {kind}",
                "",
                "| chunk | chars | parser_subtype | preview |",
                "| ---: | ---: | --- | --- |",
                *_sample_chunk_lines(chunks_by_kind[kind]),
                "",
            ]
        )

    lines.extend(
        [
            "## 典型问题",
            "",
            "下面列出未能把问题与答案开头放在同一 chunk，或同一 chunk 混入多个 Q&A 的样例。",
            "",
        ]
    )
    for kind in ["txt", "md"]:
        failures = _failure_rows(results[kind]["rows"])
        lines.extend(
            [
                f"### {kind}",
                "",
                "| QID | section | question_chunk | chunk_qids | answer_chars | question |",
                "| --- | --- | ---: | --- | ---: | --- |",
            ]
        )
        if not failures:
            lines.append("| - | - | - | - | - | 无典型失败样例 |")
        for row in failures:
            qids = ", ".join(row["question_chunk_qids"])
            question = row["question"].replace("|", "\\|")
            lines.append(
                f"| {row['qid']} | {row['section_path']} | "
                f"{row['question_chunk']} | {qids} | "
                f"{row['answer_chars']} | {question} |"
            )
        lines.append("")

    lines.extend(
        [
            "## 结论",
            "",
            "- 本报告只验证当前 splitter 的边界质量，不评价向量召回排序效果。",
            "- `.txt` 与 `.md` 的差异来自 file-aware parser subtype：`.txt` 使用 `sentence`，`.md` 使用 `markdown_sentence`。",
            "- 如果大量 Q&A 无法保持同 chunk 或 mixed Q&A chunks 较多，说明仅依赖普通 splitter 难以稳定服务 FAQ 场景。",
            "- 阶段 1 应优先实现规则型 Q/A 单元化，并保持 `node.text = Q + A`，避免破坏当前 retrieval 返回语义。",
            "",
            "## 产物",
            "",
            f"- Chunks JSON：`{output_dir / 'chunks_txt.json'}`、`{output_dir / 'chunks_md.json'}`",
            f"- Evaluation JSON：`{output_dir / 'evaluation_txt.json'}`、`{output_dir / 'evaluation_md.json'}`",
        ]
    )

    return "\n".join(lines) + "\n"


def run(source_path: Path, output_dir: Path, report_path: Path) -> None:
    content = source_path.read_text(encoding="utf-8")
    output_dir.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)

    txt_sample = output_dir / "qa_marketing_sample.txt"
    md_sample = output_dir / "qa_marketing_sample.md"
    txt_sample.write_text(content, encoding="utf-8")
    md_sample.write_text(content, encoding="utf-8")

    qa_pairs = extract_qa_pairs(content)
    if not qa_pairs:
        raise RuntimeError(f"No Q&A pairs detected in {source_path}")

    chunks_by_kind: dict[str, list[ChunkInfo]] = {}
    splitter_by_kind: dict[str, dict[str, Any]] = {}
    results: dict[str, dict[str, Any]] = {}

    for kind, extension in [("txt", ".txt"), ("md", ".md")]:
        chunks, splitter_summary = build_chunks(content, file_extension=extension)
        evaluation = evaluate_chunks(qa_pairs, chunks)
        chunks_by_kind[kind] = chunks
        splitter_by_kind[kind] = splitter_summary
        results[kind] = evaluation

        _write_json(
            output_dir / f"chunks_{kind}.json",
            [asdict(chunk) for chunk in chunks],
        )
        _write_json(output_dir / f"evaluation_{kind}.json", evaluation)

    _write_json(output_dir / "qa_pairs.json", [asdict(pair) for pair in qa_pairs])
    report = build_report(
        source_path=source_path,
        output_dir=output_dir,
        qa_pairs=qa_pairs,
        results=results,
        chunks_by_kind=chunks_by_kind,
        splitter_by_kind=splitter_by_kind,
    )
    report_path.write_text(report, encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate current Q&A chunking behavior for txt and md samples."
    )
    parser.add_argument(
        "--source",
        type=Path,
        required=True,
        help="Source Q&A text file.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("../docs/discussions/assets/qa-index-eval"),
        help="Directory for generated samples and JSON artifacts.",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=Path("../docs/discussions/260704_1015_QA文档当前分片评估基线.md"),
        help="Markdown report path.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    run(
        source_path=args.source.resolve(),
        output_dir=args.output_dir.resolve(),
        report_path=args.report.resolve(),
    )


if __name__ == "__main__":
    main()
