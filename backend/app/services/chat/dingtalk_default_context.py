# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve DingTalk default knowledge refs into task context refs."""

from typing import Any

from sqlalchemy.orm import Session

from app.models.dingtalk_doc import DingtalkSyncedNode
from app.models.user import User
from app.schemas.kind import DefaultContextRef
from app.services.dingtalk_doc_service import DingTalkDocService
from app.services.dingtalk_wikispace_service import DingTalkWikiSpaceService


class DingTalkDefaultContextResolver:
    """Build task-level context refs and warnings for DingTalk knowledge."""

    def __init__(self, db: Session):
        self.db = db

    def resolve(
        self,
        user: User,
        ref: DefaultContextRef,
        bound_at: str,
    ) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        if ref.type != "dingtalk_doc":
            return None, None

        if not self._is_mcp_configured(user, ref.source):
            return None, self._build_warning(
                ref,
                "mcp_not_configured",
                "未开启钉钉 MCP, 无法读取钉钉知识",
            )

        node = self._get_synced_node(user.id, ref)
        if node and not node.is_active:
            return None, self._build_warning(
                ref,
                "node_inactive",
                "该钉钉文档已失效或未同步, 无法读取",
            )

        data = {
            "provider": "dingtalk",
            "source": ref.source,
            "dingtalk_node_id": ref.dingtalk_node_id,
            "name": node.name if node else ref.name,
            "doc_url": node.doc_url if node else ref.doc_url,
            "node_type": node.node_type if node else ref.node_type,
            "boundBy": user.user_name,
            "boundAt": bound_at,
        }
        return {"type": "external_document", "data": data}, None

    def _get_synced_node(
        self, user_id: int, ref: DefaultContextRef
    ) -> DingtalkSyncedNode | None:
        return (
            self.db.query(DingtalkSyncedNode)
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

    @staticmethod
    def _build_warning(
        ref: DefaultContextRef,
        reason: str,
        message: str,
    ) -> dict[str, Any]:
        return {
            "type": "external_document",
            "reason": reason,
            "message": message,
            "name": ref.name,
            "provider": "dingtalk",
            "source": ref.source,
            "dingtalk_node_id": ref.dingtalk_node_id,
        }
