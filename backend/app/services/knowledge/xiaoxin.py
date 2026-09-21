# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Xiaoxin HR snapshot client and deterministic FAQ projection."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from dataclasses import dataclass
from typing import Annotated, Any, Literal

import httpx
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    StrictStr,
    ValidationError,
    field_validator,
    model_validator,
)
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.user import User
from app.services.knowledge.external_document_providers import (
    DirectExternalDocumentImportProvider,
    ExternalDocumentContent,
    ExternalDocumentFetchError,
    ExternalDocumentImportError,
)
from shared.telemetry.decorators import set_span_attribute, trace_async

logger = logging.getLogger(__name__)

XIAOXIN_PROVIDER_ID = "xiaoxin"
XIAOXIN_HR_RESOURCE_ID = "HR"
XIAOXIN_FAQ_FILENAME = "FAQ.md"
XIAOXIN_APP_ID = "robot"
XIAOXIN_MAX_RESPONSE_BYTES = 10 * 1024 * 1024
XIAOXIN_PULL_TIMEOUT_SECONDS = 60
XIAOXIN_HTTP_TIMEOUT = httpx.Timeout(
    connect=5.0,
    read=30.0,
    write=5.0,
    pool=5.0,
)
EXCLUDED_CATEGORIES = {"商保体检", "ER政策法规"}


class XiaoxinExternalDocumentFetchError(ExternalDocumentFetchError):
    """Safe Xiaoxin pull failure with a stable observability code."""

    def __init__(self, message: str, *, error_code: str) -> None:
        super().__init__(message)
        self.error_code = error_code


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _RegionAnswer(_StrictModel):
    region: StrictStr
    answer: StrictStr

    @field_validator("region", "answer")
    @classmethod
    def reject_blank_values(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("value must not be blank")
        return value


class _EmployeeAnswer(_StrictModel):
    employee_type: StrictStr
    answer: StrictStr

    @field_validator("employee_type", "answer")
    @classmethod
    def reject_blank_values(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("value must not be blank")
        return value


class _KnowledgeBase(_StrictModel):
    knowledge_id: StrictInt
    question: StrictStr
    category: StrictStr
    updated_at: StrictStr
    similar_questions: list[StrictStr] = Field(default_factory=list)

    @field_validator("question", "updated_at")
    @classmethod
    def reject_blank_required_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("value must not be blank")
        return value


class _PublicKnowledge(_KnowledgeBase):
    answer_scope: Literal["public"]
    answer: StrictStr

    @field_validator("answer")
    @classmethod
    def reject_blank_answer(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("answer must not be blank")
        return value


class _RegionKnowledge(_KnowledgeBase):
    answer_scope: Literal["region"]
    answers: list[_RegionAnswer] = Field(min_length=1)

    @model_validator(mode="after")
    def reject_duplicate_regions(self) -> "_RegionKnowledge":
        values = [item.region for item in self.answers]
        if len(values) != len(set(values)):
            raise ValueError("region values must be unique")
        return self


class _EmployeeKnowledge(_KnowledgeBase):
    answer_scope: Literal["employee"]
    answers: list[_EmployeeAnswer] = Field(min_length=1)

    @model_validator(mode="after")
    def reject_duplicate_employee_types(self) -> "_EmployeeKnowledge":
        values = [item.employee_type for item in self.answers]
        if len(values) != len(set(values)):
            raise ValueError("employee_type values must be unique")
        return self


XiaoxinKnowledge = Annotated[
    _PublicKnowledge | _RegionKnowledge | _EmployeeKnowledge,
    Field(discriminator="answer_scope"),
]


class XiaoxinSnapshotData(_StrictModel):
    """Validated HR snapshot payload used by the projection."""

    domain: Literal["HR"]
    total: StrictInt = Field(ge=0)
    knowledge_list: list[XiaoxinKnowledge] = Field(alias="list")

    @model_validator(mode="after")
    def validate_snapshot_identity(self) -> "XiaoxinSnapshotData":
        if self.total != len(self.knowledge_list):
            raise ValueError("total does not match list length")
        ids = [item.knowledge_id for item in self.knowledge_list]
        if len(ids) != len(set(ids)):
            raise ValueError("knowledge_id values must be unique")
        return self


class _XiaoxinResponse(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)

    code: Literal[0]
    data: XiaoxinSnapshotData


@dataclass(frozen=True, slots=True)
class ProjectedFAQ:
    """One independently retrievable Q/A block."""

    category: str
    knowledge_id: int
    updated_at: str
    question: str
    answer: str
    scope_kind: Literal["public", "region", "employee"]
    scope_value: str
    similar_questions: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class FAQProjection:
    """Rendered document plus auditable source counters."""

    markdown: str
    source_total: int
    filtered_count: int
    generated_qa_count: int


def build_xiaoxin_sign(app_id: str, timestamp: int, secret: str) -> str:
    """Build the lower-case SHA-256 signature in Xiaoxin's required order."""
    raw = f"app_id={app_id}&timestamp={timestamp}&key={secret}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


async def pull_xiaoxin_hr_snapshot() -> XiaoxinSnapshotData:
    """Pull one bounded HR snapshot from the configured Xiaoxin endpoint."""
    url = settings.XIAOXIN_KNOWLEDGE_PULL_URL.strip()
    secret = settings.XIAOXIN_SIGN_SECRET
    if not url or not secret:
        raise XiaoxinExternalDocumentFetchError(
            "Xiaoxin pull is not configured",
            error_code="xiaoxin_pull_not_configured",
        )

    timestamp = int(time.time())
    headers = {
        "X-App-Id": XIAOXIN_APP_ID,
        "X-Timestamp": str(timestamp),
        "X-Sign": build_xiaoxin_sign(XIAOXIN_APP_ID, timestamp, secret),
    }
    try:
        async with asyncio.timeout(XIAOXIN_PULL_TIMEOUT_SECONDS):
            async with httpx.AsyncClient(
                timeout=XIAOXIN_HTTP_TIMEOUT,
                follow_redirects=False,
            ) as client:
                async with client.stream(
                    "GET",
                    url,
                    params={"domain": XIAOXIN_HR_RESOURCE_ID},
                    headers=headers,
                ) as response:
                    if not 200 <= response.status_code < 300:
                        raise XiaoxinExternalDocumentFetchError(
                            "Xiaoxin pull returned an unsuccessful HTTP status",
                            error_code="xiaoxin_pull_http_failed",
                        )
                    declared_size = _parse_content_length(response.headers)
                    if (
                        declared_size is not None
                        and declared_size > XIAOXIN_MAX_RESPONSE_BYTES
                    ):
                        raise XiaoxinExternalDocumentFetchError(
                            "Xiaoxin pull response exceeds 10 MB",
                            error_code="xiaoxin_pull_response_too_large",
                        )
                    body = await _read_bounded_body(response)
    except ExternalDocumentFetchError:
        raise
    except (TimeoutError, httpx.TimeoutException):
        raise XiaoxinExternalDocumentFetchError(
            "Xiaoxin pull timed out",
            error_code="xiaoxin_pull_timeout",
        ) from None
    except httpx.HTTPError:
        raise XiaoxinExternalDocumentFetchError(
            "Xiaoxin pull request failed",
            error_code="xiaoxin_pull_transport_failed",
        ) from None

    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise XiaoxinExternalDocumentFetchError(
            "Xiaoxin pull returned invalid JSON",
            error_code="xiaoxin_pull_response_invalid",
        ) from None
    if not isinstance(payload, dict):
        raise XiaoxinExternalDocumentFetchError(
            "Xiaoxin pull returned invalid JSON",
            error_code="xiaoxin_pull_response_invalid",
        )
    if payload.get("code") != 0:
        raise XiaoxinExternalDocumentFetchError(
            "Xiaoxin pull returned a business error",
            error_code="xiaoxin_pull_business_error",
        )
    try:
        return _XiaoxinResponse.model_validate(payload).data
    except ValidationError:
        raise XiaoxinExternalDocumentFetchError(
            "Xiaoxin snapshot validation failed",
            error_code="xiaoxin_snapshot_invalid",
        ) from None


def _parse_content_length(headers: httpx.Headers) -> int | None:
    value = headers.get("content-length")
    if value is None:
        return None
    try:
        parsed = int(value)
    except ValueError:
        raise XiaoxinExternalDocumentFetchError(
            "Xiaoxin pull returned an invalid content length",
            error_code="xiaoxin_pull_response_invalid",
        ) from None
    if parsed < 0:
        raise XiaoxinExternalDocumentFetchError(
            "Xiaoxin pull returned an invalid content length",
            error_code="xiaoxin_pull_response_invalid",
        )
    return parsed


async def _read_bounded_body(response: httpx.Response) -> bytes:
    body = bytearray()
    async for chunk in response.aiter_bytes():
        if len(body) + len(chunk) > XIAOXIN_MAX_RESPONSE_BYTES:
            raise XiaoxinExternalDocumentFetchError(
                "Xiaoxin pull response exceeds 10 MB",
                error_code="xiaoxin_pull_response_too_large",
            )
        body.extend(chunk)
    return bytes(body)


def project_xiaoxin_faq(snapshot: XiaoxinSnapshotData) -> FAQProjection:
    """Filter, expand, sort, and render the authoritative FAQ.md projection."""
    retained = [
        item
        for item in snapshot.knowledge_list
        if item.category not in EXCLUDED_CATEGORIES
    ]
    rows = [row for item in retained for row in _expand_knowledge(item)]
    rows.sort(key=_faq_sort_key)
    return FAQProjection(
        markdown=_render_faq_document(rows),
        source_total=snapshot.total,
        filtered_count=snapshot.total - len(retained),
        generated_qa_count=len(rows),
    )


def _expand_knowledge(item: XiaoxinKnowledge) -> list[ProjectedFAQ]:
    common = {
        "category": item.category.strip() or "其他",
        "knowledge_id": item.knowledge_id,
        "updated_at": item.updated_at.strip(),
        "question": _normalize_inline(item.question),
        "similar_questions": tuple(
            normalized
            for value in item.similar_questions
            if (normalized := _normalize_inline(value))
        ),
    }
    if isinstance(item, _PublicKnowledge):
        return [
            ProjectedFAQ(
                **common,
                answer=_normalize_answer(item.answer),
                scope_kind="public",
                scope_value="",
            )
        ]
    if isinstance(item, _RegionKnowledge):
        return [
            ProjectedFAQ(
                **common,
                answer=_normalize_answer(answer.answer),
                scope_kind="region",
                scope_value=answer.region,
            )
            for answer in item.answers
        ]
    return [
        ProjectedFAQ(
            **common,
            answer=_normalize_answer(answer.answer),
            scope_kind="employee",
            scope_value=answer.employee_type,
        )
        for answer in item.answers
    ]


def _normalize_inline(value: str) -> str:
    return " ".join(value.split())


def _normalize_answer(value: str) -> str:
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.rstrip() for line in normalized.split("\n")]
    return "\n".join(line for line in lines if line.strip()).strip()


def _faq_sort_key(row: ProjectedFAQ) -> tuple[Any, ...]:
    scope_rank = {"public": 0, "region": 1, "employee": 2}[row.scope_kind]
    return row.category, row.knowledge_id, scope_rank, row.scope_value


def _render_faq_document(rows: list[ProjectedFAQ]) -> str:
    lines = ["# HR FAQ", ""]
    current_category: str | None = None
    for row in rows:
        if row.category != current_category:
            current_category = row.category
            lines.extend([f"## {current_category}", ""])
        lines.extend(_render_qa_block(row))
    return "\n".join(lines).rstrip() + "\n"


def _render_qa_block(row: ProjectedFAQ) -> list[str]:
    aliases = tuple(alias for alias in row.similar_questions if alias != row.question)
    prefix = ""
    scope_text = "全体员工"
    if row.scope_kind == "region":
        prefix = f"【{row.scope_value}地区】"
        scope_text = f"{row.scope_value}地区员工"
    elif row.scope_kind == "employee":
        prefix = f"【员工类型{row.scope_value}】"
        scope_text = f"员工类型为{row.scope_value}的员工"
    question = f"{prefix}{row.question}"
    if aliases:
        question += f"（相似问法：{'；'.join(aliases)}）"
    return [
        f"Q: {question}",
        "",
        f"A: 【适用范围】{scope_text}",
        row.answer,
        f"知识ID：{row.knowledge_id}",
        f"更新时间：{row.updated_at}",
        "",
    ]


class XiaoxinExternalDocumentProvider(DirectExternalDocumentImportProvider):
    """External-document adapter for the fixed Xiaoxin HR snapshot."""

    provider_id = XIAOXIN_PROVIDER_ID

    def resolve_importable(
        self,
        db: Session,
        user: User,
        external_resource_id: str,
    ) -> dict[str, Any]:
        del db, user
        if external_resource_id != XIAOXIN_HR_RESOURCE_ID:
            raise ExternalDocumentImportError(
                "Unsupported Xiaoxin knowledge domain", status_code=404
            )
        return {
            "provider": self.provider_id,
            "resource_id": XIAOXIN_HR_RESOURCE_ID,
            "domain": XIAOXIN_HR_RESOURCE_ID,
            "title": XIAOXIN_FAQ_FILENAME,
        }

    @trace_async(tracer_name="knowledge.external_import")
    async def fetch_content(
        self,
        db: Session,
        user: User,
        external_resource_id: str,
    ) -> ExternalDocumentContent:
        total_started_at = time.perf_counter()
        metadata = self.resolve_importable(db, user, external_resource_id)
        snapshot, pull_elapsed_ms = await _pull_xiaoxin_with_observability()
        projection, projection_elapsed_ms = _project_xiaoxin_with_observability(
            snapshot
        )
        metrics = _record_projection_success(
            projection,
            pull_elapsed_ms,
            projection_elapsed_ms,
            total_started_at,
        )
        return ExternalDocumentContent(
            name=XIAOXIN_FAQ_FILENAME,
            file_extension="md",
            content=projection.markdown.encode("utf-8"),
            metadata={
                "provider": metadata["provider"],
                "resource_id": metadata["resource_id"],
                "domain": metadata["domain"],
                "source_total": projection.source_total,
                "filtered_count": projection.filtered_count,
                "generated_qa_count": projection.generated_qa_count,
                "pull_elapsed_ms": metrics["pull_elapsed_ms"],
                "projection_elapsed_ms": metrics["projection_elapsed_ms"],
                "total_elapsed_ms": metrics["total_elapsed_ms"],
            },
        )


async def _pull_xiaoxin_with_observability() -> tuple[XiaoxinSnapshotData, float]:
    started_at = time.perf_counter()
    try:
        snapshot = await pull_xiaoxin_hr_snapshot()
    except ExternalDocumentFetchError as exc:
        elapsed_ms = round((time.perf_counter() - started_at) * 1000, 3)
        error_code = str(getattr(exc, "error_code", "xiaoxin_pull_failed"))
        set_span_attribute("knowledge.failure_stage", "pull")
        set_span_attribute("knowledge.error_code", error_code)
        set_span_attribute("knowledge.pull_elapsed_ms", elapsed_ms)
        logger.warning(
            "Xiaoxin HR snapshot pull failed",
            extra={
                "domain": XIAOXIN_HR_RESOURCE_ID,
                "failure_stage": "pull",
                "error_code": error_code,
                "pull_elapsed_ms": elapsed_ms,
            },
        )
        raise
    return snapshot, round((time.perf_counter() - started_at) * 1000, 3)


def _project_xiaoxin_with_observability(
    snapshot: XiaoxinSnapshotData,
) -> tuple[FAQProjection, float]:
    started_at = time.perf_counter()
    try:
        projection = project_xiaoxin_faq(snapshot)
    except Exception:
        elapsed_ms = round((time.perf_counter() - started_at) * 1000, 3)
        set_span_attribute("knowledge.failure_stage", "projection")
        set_span_attribute("knowledge.error_code", "xiaoxin_projection_failed")
        set_span_attribute("knowledge.projection_elapsed_ms", elapsed_ms)
        logger.exception(
            "Xiaoxin HR FAQ projection failed",
            extra={
                "domain": XIAOXIN_HR_RESOURCE_ID,
                "failure_stage": "projection",
                "error_code": "xiaoxin_projection_failed",
                "projection_elapsed_ms": elapsed_ms,
            },
        )
        raise
    return projection, round((time.perf_counter() - started_at) * 1000, 3)


def _record_projection_success(
    projection: FAQProjection,
    pull_elapsed_ms: float,
    projection_elapsed_ms: float,
    total_started_at: float,
) -> dict[str, int | float]:
    metrics = {
        "source_total": projection.source_total,
        "filtered_count": projection.filtered_count,
        "generated_qa_count": projection.generated_qa_count,
        "pull_elapsed_ms": pull_elapsed_ms,
        "projection_elapsed_ms": projection_elapsed_ms,
        "total_elapsed_ms": round((time.perf_counter() - total_started_at) * 1000, 3),
    }
    for key, value in metrics.items():
        set_span_attribute(f"knowledge.{key}", value)
    logger.info(
        "Xiaoxin HR snapshot projected",
        extra={"domain": XIAOXIN_HR_RESOURCE_ID, **metrics},
    )
    return metrics
