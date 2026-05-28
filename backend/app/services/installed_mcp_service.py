# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.schemas.installed_mcp import (
    InstalledMCP,
    InstalledMCPCustomCreateRequest,
    InstalledMCPInstallRequest,
    InstalledMCPListResponse,
    InstalledMCPServerConfig,
    InstalledMCPUpdateRequest,
    MCPInstallCatalogItem,
)

InstalledMCPStateMap = Dict[Tuple[str, str], Tuple[int, Dict[str, Any]]]
logger = logging.getLogger(__name__)


class InstalledMCPService:
    """Manage user-scoped MCP installations in the kinds table."""

    def create_custom_mcp(
        self,
        *,
        db: Session,
        user_id: int,
        request: InstalledMCPCustomCreateRequest,
    ) -> InstalledMCP:
        existing = self._find_custom_mcp(db, user_id=user_id, name=request.name)
        if existing:
            logger.info(
                "Reactivating custom InstalledMCP: user_id=%s installed_id=%s name=%s",
                user_id,
                existing.id,
                existing.name,
            )
            return self._reactivate_existing(
                db,
                row=existing,
                display_name=request.displayName,
                description=request.description,
                server=request.server,
                enabled=request.enabled,
            )

        row = Kind(
            user_id=user_id,
            kind="InstalledMCP",
            name=request.name[:100],
            namespace="default",
            json=self._build_payload(
                name=request.name,
                source={
                    "type": "custom",
                    "serverKey": request.name,
                },
                display_name=request.displayName,
                description=request.description,
                server=request.server,
                enabled=request.enabled,
            ),
            is_active=True,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return self._kind_to_installed_mcp(row)

    def install_provider_mcp(
        self,
        *,
        db: Session,
        user_id: int,
        request: InstalledMCPInstallRequest,
    ) -> InstalledMCP:
        existing = self._find_provider_mcp(
            db,
            user_id=user_id,
            provider_key=request.providerKey,
            server_key=request.serverKey,
        )
        if existing:
            logger.info(
                "Reactivating provider InstalledMCP: user_id=%s installed_id=%s name=%s provider=%s server=%s",
                user_id,
                existing.id,
                existing.name,
                request.providerKey,
                request.serverKey,
            )
            return self._reactivate_existing(
                db,
                row=existing,
                display_name=request.displayName,
                description=request.description,
                server=request.server,
                enabled=True,
                source_payload=request.sourcePayload,
            )

        name = f"{request.providerKey}-{request.serverKey}"[:100]
        row = Kind(
            user_id=user_id,
            kind="InstalledMCP",
            name=name,
            namespace="default",
            json=self._build_payload(
                name=name,
                source={
                    "type": "provider",
                    "providerKey": request.providerKey,
                    "serverKey": request.serverKey,
                    "catalogItemId": request.catalogItemId,
                },
                display_name=request.displayName,
                description=request.description,
                server=request.server,
                enabled=True,
                source_payload=request.sourcePayload,
            ),
            is_active=True,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return self._kind_to_installed_mcp(row)

    def list_installed_mcps(
        self, *, db: Session, user_id: int
    ) -> InstalledMCPListResponse:
        rows = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "InstalledMCP",
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .order_by(Kind.created_at.desc())
            .all()
        )
        return InstalledMCPListResponse(
            items=[self._kind_to_installed_mcp(row) for row in rows]
        )

    def update_installed_mcp(
        self,
        *,
        db: Session,
        user_id: int,
        installed_id: int,
        request: InstalledMCPUpdateRequest,
    ) -> InstalledMCP:
        row = self._get_active_installed_mcp(
            db, user_id=user_id, installed_id=installed_id
        )
        spec = self._get_spec(row)
        logger.info(
            "Updating InstalledMCP row: user_id=%s installed_id=%s name=%s old_enabled=%s old_state=%s new_enabled=%s",
            user_id,
            row.id,
            row.name,
            spec.get("enabled"),
            spec.get("installState"),
            request.enabled,
        )

        if request.enabled is not None:
            spec["enabled"] = request.enabled
        if request.displayName is not None:
            spec["displayName"] = request.displayName
        if request.description is not None:
            spec["description"] = request.description
        if request.server is not None:
            spec["server"] = request.server.model_dump(exclude_none=True)

        row.json["spec"] = spec
        flag_modified(row, "json")
        db.commit()
        db.refresh(row)
        return self._kind_to_installed_mcp(row)

    def uninstall_installed_mcp(
        self,
        *,
        db: Session,
        user_id: int,
        installed_id: int,
    ) -> None:
        row = self._get_active_installed_mcp(
            db, user_id=user_id, installed_id=installed_id
        )
        spec = self._get_spec(row)
        logger.info(
            "Uninstalling InstalledMCP row: user_id=%s installed_id=%s name=%s old_enabled=%s old_state=%s old_active=%s",
            user_id,
            row.id,
            row.name,
            spec.get("enabled"),
            spec.get("installState"),
            row.is_active,
        )
        spec["enabled"] = False
        spec["installState"] = "uninstalled"
        row.json["spec"] = spec
        row.is_active = False
        flag_modified(row, "json")
        db.commit()
        logger.info(
            "InstalledMCP row uninstalled: user_id=%s installed_id=%s name=%s active=%s",
            user_id,
            row.id,
            row.name,
            row.is_active,
        )

    def merge_catalog_state(
        self,
        *,
        db: Session,
        user_id: int,
        items: List[MCPInstallCatalogItem],
    ) -> List[MCPInstallCatalogItem]:
        installed_state = self._load_provider_installed_state(db, user_id)
        merged = []
        for item in items:
            installed = installed_state.get((item.providerKey, item.serverKey))
            if not installed:
                merged.append(
                    item.model_copy(
                        update={
                            "installState": "not_installed",
                            "installedMcpId": None,
                            "enabled": False,
                        }
                    )
                )
                continue

            installed_id, spec = installed
            merged.append(
                item.model_copy(
                    update={
                        "installState": spec.get("installState", "installed"),
                        "installedMcpId": installed_id,
                        "enabled": bool(spec.get("enabled", False)),
                    }
                )
            )
        return merged

    def _reactivate_existing(
        self,
        db: Session,
        *,
        row: Kind,
        display_name: str,
        description: str,
        server: InstalledMCPServerConfig,
        enabled: bool,
        source_payload: Optional[Dict[str, Any]] = None,
    ) -> InstalledMCP:
        spec = self._get_spec(row)
        spec["displayName"] = display_name
        spec["description"] = description
        spec["server"] = server.model_dump(exclude_none=True)
        spec["installState"] = "installed"
        spec["enabled"] = enabled
        if source_payload is not None:
            spec["sourcePayload"] = source_payload
        row.json["spec"] = spec
        row.is_active = True
        flag_modified(row, "json")
        db.commit()
        db.refresh(row)
        return self._kind_to_installed_mcp(row)

    def _find_custom_mcp(
        self, db: Session, *, user_id: int, name: str
    ) -> Optional[Kind]:
        return (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "InstalledMCP",
                Kind.namespace == "default",
                Kind.name == name,
            )
            .first()
        )

    def _find_provider_mcp(
        self,
        db: Session,
        *,
        user_id: int,
        provider_key: str,
        server_key: str,
    ) -> Optional[Kind]:
        rows = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "InstalledMCP",
                Kind.namespace == "default",
            )
            .all()
        )
        for row in rows:
            source = self._get_spec(row).get("source", {})
            if (
                isinstance(source, dict)
                and source.get("type") == "provider"
                and source.get("providerKey") == provider_key
                and source.get("serverKey") == server_key
            ):
                return row
        return None

    def _get_active_installed_mcp(
        self, db: Session, *, user_id: int, installed_id: int
    ) -> Kind:
        row = (
            db.query(Kind)
            .filter(
                Kind.id == installed_id,
                Kind.user_id == user_id,
                Kind.kind == "InstalledMCP",
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .first()
        )
        if not row:
            raise HTTPException(status_code=404, detail="Installed MCP not found")
        return row

    def _load_provider_installed_state(
        self, db: Session, user_id: int
    ) -> InstalledMCPStateMap:
        rows = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "InstalledMCP",
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .all()
        )

        installed_state: InstalledMCPStateMap = {}
        for row in rows:
            spec = self._get_spec(row)
            source = spec.get("source", {})
            if not isinstance(source, dict) or source.get("type") != "provider":
                continue
            provider_key = source.get("providerKey")
            server_key = source.get("serverKey")
            if isinstance(provider_key, str) and isinstance(server_key, str):
                installed_state[(provider_key, server_key)] = (row.id, spec)
        return installed_state

    def _build_payload(
        self,
        *,
        name: str,
        source: Dict[str, Any],
        display_name: str,
        description: str,
        server: InstalledMCPServerConfig,
        enabled: bool,
        source_payload: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        spec = {
            "source": source,
            "displayName": display_name,
            "description": description,
            "server": server.model_dump(exclude_none=True),
            "installState": "installed",
            "enabled": enabled,
        }
        if source_payload is not None:
            spec["sourcePayload"] = source_payload
        return {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "InstalledMCP",
            "metadata": {"name": name[:100], "namespace": "default"},
            "spec": spec,
            "status": {"state": "Available"},
        }

    def _kind_to_installed_mcp(self, row: Kind) -> InstalledMCP:
        payload = dict(row.json)
        metadata = dict(payload.get("metadata", {}))
        labels = dict(metadata.get("labels", {}))
        labels["id"] = str(row.id)
        metadata["labels"] = labels
        payload["metadata"] = metadata
        return InstalledMCP.model_validate(payload)

    def _get_spec(self, row: Kind) -> Dict[str, Any]:
        payload = row.json if isinstance(row.json, dict) else {}
        spec = payload.get("spec", {})
        return spec if isinstance(spec, dict) else {}


installed_mcp_service = InstalledMCPService()
