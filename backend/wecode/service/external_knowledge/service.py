# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Facade for external knowledge browse APIs."""

from sqlalchemy.orm import Session

from app.models.user import User
from wecode.config.external_knowledge_config import external_knowledge_settings
from wecode.schemas.external_knowledge import (
    ExternalKbNodesResponse,
    ExternalKnowledgeBaseListResponse,
    ExternalKnowledgeHealthResponse,
    ExternalPreviewResponse,
    ExternalSearchResult,
)
from wecode.service.erp_entity_resolver import (
    EmployeeIdResolutionStatus,
    ErpEntityResolver,
)
from wecode.service.external_knowledge import registry
from wecode.service.external_knowledge.base import ExternalKnowledgeProvider
from wecode.service.external_knowledge.exceptions import (
    ExternalKnowledgeEmployeeRequiredError,
    ExternalKnowledgeEmployeeResolutionUnavailableError,
    ExternalKnowledgeError,
    ExternalKnowledgeNotConfiguredError,
)


class ExternalKnowledgeService:
    """Coordinates provider dispatch, employee identity, and response mapping."""

    def __init__(self) -> None:
        self._erp_resolver = ErpEntityResolver()

    async def health(self, provider_name: str) -> ExternalKnowledgeHealthResponse:
        provider = registry.get(provider_name)
        configured = self._is_provider_configured(provider_name)
        ok = False
        message = getattr(provider, "unavailable_reason", None)
        if message is None and configured:
            ok = await provider.health()
        elif message is None and not configured:
            message = self._not_configured_message(provider_name)
        return ExternalKnowledgeHealthResponse(
            provider=provider_name,
            enabled=True,
            configured=configured,
            ok=ok,
            status="ok" if ok else "unavailable",
            message=None if ok else message,
        )

    async def list_knowledge_bases(
        self,
        db: Session,
        user: User,
        provider_name: str,
        *,
        scope: str,
        query: str | None,
        limit: int,
        offset: int,
    ) -> ExternalKnowledgeBaseListResponse:
        provider = self._get_ready_provider(provider_name)
        employee_id = self._get_employee_id(db, user)
        return await provider.list_knowledge_bases(
            employee_id,
            scope=scope,
            query=query,
            limit=limit,
            offset=offset,
        )

    async def list_nodes(
        self,
        db: Session,
        user: User,
        provider_name: str,
        *,
        kb_id: str,
        folder_id: str | None,
        recursive: bool,
        limit: int,
        offset: int,
    ) -> ExternalKbNodesResponse:
        provider = self._get_ready_provider(provider_name)
        employee_id = self._get_employee_id(db, user)
        return await provider.list_nodes(
            employee_id,
            kb_id=kb_id,
            folder_id=folder_id,
            recursive=recursive,
            limit=limit,
            offset=offset,
        )

    async def search(
        self,
        db: Session,
        user: User,
        provider_name: str,
        *,
        query: str,
        knowledge_base_ids: list[str],
        max_results: int,
    ) -> ExternalSearchResult:
        provider = self._get_ready_provider(provider_name)
        employee_id = self._get_employee_id(db, user)
        return await provider.search(
            employee_id,
            query=query,
            knowledge_base_ids=knowledge_base_ids,
            max_results=max_results,
        )

    async def preview(
        self,
        db: Session,
        user: User,
        provider_name: str,
        *,
        kb_id: str,
        node_id: str | None,
        document_id: str | None,
        folder_id: str | None,
    ) -> ExternalPreviewResponse:
        provider = self._get_ready_provider(provider_name)
        employee_id = self._get_employee_id(db, user)
        url = await provider.resolve_preview_url(
            employee_id,
            kb_id=kb_id,
            node_id=node_id,
            document_id=document_id,
            folder_id=folder_id,
        )
        preview = provider.build_preview(url)
        if preview is None:
            raise ExternalKnowledgeError(
                "Preview URL is unavailable for this document",
                code="not_found",
                status_code=404,
            )
        return preview

    def _get_employee_id(self, db: Session, user: User) -> str:
        result = self._erp_resolver.resolve_employee_id_result(db, user.id)
        if result.employee_id:
            return result.employee_id
        if result.status in {
            EmployeeIdResolutionStatus.IN_PROGRESS,
            EmployeeIdResolutionStatus.UNAVAILABLE,
        }:
            raise ExternalKnowledgeEmployeeResolutionUnavailableError()
        raise ExternalKnowledgeEmployeeRequiredError()

    def _get_ready_provider(self, provider_name: str) -> ExternalKnowledgeProvider:
        provider = registry.get(provider_name)
        unavailable_reason = getattr(provider, "unavailable_reason", None)
        if unavailable_reason:
            raise ExternalKnowledgeError(
                unavailable_reason,
                code="provider_unavailable",
                status_code=503,
            )
        self._ensure_provider_configured(provider_name)
        return provider

    def _ensure_provider_configured(self, provider_name: str) -> None:
        if not self._is_provider_configured(provider_name):
            raise ExternalKnowledgeNotConfiguredError(
                self._not_configured_message(provider_name)
            )

    @staticmethod
    def _is_provider_configured(provider_name: str) -> bool:
        if provider_name == "ap":
            return bool(external_knowledge_settings.AP_KNOWLEDGE_SYSTEM_TOKEN)
        return False

    @staticmethod
    def _not_configured_message(provider_name: str) -> str:
        if provider_name == "ap":
            return "AP knowledge system token is not configured"
        return f"External knowledge provider is not configured: {provider_name}"


external_knowledge_service = ExternalKnowledgeService()
