# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Single KB stat endpoints (KB viewers + admin access)."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember, ResourceType
from app.models.user import User
from app.schemas.base_role import BaseRole, has_permission
from app.services.kb_stat import get_kb_stat_gateway
from app.services.kb_stat.dependencies import require_kb_stat_enabled
from app.services.runtime_client import RemoteRuntimeError
from shared.models.kb_stat import (
    DashboardResponse,
    KbStatFilter,
    MetricBatchRequest,
    MetricBatchResponse,
    MetricListResponse,
    MetricResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(dependencies=[Depends(require_kb_stat_enabled)])


@router.post("/{kb_id}/stats/dashboard", response_model=DashboardResponse)
async def kb_dashboard(
    kb_id: int,
    payload: KbStatFilter,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    kb = _load_kb_or_404(db, kb_id)
    _ensure_can_view_kb_stat(db, kb, current_user)

    secured_payload = payload.model_copy(update={"kb_ids": [kb_id]})
    gateway = get_kb_stat_gateway()
    try:
        return await gateway.dashboard(secured_payload)
    except RemoteRuntimeError as e:
        _handle_remote_error(e)


@router.post("/{kb_id}/stats/metrics/batch", response_model=MetricBatchResponse)
async def kb_metric_batch(
    kb_id: int,
    payload: MetricBatchRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Batch-fetch many metrics for one KB (forces kb_ids to the path KB).

    Declared before the {name} route so "batch" matches this literal path
    instead of being captured as a metric name.
    """
    kb = _load_kb_or_404(db, kb_id)
    _ensure_can_view_kb_stat(db, kb, current_user)

    secured_payload = payload.model_copy(update={"kb_ids": [kb_id]})
    gateway = get_kb_stat_gateway()
    try:
        return await gateway.metric_batch(secured_payload)
    except RemoteRuntimeError as e:
        _handle_remote_error(e)


@router.post("/{kb_id}/stats/metrics/{name}", response_model=MetricResponse)
async def kb_metric(
    kb_id: int,
    name: str,
    payload: KbStatFilter,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    kb = _load_kb_or_404(db, kb_id)
    _ensure_can_view_kb_stat(db, kb, current_user)

    secured_payload = payload.model_copy(update={"kb_ids": [kb_id]})
    gateway = get_kb_stat_gateway()
    try:
        return await gateway.metric(name, secured_payload)
    except RemoteRuntimeError as e:
        if e.status_code == 404:
            raise HTTPException(404, f"unknown metric: {name}")
        _handle_remote_error(e)


@router.get("/{kb_id}/stats/metrics/list", response_model=MetricListResponse)
async def kb_list_metrics(
    kb_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    kb = _load_kb_or_404(db, kb_id)
    _ensure_can_view_kb_stat(db, kb, current_user)

    gateway = get_kb_stat_gateway()
    try:
        return await gateway.list_metrics(scope="kb")
    except RemoteRuntimeError as e:
        _handle_remote_error(e)


def _load_kb_or_404(db: Session, kb_id: int) -> Kind:
    kb = (
        db.query(Kind)
        .filter(
            Kind.kind == "KnowledgeBase",
            Kind.id == kb_id,
        )
        .first()
    )
    if not kb:
        raise HTTPException(404, f"Knowledge base {kb_id} not found")
    return kb


def _ensure_can_view_kb_stat(db: Session, kb: Kind, user: User) -> None:
    """Anyone who can view the KB can view its (read-only) stats.

    Permission aligns with KB view access rather than management: stats are a
    read-only view shown to every member who can see the KB. The previous
    check hardcoded a ``"manager"`` role that does not exist in
    :class:`BaseRole`, so shared-KB Maintainers/Developers were always 403.
    """
    if user.role == "admin":
        return
    if kb.user_id == user.id:
        return
    member = (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == ResourceType.KNOWLEDGE_BASE,
            ResourceMember.resource_id == kb.id,
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(user.id),
            ResourceMember.status == MemberStatus.APPROVED,
        )
        .first()
    )
    # Reuse the unified role hierarchy: any approved member (Reporter and
    # above) may view stats. Never hardcode role strings — use the enum.
    if member and has_permission(member.role, BaseRole.Reporter):
        return
    raise HTTPException(403, "You do not have permission to view this KB's stats")


def _handle_remote_error(e: RemoteRuntimeError) -> None:
    # Never echo raw ``str(e)`` to the client: transport errors carry the
    # upstream host/URL (httpx RequestError), and unparsed responses may
    # contain stack traces or internal paths. Log the full detail server-
    # side; return only the structured code plus a fixed user-facing msg.
    if e.retryable:
        logger.warning("knowledge_runtime transport error: %s", e)
        raise HTTPException(
            502,
            {"code": e.code, "message": "统计数据服务暂时不可达，请稍后重试"},
        )
    if e.status_code:
        logger.warning("knowledge_runtime error (status=%s): %s", e.status_code, e)
        raise HTTPException(
            e.status_code, {"code": e.code, "message": "统计数据查询失败"}
        )
    logger.warning("knowledge_runtime error: %s", e)
    raise HTTPException(502, {"code": e.code, "message": "统计数据查询失败"})
