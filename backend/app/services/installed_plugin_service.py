# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import hashlib
import re
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.schemas.installed_plugin import (
    InstalledPlugin,
    InstalledPluginListResponse,
    InstalledPluginPackageRef,
    InstalledPluginUpdateRequest,
    PluginUploadInfo,
)
from app.services.claude_plugin_parser import claude_plugin_parser

PLUGIN_PACKAGE_ROOT = Path("data/plugin_packages")


class InstalledPluginService:
    """Manage user-scoped Claude Code plugin installations."""

    def upload_plugin(
        self,
        *,
        db: Session,
        user_id: int,
        package_bytes: bytes,
        filename: str,
        enabled: bool = True,
    ) -> InstalledPlugin:
        parsed = claude_plugin_parser.parse_package(package_bytes)
        checksum = "sha256:" + hashlib.sha256(package_bytes).hexdigest()
        storage_key = self._store_package(user_id, parsed.name, package_bytes)
        package_ref = InstalledPluginPackageRef(
            storageKey=storage_key,
            checksum=checksum,
            sizeBytes=len(package_bytes),
        )
        existing = self._find_uploaded_plugin(
            db, user_id=user_id, plugin_key=parsed.name
        )
        if existing:
            return self._reactivate_existing(
                db,
                row=existing,
                parsed=parsed,
                package_ref=package_ref,
                enabled=enabled,
                filename=filename,
            )

        row = Kind(
            user_id=user_id,
            kind="InstalledPlugin",
            name=self._safe_kind_name(parsed.name),
            namespace="default",
            json=self._build_payload(
                name=parsed.name,
                parsed=parsed,
                package_ref=package_ref,
                enabled=enabled,
                filename=filename,
            ),
            is_active=True,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return self._kind_to_installed_plugin(row)

    def list_installed_plugins(
        self, *, db: Session, user_id: int
    ) -> InstalledPluginListResponse:
        rows = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "InstalledPlugin",
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .order_by(Kind.created_at.desc())
            .all()
        )
        return InstalledPluginListResponse(
            items=[self._kind_to_installed_plugin(row) for row in rows]
        )

    def update_installed_plugin(
        self,
        *,
        db: Session,
        user_id: int,
        installed_id: int,
        request: InstalledPluginUpdateRequest,
    ) -> InstalledPlugin:
        row = self._get_active_installed_plugin(
            db, user_id=user_id, installed_id=installed_id
        )
        spec = self._get_spec(row)
        if request.enabled is not None:
            spec["enabled"] = request.enabled
        if request.componentStates is not None:
            current_states = spec.get("componentStates") or {}
            if not isinstance(current_states, dict):
                current_states = {}
            current_states.update(request.componentStates)
            spec["componentStates"] = current_states
        if request.displayName is not None:
            spec["displayName"] = request.displayName
        if request.description is not None:
            spec["description"] = request.description
        row.json["spec"] = spec
        flag_modified(row, "json")
        db.commit()
        db.refresh(row)
        return self._kind_to_installed_plugin(row)

    def uninstall_installed_plugin(
        self,
        *,
        db: Session,
        user_id: int,
        installed_id: int,
    ) -> None:
        row = self._get_active_installed_plugin(
            db, user_id=user_id, installed_id=installed_id
        )
        spec = self._get_spec(row)
        spec["enabled"] = False
        spec["installState"] = "uninstalled"
        row.json["spec"] = spec
        row.is_active = False
        flag_modified(row, "json")
        db.commit()

    def package_path_for_download(
        self, *, db: Session, user_id: int, installed_id: int
    ) -> Path:
        row = self._get_active_installed_plugin(
            db, user_id=user_id, installed_id=installed_id
        )
        package_ref = self._get_spec(row).get("packageRef") or {}
        storage_key = package_ref.get("storageKey")
        if not isinstance(storage_key, str) or not storage_key:
            raise HTTPException(status_code=404, detail="Plugin package not found")
        path = PLUGIN_PACKAGE_ROOT / storage_key
        if not path.exists() or not path.is_file():
            raise HTTPException(status_code=404, detail="Plugin package not found")
        return path

    def _reactivate_existing(
        self,
        db: Session,
        *,
        row: Kind,
        parsed: PluginUploadInfo,
        package_ref: InstalledPluginPackageRef,
        enabled: bool,
        filename: str,
    ) -> InstalledPlugin:
        row.json = self._build_payload(
            name=parsed.name,
            parsed=parsed,
            package_ref=package_ref,
            enabled=enabled,
            filename=filename,
        )
        row.is_active = True
        flag_modified(row, "json")
        db.commit()
        db.refresh(row)
        return self._kind_to_installed_plugin(row)

    def _find_uploaded_plugin(
        self, db: Session, *, user_id: int, plugin_key: str
    ) -> Optional[Kind]:
        rows = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "InstalledPlugin",
                Kind.namespace == "default",
            )
            .all()
        )
        for row in rows:
            source = self._get_spec(row).get("source", {})
            if (
                isinstance(source, dict)
                and source.get("type") == "upload"
                and source.get("pluginKey") == plugin_key
            ):
                return row
        return None

    def _get_active_installed_plugin(
        self, db: Session, *, user_id: int, installed_id: int
    ) -> Kind:
        row = (
            db.query(Kind)
            .filter(
                Kind.id == installed_id,
                Kind.user_id == user_id,
                Kind.kind == "InstalledPlugin",
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .first()
        )
        if not row:
            raise HTTPException(status_code=404, detail="Installed plugin not found")
        return row

    def _build_payload(
        self,
        *,
        name: str,
        parsed: PluginUploadInfo,
        package_ref: InstalledPluginPackageRef,
        enabled: bool,
        filename: str,
    ) -> Dict[str, Any]:
        return {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "InstalledPlugin",
            "metadata": {"name": self._safe_kind_name(name), "namespace": "default"},
            "spec": {
                "source": {
                    "type": "upload",
                    "providerKey": "claude-code",
                    "pluginKey": name,
                },
                "displayName": parsed.displayName,
                "description": parsed.description,
                "version": parsed.version,
                "author": parsed.author,
                "installState": "installed",
                "enabled": enabled,
                "componentStates": self._default_component_states(parsed),
                "manifest": parsed.manifest,
                "components": parsed.components.model_dump(exclude_none=True),
                "packageRef": package_ref.model_dump(),
                "sourcePayload": {"filename": filename},
            },
            "status": {"state": "Available"},
        }

    def _default_component_states(self, parsed: PluginUploadInfo) -> Dict[str, bool]:
        components = parsed.components
        states: Dict[str, bool] = {}
        for skill in components.skills:
            states[f"skill:{skill.name}"] = True
        for command in components.commands:
            states[f"command:{command.name}"] = True
        for agent in components.agents:
            states[f"agent:{agent.name}"] = True
        for hook in components.hooks:
            states[f"hook:{hook.name}"] = True
        for mcp in components.mcps:
            states[f"mcp:{mcp.name}"] = True
        for lsp in components.lsps:
            states[f"lsp:{lsp.name}"] = True
        for monitor in components.monitors:
            states[f"monitor:{monitor.name}"] = True
        for binary in components.bins:
            states[f"bin:{binary.name}"] = True
        return states

    def _store_package(
        self, user_id: int, plugin_name: str, package_bytes: bytes
    ) -> str:
        safe_name = self._safe_kind_name(plugin_name)
        storage_key = f"user-{user_id}/{safe_name}-{uuid.uuid4().hex}.zip"
        path = PLUGIN_PACKAGE_ROOT / storage_key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(package_bytes)
        return storage_key

    def _safe_kind_name(self, value: str) -> str:
        cleaned = re.sub(r"[^a-zA-Z0-9_.-]+", "-", value.strip()).strip("-")
        return (cleaned or "plugin")[:100]

    def _kind_to_installed_plugin(self, row: Kind) -> InstalledPlugin:
        payload = dict(row.json)
        metadata = dict(payload.get("metadata", {}))
        labels = dict(metadata.get("labels", {}))
        labels["id"] = str(row.id)
        metadata["labels"] = labels
        payload["metadata"] = metadata
        return InstalledPlugin.model_validate(payload)

    def _get_spec(self, row: Kind) -> Dict[str, Any]:
        payload = row.json if isinstance(row.json, dict) else {}
        spec = payload.get("spec", {})
        return spec if isinstance(spec, dict) else {}


installed_plugin_service = InstalledPluginService()
