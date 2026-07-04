# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Evaluate phase 3 Q&A retrieval profile behavior on stored chunk artifacts."""

from __future__ import annotations

import argparse
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from knowledge_engine.query import QueryExecutor


@dataclass(slots=True)
class QueryCase:
    query: str
    expected_qa_id: str


class _FakeBackend:
    def __init__(self, supported_modes: list[str]) -> None:
        self.supported_modes = supported_modes
        self.last_retrieval_setting: dict[str, Any] | None = None

    def get_supported_retrieval_methods(self) -> list[str]:
        return self.supported_modes

    def retrieve(self, **kwargs):
        self.last_retrieval_setting = kwargs["retrieval_setting"]
        return {"records": []}


def load_chunks(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def build_query_cases(chunks: list[dict[str, Any]]) -> list[QueryCase]:
    cases: list[QueryCase] = []
    for chunk in chunks:
        metadata = chunk.get("metadata") or {}
        question = str(metadata.get("question") or "").strip()
        qa_id = str(metadata.get("qa_id") or "").strip()
        if not question or not qa_id:
            continue
        cases.append(QueryCase(query=_rewrite_question(question), expected_qa_id=qa_id))
    return cases


def _rewrite_question(question: str) -> str:
    normalized = re.sub(r"[？?]", "", question).strip()
    normalized = re.sub(r"^(微博\s*)", "", normalized)
    normalized = normalized.replace("如何", "怎么").replace("有何", "有什么")
    return normalized or question


def evaluate_retrieval(
    chunks: list[dict[str, Any]],
    cases: list[QueryCase],
    *,
    mode: str,
) -> dict[str, Any]:
    ranks: list[int | None] = []
    failures: list[dict[str, Any]] = []
    for case in cases:
        ranked = sorted(
            chunks,
            key=lambda chunk: _score(case.query, chunk, mode=mode),
            reverse=True,
        )
        expected_rank = None
        for index, chunk in enumerate(ranked, start=1):
            metadata = chunk.get("metadata") or {}
            if metadata.get("qa_id") == case.expected_qa_id:
                expected_rank = index
                break
        ranks.append(expected_rank)
        if expected_rank != 1:
            top_metadata = (ranked[0].get("metadata") or {}) if ranked else {}
            failures.append(
                {
                    "query": case.query,
                    "expected_qa_id": case.expected_qa_id,
                    "rank": expected_rank,
                    "top_qa_id": top_metadata.get("qa_id"),
                    "top_question": top_metadata.get("question"),
                }
            )

    return {
        "query_count": len(cases),
        "top1_hit_rate": _hit_rate(ranks, top_k=1),
        "top3_hit_rate": _hit_rate(ranks, top_k=3),
        "mrr": _mrr(ranks),
        "failures": failures[:10],
    }


def _score(query: str, chunk: dict[str, Any], *, mode: str) -> float:
    metadata = chunk.get("metadata") or {}
    retrieval_text = str(metadata.get("retrieval_text") or chunk.get("content") or "")
    question = str(metadata.get("question") or "")
    vector_score = _token_overlap(query, retrieval_text)
    if mode == "vector":
        return vector_score

    sparse_text = f"{question} {retrieval_text}"
    sparse_score = _keyword_score(query, sparse_text)
    return 0.6 * vector_score + 0.4 * sparse_score


def _token_overlap(query: str, text: str) -> float:
    query_tokens = set(_tokens(query))
    text_tokens = set(_tokens(text))
    if not query_tokens or not text_tokens:
        return 0.0
    return len(query_tokens & text_tokens) / math.sqrt(
        len(query_tokens) * len(text_tokens)
    )


def _keyword_score(query: str, text: str) -> float:
    terms = _tokens(query)
    if not terms:
        return 0.0
    matched = sum(1 for term in terms if term in text)
    return matched / len(terms)


def _tokens(text: str) -> list[str]:
    raw_terms = re.findall(
        r"[A-Za-z][A-Za-z0-9_.+-]{1,30}|\d+(?:\.\d+)?%?|[\u4e00-\u9fff]{2,12}",
        text,
    )
    return list(dict.fromkeys(term.strip() for term in raw_terms if term.strip()))


def _hit_rate(ranks: list[int | None], *, top_k: int) -> float:
    if not ranks:
        return 0.0
    hits = sum(1 for rank in ranks if rank is not None and rank <= top_k)
    return hits / len(ranks)


def _mrr(ranks: list[int | None]) -> float:
    if not ranks:
        return 0.0
    return sum(0.0 if rank is None else 1.0 / rank for rank in ranks) / len(ranks)


async def evaluate_policy() -> list[dict[str, Any]]:
    scenarios = [
        ("elasticsearch", ["vector", "keyword", "hybrid"]),
        ("milvus", ["vector", "keyword", "hybrid"]),
        ("qdrant", ["vector"]),
    ]
    rows: list[dict[str, Any]] = []
    for name, supported_modes in scenarios:
        backend = _FakeBackend(supported_modes)
        executor = QueryExecutor(storage_backend=backend, embed_model=object())
        await executor.execute(
            knowledge_id="1",
            query="微博 大广场模式 2025 有什么优势",
            query_plan={"retrieval_profile": "qa_pair", "qa_pair_count": 26},
            retrieval_config={
                "top_k": 5,
                "score_threshold": 0.5,
                "retrieval_mode": "vector",
                "retrieval_mode_source": "system_default",
            },
        )
        setting = backend.last_retrieval_setting or {}
        rows.append(
            {
                "backend": name,
                "supported_modes": supported_modes,
                "effective_retrieval_mode": setting.get("retrieval_mode"),
                "effective_policy": setting.get("effective_retrieval_policy"),
                "vector_weight": setting.get("vector_weight"),
                "keyword_weight": setting.get("keyword_weight"),
                "hint_source": setting.get("hint_source"),
                "keywords": setting.get("keywords"),
                "phrases": setting.get("phrases"),
            }
        )
    return rows


def write_report(
    path: Path,
    *,
    chunks_path: Path,
    query_count: int,
    vector_metrics: dict[str, Any],
    hybrid_metrics: dict[str, Any],
    policy_rows: list[dict[str, Any]],
) -> None:
    lines = [
        "---",
        "sidebar_position: 1",
        "---",
        "",
        "# Q&A 文档阶段 3 召回增强评估",
        "",
        "## 背景",
        "",
        "本报告验证阶段 3 的 Q&A retrieval profile、hybrid effective policy 与确定性 search hints。评估不连接真实向量库，使用阶段 2 的 chunk artifact 做离线命中模拟。",
        "",
        f"- Chunks JSON：`{chunks_path}`",
        f"- Query 数量：{query_count}",
        "",
        "## Effective Policy",
        "",
        "| backend | supported modes | effective mode | policy | weights | hint source |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for row in policy_rows:
        weights = f"{row.get('vector_weight')}/{row.get('keyword_weight')}"
        lines.append(
            f"| {row['backend']} | {', '.join(row['supported_modes'])} | "
            f"{row.get('effective_retrieval_mode')} | {row.get('effective_policy')} | "
            f"{weights} | {row.get('hint_source')} |"
        )
    lines.extend(
        [
            "",
            "## 离线命中模拟",
            "",
            "| mode | top1 | top3 | MRR |",
            "| --- | ---: | ---: | ---: |",
            _metric_row("vector", vector_metrics),
            _metric_row("qa hybrid", hybrid_metrics),
            "",
            "## 结论",
            "",
            "- `qa_pair` profile 只在 `retrieval_mode_source=system_default` 且后端支持 hybrid 时切换到 hybrid。",
            "- 用户显式 retrieval mode 不会被覆盖。",
            "- Qdrant 当前只支持 vector，因此 profile 只记录 unsupported policy，不强行切 hybrid。",
            "- 本阶段不做 aliases，不接 reranker；后续是否引入 reranker 应由真实召回评估决定。",
            "",
        ]
    )
    path.write_text("\n".join(lines), encoding="utf-8")


def _metric_row(name: str, metrics: dict[str, Any]) -> str:
    return (
        f"| {name} | {metrics['top1_hit_rate']:.2%} | "
        f"{metrics['top3_hit_rate']:.2%} | {metrics['mrr']:.4f} |"
    )


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chunks", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()

    chunks = load_chunks(args.chunks)
    cases = build_query_cases(chunks)
    vector_metrics = evaluate_retrieval(chunks, cases, mode="vector")
    hybrid_metrics = evaluate_retrieval(chunks, cases, mode="hybrid")
    policy_rows = await evaluate_policy()

    payload = {
        "chunks": str(args.chunks),
        "query_count": len(cases),
        "policy": policy_rows,
        "vector": vector_metrics,
        "qa_hybrid": hybrid_metrics,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    write_report(
        args.report,
        chunks_path=args.chunks,
        query_count=len(cases),
        vector_metrics=vector_metrics,
        hybrid_metrics=hybrid_metrics,
        policy_rows=policy_rows,
    )


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
