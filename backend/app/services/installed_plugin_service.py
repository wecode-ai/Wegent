# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import hashlib
import re
from typing import Any, Dict, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.skill_binary import SkillBinary
from app.schemas.installed_plugin import (
    InstalledPlugin,
    InstalledPluginListResponse,
    InstalledPluginPackageRef,
    InstalledPluginUpdateRequest,
    PluginMarketplaceItem,
    PluginMarketplaceListResponse,
    PluginUploadInfo,
)
from app.services.claude_plugin_parser import claude_plugin_parser


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
        file_hash = hashlib.sha256(package_bytes).hexdigest()
        existing = self._find_uploaded_plugin(
            db, user_id=user_id, plugin_key=parsed.name
        )
        if existing:
            return self._reactivate_existing(
                db,
                row=existing,
                parsed=parsed,
                package_bytes=package_bytes,
                file_hash=file_hash,
                enabled=enabled,
                filename=filename,
                source_type="upload",
                provider_key="codex-local",
                marketplace_id=None,
            )

        return self._create_installed_plugin(
            db=db,
            user_id=user_id,
            parsed=parsed,
            package_bytes=package_bytes,
            file_hash=file_hash,
            filename=filename,
            enabled=enabled,
            source_type="upload",
            provider_key="codex-local",
            marketplace_id=None,
        )

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

    def package_data_for_download(
        self, *, db: Session, user_id: int, installed_id: int
    ) -> tuple[bytes, str]:
        row = self._get_active_installed_plugin(
            db, user_id=user_id, installed_id=installed_id
        )
        package = db.query(SkillBinary).filter(SkillBinary.kind_id == row.id).first()
        if not package or not package.binary_data:
            raise HTTPException(status_code=404, detail="Plugin package not found")
        return package.binary_data, package.file_name or self._fallback_filename(row)

    def publish_marketplace_plugin(
        self,
        *,
        db: Session,
        user_id: int,
        package_bytes: bytes,
        filename: str,
        visibility: str = "workspace",
        featured: bool = False,
    ) -> PluginMarketplaceItem:
        parsed = claude_plugin_parser.parse_package(package_bytes)
        file_hash = hashlib.sha256(package_bytes).hexdigest()
        row = self._find_marketplace_item(db, user_id=user_id, plugin_key=parsed.name)

        if not row:
            row = Kind(
                user_id=user_id,
                kind="PluginMarketplaceItem",
                name=self._safe_kind_name(parsed.name),
                namespace="default",
                json={},
                is_active=True,
            )
            db.add(row)
            db.flush()

        package_ref = self._package_ref(row.id, file_hash, len(package_bytes))
        row.json = self._build_marketplace_payload(
            row_id=row.id,
            parsed=parsed,
            package_ref=package_ref,
            filename=filename,
            user_id=user_id,
            visibility=visibility,
            featured=featured,
        )
        row.is_active = True
        flag_modified(row, "json")
        self._upsert_package(
            db,
            kind_id=row.id,
            package_bytes=package_bytes,
            file_hash=file_hash,
            filename=filename,
        )
        db.commit()
        db.refresh(row)
        return self._marketplace_row_to_item(db, row, user_id=user_id)

    def list_marketplace_plugins(
        self,
        *,
        db: Session,
        user_id: int,
        query: str | None = None,
        source: str | None = None,
    ) -> PluginMarketplaceListResponse:
        rows = (
            db.query(Kind)
            .filter(
                Kind.kind == "PluginMarketplaceItem",
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .order_by(Kind.created_at.desc())
            .all()
        )
        items = [
            self._marketplace_row_to_item(db, row, user_id=user_id)
            for row in rows
            if self._can_view_marketplace_row(row, user_id=user_id)
        ]
        if source == "created":
            items = [item for item in items if item.ownerUserId == user_id]
        elif source == "featured":
            items = [item for item in items if item.featured]
        elif source == "workspace":
            items = [item for item in items if item.visibility == "workspace"]
        elif source == "personal":
            items = [item for item in items if item.visibility == "personal"]

        normalized_query = (query or "").strip().lower()
        if normalized_query:
            items = [
                item
                for item in items
                if normalized_query in item.name.lower()
                or normalized_query in item.displayName.lower()
                or normalized_query in item.description.lower()
                or any(
                    normalized_query in str(keyword).lower()
                    for keyword in item.manifest.get("keywords", [])
                )
            ]

        return PluginMarketplaceListResponse(items=items)

    def install_marketplace_plugin(
        self,
        *,
        db: Session,
        user_id: int,
        marketplace_id: int,
        enabled: bool = True,
    ) -> InstalledPlugin:
        row = (
            db.query(Kind)
            .filter(
                Kind.id == marketplace_id,
                Kind.kind == "PluginMarketplaceItem",
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .first()
        )
        if not row or not self._can_view_marketplace_row(row, user_id=user_id):
            raise HTTPException(status_code=404, detail="Marketplace plugin not found")

        package = db.query(SkillBinary).filter(SkillBinary.kind_id == row.id).first()
        if not package or not package.binary_data:
            raise HTTPException(
                status_code=404, detail="Marketplace plugin package not found"
            )

        parsed = claude_plugin_parser.parse_package(package.binary_data)
        file_hash = hashlib.sha256(package.binary_data).hexdigest()
        existing = self._find_installed_plugin(
            db,
            user_id=user_id,
            source_type="marketplace",
            plugin_key=parsed.name,
            marketplace_id=marketplace_id,
        )
        if existing:
            return self._reactivate_existing(
                db,
                row=existing,
                parsed=parsed,
                package_bytes=package.binary_data,
                file_hash=file_hash,
                enabled=enabled,
                filename=package.file_name or f"{parsed.name}.zip",
                source_type="marketplace",
                provider_key="wegent-marketplace",
                marketplace_id=marketplace_id,
            )

        return self._create_installed_plugin(
            db=db,
            user_id=user_id,
            parsed=parsed,
            package_bytes=package.binary_data,
            file_hash=file_hash,
            filename=package.file_name or f"{parsed.name}.zip",
            enabled=enabled,
            source_type="marketplace",
            provider_key="wegent-marketplace",
            marketplace_id=marketplace_id,
        )

    def _reactivate_existing(
        self,
        db: Session,
        *,
        row: Kind,
        parsed: PluginUploadInfo,
        package_bytes: bytes,
        file_hash: str,
        enabled: bool,
        filename: str,
        source_type: str = "upload",
        provider_key: str = "codex-local",
        marketplace_id: int | None = None,
    ) -> InstalledPlugin:
        package_ref = self._package_ref(row.id, file_hash, len(package_bytes))
        row.json = self._build_payload(
            name=parsed.name,
            parsed=parsed,
            package_ref=package_ref,
            enabled=enabled,
            filename=filename,
            source_type=source_type,
            provider_key=provider_key,
            marketplace_id=marketplace_id,
        )
        row.is_active = True
        flag_modified(row, "json")
        self._upsert_package(
            db,
            kind_id=row.id,
            package_bytes=package_bytes,
            file_hash=file_hash,
            filename=filename,
        )
        db.commit()
        db.refresh(row)
        return self._kind_to_installed_plugin(row)

    def _create_installed_plugin(
        self,
        *,
        db: Session,
        user_id: int,
        parsed: PluginUploadInfo,
        package_bytes: bytes,
        file_hash: str,
        filename: str,
        enabled: bool,
        source_type: str,
        provider_key: str,
        marketplace_id: int | None,
    ) -> InstalledPlugin:
        row = Kind(
            user_id=user_id,
            kind="InstalledPlugin",
            name=self._safe_kind_name(parsed.name),
            namespace="default",
            json={},
            is_active=True,
        )
        db.add(row)
        db.flush()
        package_ref = self._package_ref(row.id, file_hash, len(package_bytes))
        row.json = self._build_payload(
            name=parsed.name,
            parsed=parsed,
            package_ref=package_ref,
            enabled=enabled,
            filename=filename,
            source_type=source_type,
            provider_key=provider_key,
            marketplace_id=marketplace_id,
        )
        self._upsert_package(
            db,
            kind_id=row.id,
            package_bytes=package_bytes,
            file_hash=file_hash,
            filename=filename,
        )
        db.commit()
        db.refresh(row)
        return self._kind_to_installed_plugin(row)

    def _find_uploaded_plugin(
        self, db: Session, *, user_id: int, plugin_key: str
    ) -> Optional[Kind]:
        return self._find_installed_plugin(
            db,
            user_id=user_id,
            source_type="upload",
            plugin_key=plugin_key,
            marketplace_id=None,
        )

    def _find_installed_plugin(
        self,
        db: Session,
        *,
        user_id: int,
        source_type: str,
        plugin_key: str,
        marketplace_id: int | None,
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
                and source.get("type") == source_type
                and source.get("pluginKey") == plugin_key
                and (
                    marketplace_id is None
                    or source.get("catalogItemId") == str(marketplace_id)
                )
            ):
                return row
        return None

    def _find_marketplace_item(
        self, db: Session, *, user_id: int, plugin_key: str
    ) -> Optional[Kind]:
        rows = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "PluginMarketplaceItem",
                Kind.namespace == "default",
            )
            .all()
        )
        for row in rows:
            if self._get_spec(row).get("name") == plugin_key:
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
        source_type: str = "upload",
        provider_key: str = "codex-local",
        marketplace_id: int | None = None,
    ) -> Dict[str, Any]:
        source = {
            "type": source_type,
            "providerKey": provider_key,
            "pluginKey": name,
        }
        if marketplace_id is not None:
            source["catalogItemId"] = str(marketplace_id)
            source["marketplace"] = "wegent"

        return {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "InstalledPlugin",
            "metadata": {"name": self._safe_kind_name(name), "namespace": "default"},
            "spec": {
                "source": source,
                "displayName": parsed.displayName,
                "description": parsed.description,
                "version": parsed.version,
                "author": parsed.author,
                "installState": "installed",
                "enabled": enabled,
                "componentStates": self._default_component_states(parsed),
                "manifest": parsed.manifest,
                "components": parsed.components.model_dump(exclude_none=True),
                "interface": (
                    parsed.interface.model_dump(exclude_none=True)
                    if parsed.interface
                    else None
                ),
                "packageRef": package_ref.model_dump(),
                "sourcePayload": {"filename": filename},
            },
            "status": {"state": "Available"},
        }

    def _build_marketplace_payload(
        self,
        *,
        row_id: int,
        parsed: PluginUploadInfo,
        package_ref: InstalledPluginPackageRef,
        filename: str,
        user_id: int,
        visibility: str,
        featured: bool,
    ) -> Dict[str, Any]:
        return {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "PluginMarketplaceItem",
            "metadata": {
                "name": self._safe_kind_name(parsed.name),
                "namespace": "default",
            },
            "spec": {
                "id": row_id,
                "remotePluginId": f"wegent~Plugin_{row_id}",
                "name": parsed.name,
                "displayName": parsed.displayName,
                "description": parsed.description,
                "version": parsed.version,
                "author": parsed.author,
                "visibility": visibility,
                "featured": featured,
                "manifest": parsed.manifest,
                "components": parsed.components.model_dump(exclude_none=True),
                "interface": (
                    parsed.interface.model_dump(exclude_none=True)
                    if parsed.interface
                    else None
                ),
                "packageRef": package_ref.model_dump(),
                "sourcePayload": {"filename": filename},
                "ownerUserId": user_id,
            },
            "status": {"state": "Available"},
        }

    def _can_view_marketplace_row(self, row: Kind, *, user_id: int) -> bool:
        spec = self._get_spec(row)
        visibility = spec.get("visibility", "workspace")
        return row.user_id == user_id or visibility in {"workspace", "public"}

    def _marketplace_row_to_item(
        self, db: Session, row: Kind, *, user_id: int
    ) -> PluginMarketplaceItem:
        spec = self._get_spec(row)
        installed = self._find_installed_plugin(
            db,
            user_id=user_id,
            source_type="marketplace",
            plugin_key=str(spec.get("name") or ""),
            marketplace_id=row.id,
        )
        installed_spec = self._get_spec(installed) if installed else {}
        return PluginMarketplaceItem(
            id=row.id,
            remotePluginId=str(spec.get("remotePluginId") or f"wegent~Plugin_{row.id}"),
            name=str(spec.get("name") or row.name),
            displayName=str(spec.get("displayName") or spec.get("name") or row.name),
            description=str(spec.get("description") or ""),
            version=spec.get("version"),
            author=spec.get("author"),
            visibility=spec.get("visibility", "workspace"),
            featured=bool(spec.get("featured")),
            installed=installed is not None and installed.is_active,
            installedPluginId=installed.id if installed else None,
            enabled=bool(installed_spec.get("enabled")) if installed else False,
            interface=spec.get("interface"),
            components=spec.get("components") or {},
            manifest=spec.get("manifest") or {},
            ownerUserId=int(spec.get("ownerUserId") or row.user_id),
        )

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

    def _package_ref(
        self, kind_id: int, file_hash: str, size_bytes: int
    ) -> InstalledPluginPackageRef:
        return InstalledPluginPackageRef(
            storageKey=f"skill-binaries/{kind_id}",
            checksum=f"sha256:{file_hash}",
            sizeBytes=size_bytes,
        )

    def _upsert_package(
        self,
        db: Session,
        *,
        kind_id: int,
        package_bytes: bytes,
        file_hash: str,
        filename: str,
    ) -> None:
        package = db.query(SkillBinary).filter(SkillBinary.kind_id == kind_id).first()
        if package:
            package.binary_data = package_bytes
            package.file_size = len(package_bytes)
            package.file_hash = file_hash
            package.file_name = filename
            package.type = "plugin"
            return

        db.add(
            SkillBinary(
                kind_id=kind_id,
                binary_data=package_bytes,
                file_size=len(package_bytes),
                file_hash=file_hash,
                file_name=filename,
                type="plugin",
            )
        )

    def _fallback_filename(self, row: Kind) -> str:
        spec = self._get_spec(row)
        source_payload = spec.get("sourcePayload") or {}
        if isinstance(source_payload, dict):
            filename = source_payload.get("filename")
            if isinstance(filename, str) and filename:
                return filename
        return f"{row.name}.zip"

    def _safe_kind_name(self, value: str) -> str:
        cleaned = re.sub(r"[^a-zA-Z0-9_.-]+", "-", value.strip()).strip("-")
        digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:10]
        suffix = f"-{digest}"
        max_base_length = 100 - len(suffix)
        base = (cleaned or "plugin")[:max_base_length].rstrip("-") or "plugin"
        return f"{base}{suffix}"

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
