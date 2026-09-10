# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the Xiaoxin HR pull, validation, projection, and provider."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import logging
import subprocess
import sys
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest
from llama_index.core import Document
from pytest_httpx import IteratorStream

from app.core.config import settings
from app.services.knowledge import xiaoxin as xiaoxin_module
from app.services.knowledge.external_document_providers import (
    ExternalDocumentFetchError,
    ExternalDocumentImportError,
    get_external_document_provider,
)
from app.services.knowledge.xiaoxin import (
    XIAOXIN_APP_ID,
    XIAOXIN_MAX_RESPONSE_BYTES,
    XiaoxinExternalDocumentProvider,
    build_xiaoxin_sign,
    project_xiaoxin_faq,
    pull_xiaoxin_hr_snapshot,
)
from knowledge_engine.ingestion.pipeline import build_ingestion_result
from knowledge_engine.ingestion.qa_unitizer import unitize_qa_documents

DEFAULT_UPDATED_AT = "2026-08-31 10:20:30"


def _public_knowledge(
    knowledge_id: int = 1,
    *,
    category: str = "员工关系",
    question: str = "公共问题",
    answer: str = "公共答案",
) -> dict[str, Any]:
    return {
        "knowledge_id": knowledge_id,
        "category": category,
        "question": question,
        "updated_at": DEFAULT_UPDATED_AT,
        "answer_scope": "public",
        "answer": answer,
    }


def _response(items: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    knowledge = items if items is not None else [_public_knowledge()]
    knowledge = [{"updated_at": DEFAULT_UPDATED_AT, **item} for item in knowledge]
    return {
        "code": 0,
        "message": "",
        "data": {"domain": "HR", "total": len(knowledge), "list": knowledge},
    }


@pytest.fixture
def configured_xiaoxin(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        settings,
        "XIAOXIN_KNOWLEDGE_PULL_URL",
        "http://xiaoxin.test.erp.sina.com.cn/api/robot/knowledge/pull",
    )
    monkeypatch.setattr(settings, "XIAOXIN_SIGN_SECRET", "secret-value")


def test_signature_uses_required_order_and_lowercase_sha256() -> None:
    raw = "app_id=wegent-app&timestamp=1788144000&key=secret-value"

    sign = build_xiaoxin_sign("wegent-app", 1788144000, "secret-value")

    assert sign == hashlib.sha256(raw.encode("utf-8")).hexdigest()
    assert sign == sign.lower()


def test_xiaoxin_environment_settings_have_no_default() -> None:
    from app.core.config import Settings

    assert XIAOXIN_APP_ID == "robot"
    assert Settings.model_fields["XIAOXIN_KNOWLEDGE_PULL_URL"].default == ""
    assert Settings.model_fields["XIAOXIN_SIGN_SECRET"].default == ""


@pytest.mark.asyncio
async def test_pull_uses_configured_url_domain_headers_and_current_seconds(
    httpx_mock,
    monkeypatch: pytest.MonkeyPatch,
    configured_xiaoxin: None,
) -> None:
    monkeypatch.setattr("app.services.knowledge.xiaoxin.time.time", lambda: 1788144000)
    httpx_mock.add_response(json=_response())

    snapshot = await pull_xiaoxin_hr_snapshot()

    request = httpx_mock.get_request()
    assert snapshot.domain == "HR"
    assert str(request.url) == (
        "http://xiaoxin.test.erp.sina.com.cn/api/robot/knowledge/pull?domain=HR"
    )
    assert request.headers["X-App-Id"] == XIAOXIN_APP_ID
    assert request.headers["X-Timestamp"] == "1788144000"
    assert request.headers["X-Sign"] == build_xiaoxin_sign(
        XIAOXIN_APP_ID, 1788144000, "secret-value"
    )


@pytest.mark.asyncio
async def test_pull_does_not_follow_redirects(
    httpx_mock,
    configured_xiaoxin: None,
) -> None:
    httpx_mock.add_response(
        status_code=302,
        headers={"Location": "https://untrusted.example.test/snapshot"},
    )

    with pytest.raises(
        ExternalDocumentFetchError,
        match="unsuccessful HTTP status",
    ):
        await pull_xiaoxin_hr_snapshot()

    assert len(httpx_mock.get_requests()) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("response_kwargs", "message", "error_code"),
    [
        (
            {"status_code": 503, "text": "credential=do-not-expose"},
            "HTTP status",
            "xiaoxin_pull_http_failed",
        ),
        (
            {"content": b"not-json secret-body"},
            "invalid JSON",
            "xiaoxin_pull_response_invalid",
        ),
        (
            {"json": {"code": 19, "message": "secret-body"}},
            "business error",
            "xiaoxin_pull_business_error",
        ),
    ],
)
async def test_pull_returns_stable_sanitized_errors(
    httpx_mock,
    configured_xiaoxin: None,
    response_kwargs: dict[str, Any],
    message: str,
    error_code: str,
) -> None:
    httpx_mock.add_response(**response_kwargs)

    with pytest.raises(ExternalDocumentFetchError, match=message) as exc_info:
        await pull_xiaoxin_hr_snapshot()

    assert "secret" not in str(exc_info.value)
    assert "credential" not in str(exc_info.value)
    assert exc_info.value.error_code == error_code


@pytest.mark.asyncio
async def test_pull_converts_timeout_to_stable_error(
    httpx_mock,
    configured_xiaoxin: None,
) -> None:
    httpx_mock.add_exception(httpx.ReadTimeout("upstream secret timeout"))

    with pytest.raises(ExternalDocumentFetchError, match="timed out") as exc_info:
        await pull_xiaoxin_hr_snapshot()

    assert "secret" not in str(exc_info.value)
    assert exc_info.value.error_code == "xiaoxin_pull_timeout"


@pytest.mark.asyncio
async def test_pull_limits_total_wall_clock_time(
    httpx_mock,
    monkeypatch: pytest.MonkeyPatch,
    configured_xiaoxin: None,
) -> None:
    class DelayedSnapshotStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            await asyncio.sleep(0.05)
            yield b'{"code":0,"data":{"domain":"HR","total":0,"list":[]}}'

    monkeypatch.setattr(
        xiaoxin_module,
        "XIAOXIN_PULL_TIMEOUT_SECONDS",
        0.001,
    )
    httpx_mock.add_response(stream=DelayedSnapshotStream())

    with pytest.raises(ExternalDocumentFetchError, match="timed out"):
        await pull_xiaoxin_hr_snapshot()


@pytest.mark.asyncio
@pytest.mark.parametrize("use_declared_size", [True, False])
async def test_pull_rejects_response_over_ten_megabytes(
    httpx_mock,
    configured_xiaoxin: None,
    use_declared_size: bool,
) -> None:
    if use_declared_size:
        httpx_mock.add_response(
            headers={"Content-Length": str(XIAOXIN_MAX_RESPONSE_BYTES + 1)},
            content=b"{}",
        )
    else:
        httpx_mock.add_response(
            stream=IteratorStream([b"x" * XIAOXIN_MAX_RESPONSE_BYTES, b"overflow"])
        )

    with pytest.raises(ExternalDocumentFetchError, match="exceeds 10 MB"):
        await pull_xiaoxin_hr_snapshot()


def _set_path(payload: dict[str, Any], path: tuple[Any, ...], value: Any) -> None:
    target: Any = payload
    for part in path[:-1]:
        target = target[part]
    target[path[-1]] = value


INVALID_SNAPSHOTS = [
    ("wrong domain", ("data", "domain"), "IT"),
    ("wrong total", ("data", "total"), 2),
    ("wrong id type", ("data", "list", 0, "knowledge_id"), "1"),
    ("blank question", ("data", "list", 0, "question"), "  "),
    ("wrong updated at type", ("data", "list", 0, "updated_at"), 1),
    ("blank updated at", ("data", "list", 0, "updated_at"), "  "),
    ("wrong category type", ("data", "list", 0, "category"), None),
    ("blank public answer", ("data", "list", 0, "answer"), "\n"),
    ("wrong similar questions", ("data", "list", 0, "similar_questions"), [1]),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(("_case", "path", "value"), INVALID_SNAPSHOTS)
async def test_pull_rejects_invalid_snapshot_fields(
    httpx_mock,
    configured_xiaoxin: None,
    _case: str,
    path: tuple[Any, ...],
    value: Any,
) -> None:
    payload = _response()
    _set_path(payload, path, value)
    httpx_mock.add_response(json=payload)

    with pytest.raises(ExternalDocumentFetchError, match="validation failed"):
        await pull_xiaoxin_hr_snapshot()


@pytest.mark.asyncio
async def test_pull_rejects_missing_updated_at(
    httpx_mock,
    configured_xiaoxin: None,
) -> None:
    payload = _response()
    del payload["data"]["list"][0]["updated_at"]
    httpx_mock.add_response(json=payload)

    with pytest.raises(ExternalDocumentFetchError, match="validation failed"):
        await pull_xiaoxin_hr_snapshot()


@pytest.mark.asyncio
async def test_pull_rejects_duplicate_knowledge_ids(
    httpx_mock,
    configured_xiaoxin: None,
) -> None:
    httpx_mock.add_response(json=_response([_public_knowledge(), _public_knowledge()]))

    with pytest.raises(ExternalDocumentFetchError, match="validation failed"):
        await pull_xiaoxin_hr_snapshot()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "item",
    [
        {**_public_knowledge(), "answers": [{"region": "北京", "answer": "a"}]},
        {
            **_public_knowledge(),
            "answer_scope": "region",
            "answers": [{"region": "北京", "answer": "a"}],
        },
        {
            **_public_knowledge(),
            "answer_scope": "employee",
            "answers": [{"employee_type": "A", "answer": "a"}],
        },
    ],
)
async def test_scope_fields_are_mutually_exclusive(
    httpx_mock,
    configured_xiaoxin: None,
    item: dict[str, Any],
) -> None:
    # Scoped variants still contain the public ``answer`` from the fixture.
    httpx_mock.add_response(json=_response([item]))

    with pytest.raises(ExternalDocumentFetchError, match="validation failed"):
        await pull_xiaoxin_hr_snapshot()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "item",
    [
        {
            "knowledge_id": 1,
            "category": "考勤",
            "question": "地域问题",
            "answer_scope": "region",
            "answers": [
                {"region": "郑州", "answer": "a"},
                {"region": "郑州", "answer": "b"},
            ],
        },
        {
            "knowledge_id": 1,
            "category": "考勤",
            "question": "员工问题",
            "answer_scope": "employee",
            "answers": [
                {"employee_type": "H", "answer": "a"},
                {"employee_type": "H", "answer": "b"},
            ],
        },
    ],
)
async def test_pull_rejects_duplicate_dynamic_scope_values(
    httpx_mock,
    configured_xiaoxin: None,
    item: dict[str, Any],
) -> None:
    httpx_mock.add_response(json=_response([item]))

    with pytest.raises(ExternalDocumentFetchError, match="validation failed"):
        await pull_xiaoxin_hr_snapshot()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "item",
    [
        {
            "knowledge_id": 1,
            "category": "考勤",
            "question": "地域问题",
            "answer_scope": "region",
            "answers": [],
        },
        {
            "knowledge_id": 1,
            "category": "考勤",
            "question": "地域问题",
            "answer_scope": "region",
            "answers": [{"region": " ", "answer": "a"}],
        },
        {
            "knowledge_id": 1,
            "category": "考勤",
            "question": "地域问题",
            "answer_scope": "region",
            "answers": [{"region": "郑州", "answer": "\n"}],
        },
        {
            "knowledge_id": 1,
            "category": "考勤",
            "question": "员工问题",
            "answer_scope": "employee",
            "answers": [],
        },
        {
            "knowledge_id": 1,
            "category": "考勤",
            "question": "员工问题",
            "answer_scope": "employee",
            "answers": [{"employee_type": " ", "answer": "a"}],
        },
        {
            "knowledge_id": 1,
            "category": "考勤",
            "question": "员工问题",
            "answer_scope": "employee",
            "answers": [{"employee_type": "H", "answer": "\n"}],
        },
    ],
)
async def test_pull_rejects_empty_scoped_answers_and_values(
    httpx_mock,
    configured_xiaoxin: None,
    item: dict[str, Any],
) -> None:
    httpx_mock.add_response(json=_response([item]))

    with pytest.raises(ExternalDocumentFetchError, match="validation failed"):
        await pull_xiaoxin_hr_snapshot()


@pytest.mark.asyncio
async def test_projection_filters_expands_sorts_and_renders_exact_markdown(
    httpx_mock,
    configured_xiaoxin: None,
) -> None:
    items = [
        {
            "knowledge_id": 20,
            "category": "绩效",
            "question": "  员工   规则 ",
            "answer_scope": "employee",
            "answers": [
                {"employee_type": "H", "answer": "H 答案"},
                {"employee_type": "外包", "answer": "外包答案"},
            ],
        },
        _public_knowledge(
            10,
            category="",
            question="公共问题",
            answer="第一行\n\n第二行，见 https://example.test/a?q=1",
        ),
        {
            "knowledge_id": 11,
            "category": "考勤",
            "question": "产假多久",
            "answer_scope": "region",
            "answers": [
                {"region": "深圳", "answer": "深圳答案"},
                {"region": "郑州", "answer": "郑州答案"},
            ],
            "similar_questions": ["产假几天", "产假多久"],
        },
        _public_knowledge(12, category="商保体检", question="过滤我"),
        _public_knowledge(13, category="ER政策法规", question="过滤法规"),
    ]
    httpx_mock.add_response(json=_response(items))
    snapshot = await pull_xiaoxin_hr_snapshot()

    projection = project_xiaoxin_faq(snapshot)
    expected_markdown = """# HR FAQ

## 其他

Q: 公共问题

A: 【适用范围】全体员工
第一行
第二行，见 https://example.test/a?q=1
知识ID：10
更新时间：2026-08-31 10:20:30

## 绩效

Q: 【员工类型H】员工 规则

A: 【适用范围】员工类型为H的员工
H 答案
知识ID：20
更新时间：2026-08-31 10:20:30

Q: 【员工类型外包】员工 规则

A: 【适用范围】员工类型为外包的员工
外包答案
知识ID：20
更新时间：2026-08-31 10:20:30

## 考勤

Q: 【深圳地区】产假多久（相似问法：产假几天）

A: 【适用范围】深圳地区员工
深圳答案
知识ID：11
更新时间：2026-08-31 10:20:30

Q: 【郑州地区】产假多久（相似问法：产假几天）

A: 【适用范围】郑州地区员工
郑州答案
知识ID：11
更新时间：2026-08-31 10:20:30
"""
    unitized = unitize_qa_documents([Document(text=projection.markdown)])

    assert {
        "source_total": projection.source_total,
        "filtered_count": projection.filtered_count,
        "generated_qa_count": projection.generated_qa_count,
        "markdown": projection.markdown,
        "forbidden_terms": [
            term
            for term in (
                "updated_at",
                "sync_time",
                "来源",
                "编辑人",
                "faq_count",
                "---",
            )
            if term in projection.markdown
        ],
        "unitized": (
            None
            if unitized is None
            else {
                "qa_count": len(unitized.qa_nodes),
                "prose_documents": unitized.prose_documents,
            }
        ),
    } == {
        "source_total": 5,
        "filtered_count": 2,
        "generated_qa_count": 5,
        "markdown": expected_markdown,
        "forbidden_terms": [],
        "unitized": {"qa_count": 5, "prose_documents": []},
    }


@pytest.mark.asyncio
async def test_projection_groups_whitespace_only_category_under_other(
    httpx_mock,
    configured_xiaoxin: None,
) -> None:
    httpx_mock.add_response(
        json=_response([_public_knowledge(category=" \t", question="空分类问题")])
    )

    projection = project_xiaoxin_faq(await pull_xiaoxin_hr_snapshot())

    assert "## 其他\n" in projection.markdown
    assert "##  \t\n" not in projection.markdown


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "items",
    [
        [],
        [_public_knowledge(question="唯一问题")],
    ],
)
async def test_projection_with_fewer_than_two_faqs_uses_normal_markdown_indexing(
    httpx_mock,
    configured_xiaoxin: None,
    items: list[dict[str, Any]],
) -> None:
    httpx_mock.add_response(json=_response(items))

    projection = project_xiaoxin_faq(await pull_xiaoxin_hr_snapshot())
    ingestion = build_ingestion_result(
        documents=[Document(text=projection.markdown)],
        splitter_config=None,
        file_extension=".md",
        embed_model=MagicMock(),
    )

    assert projection.generated_qa_count == len(items)
    assert unitize_qa_documents([Document(text=projection.markdown)]) is None
    assert ingestion.parser_subtype == "markdown_sentence"
    assert len(ingestion.index_nodes) == 1
    assert ingestion.index_nodes[0].metadata["node_role"] == "chunk"


def test_provider_is_registered_and_resolves_only_hr_without_network(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = get_external_document_provider("xiaoxin")
    assert isinstance(provider, XiaoxinExternalDocumentProvider)
    monkeypatch.setattr(
        "app.services.knowledge.xiaoxin.pull_xiaoxin_hr_snapshot",
        lambda: pytest.fail("resolve_importable must not access the network"),
    )

    metadata = provider.resolve_importable(None, None, "HR")

    assert metadata == {
        "provider": "xiaoxin",
        "resource_id": "HR",
        "domain": "HR",
        "title": "FAQ.md",
    }
    with pytest.raises(ExternalDocumentImportError) as exc_info:
        provider.resolve_importable(None, None, "IT")
    assert exc_info.value.status_code == 404


def test_xiaoxin_module_and_registry_are_import_order_independent() -> None:
    code = """
from app.services.knowledge.xiaoxin import build_xiaoxin_sign
from app.services.knowledge.external_document_providers import get_external_document_provider

assert build_xiaoxin_sign("app", 1, "secret")
assert get_external_document_provider("xiaoxin") is not None
"""

    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        check=False,
        timeout=10,
    )

    assert result.returncode == 0, result.stderr


@pytest.mark.asyncio
async def test_provider_fetch_returns_attachment_ready_faq_and_minimal_metadata(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    provider = XiaoxinExternalDocumentProvider()
    payload = _response([_public_knowledge(), _public_knowledge(2)])

    async def fake_pull():
        from app.services.knowledge.xiaoxin import _XiaoxinResponse

        return _XiaoxinResponse.model_validate(copy.deepcopy(payload)).data

    monkeypatch.setattr(
        "app.services.knowledge.xiaoxin.pull_xiaoxin_hr_snapshot",
        fake_pull,
    )

    with caplog.at_level(logging.INFO, logger="app.services.knowledge.xiaoxin"):
        content = await provider.fetch_content(None, SimpleNamespace(), "HR")

    assert content.name == "FAQ.md"
    assert content.file_extension == "md"
    assert content.content.startswith(b"# HR FAQ\n")
    assert {
        key: content.metadata[key]
        for key in (
            "provider",
            "resource_id",
            "domain",
            "source_total",
            "filtered_count",
            "generated_qa_count",
        )
    } == {
        "provider": "xiaoxin",
        "resource_id": "HR",
        "domain": "HR",
        "source_total": 2,
        "filtered_count": 0,
        "generated_qa_count": 2,
    }
    assert content.metadata["pull_elapsed_ms"] >= 0
    assert content.metadata["projection_elapsed_ms"] >= 0
    assert content.metadata["total_elapsed_ms"] >= 0
    record = next(
        item
        for item in caplog.records
        if item.message == "Xiaoxin HR snapshot projected"
    )
    assert {
        "domain": record.domain,
        "source_total": record.source_total,
        "filtered_count": record.filtered_count,
        "generated_qa_count": record.generated_qa_count,
        "has_pull_duration": record.pull_elapsed_ms >= 0,
        "has_projection_duration": record.projection_elapsed_ms >= 0,
        "has_total_duration": record.total_elapsed_ms >= 0,
    } == {
        "domain": "HR",
        "source_total": 2,
        "filtered_count": 0,
        "generated_qa_count": 2,
        "has_pull_duration": True,
        "has_projection_duration": True,
        "has_total_duration": True,
    }
