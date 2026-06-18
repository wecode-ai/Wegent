# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk external knowledge provider."""

from typing import Any

from pydantic import TypeAdapter, ValidationError
from sqlalchemy.orm import Session

from app.models.dingtalk_doc import DingtalkSyncedNode
from app.models.user import User
from app.schemas.kind import DefaultContextRef
from app.services.dingtalk_doc_service import DingTalkDocService
from app.services.dingtalk_wikispace_service import DingTalkWikiSpaceService
from app.services.external_knowledge.base import ResolvedExternalKnowledge

DEFAULT_CONTEXT_REF_ADAPTER = TypeAdapter(DefaultContextRef)


class DingTalkExternalKnowledgeProvider:
    """Build task-level context refs and warnings for DingTalk knowledge."""

    provider = "dingtalk"

    def supports(self, ref: DefaultContextRef) -> bool:
        return ref.type == "dingtalk_doc"

    def context_item_to_default_ref(
        self, raw: dict[str, Any]
    ) -> DefaultContextRef | None:
        context_type = raw.get("type")
        if context_type not in {"dingtalk_doc", "external_document"}:
            return None

        data = raw.get("data") or {}
        if data.get("provider") not in {None, self.provider}:
            return None

        source = data.get("source")
        node_id = data.get("dingtalk_node_id")
        if source not in {"docs", "wikispace"} or not node_id:
            return None

        try:
            return DEFAULT_CONTEXT_REF_ADAPTER.validate_python(
                {
                    "type": "dingtalk_doc",
                    "source": source,
                    "id": data.get("id") or f"{source}:{node_id}",
                    "dingtalk_node_id": node_id,
                    "name": data.get("name") or node_id,
                    "doc_url": data.get("doc_url") or "",
                    "node_type": data.get("node_type") or "doc",
                }
            )
        except (TypeError, ValueError, ValidationError):
            return None

    def resolve(
        self,
        db: Session,
        user: User,
        ref: DefaultContextRef,
        bound_at: str,
    ) -> ResolvedExternalKnowledge:
        if not self.supports(ref):
            return ResolvedExternalKnowledge()

        if not self._is_mcp_configured(user, ref.source):
            return ResolvedExternalKnowledge(
                warning=self._build_warning(
                    ref,
                    "mcp_not_configured",
                    "未开启钉钉 MCP, 无法读取钉钉知识",
                )
            )

        node = self._get_synced_node(db, user.id, ref)
        if node and not node.is_active:
            return ResolvedExternalKnowledge(
                warning=self._build_warning(
                    ref,
                    "node_inactive",
                    "该钉钉文档已失效或未同步, 无法读取",
                )
            )

        data = {
            "provider": self.provider,
            "source": ref.source,
            "dingtalk_node_id": ref.dingtalk_node_id,
            "name": node.name if node else ref.name,
            "doc_url": node.doc_url if node else ref.doc_url,
            "node_type": node.node_type if node else ref.node_type,
            "boundBy": user.user_name,
            "boundAt": bound_at,
        }
        return ResolvedExternalKnowledge(
            context_ref={"type": "external_document", "data": data}
        )

    @staticmethod
    def _get_synced_node(
        db: Session, user_id: int, ref: DefaultContextRef
    ) -> DingtalkSyncedNode | None:
        return (
            db.query(DingtalkSyncedNode)
            .filter(
                DingtalkSyncedNode.user_id == user_id,
                DingtalkSyncedNode.dingtalk_node_id == ref.dingtalk_node_id,
                DingtalkSyncedNode.source == ref.source,
            )
            .first()
        )

    @staticmethod
    def _is_mcp_configured(user: User, source: str) -> bool:
        if source == "docs":
            return DingTalkDocService.is_configured(user)
        if source == "wikispace":
            return DingTalkWikiSpaceService.is_configured(user)
        return False

    def _build_warning(
        self,
        ref: DefaultContextRef,
        reason: str,
        message: str,
    ) -> dict[str, Any]:
        return {
            "type": "external_document",
            "reason": reason,
            "message": message,
            "name": ref.name,
            "provider": self.provider,
            "source": ref.source,
            "dingtalk_node_id": ref.dingtalk_node_id,
        }
