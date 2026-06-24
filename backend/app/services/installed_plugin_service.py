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
    PluginCatalogItem,
    PluginCatalogListResponse,
    PluginRuntime,
    PluginUploadInfo,
    SystemPlugin,
    SystemPluginListResponse,
)
from app.services.claude_plugin_parser import claude_plugin_parser


class InstalledPluginService:
    """Manage user-scoped Claude Code plugin installations."""

    REQUIRED_SYSTEM_PLUGIN_RUNTIMES: tuple[PluginRuntime, ...] = ("claudecode", "codex")

    def upload_system_plugin(
        self,
        *,
        db: Session,
        package_bytes: bytes,
        filename: str,
        enabled: bool = True,
        runtime: PluginRuntime = "claudecode",
    ) -> SystemPlugin:
        parsed = claude_plugin_parser.parse_package(package_bytes)
        file_hash = hashlib.sha256(package_bytes).hexdigest()
        existing = self._find_system_plugin(db, plugin_key=parsed.name, runtime=runtime)
        if existing:
            return self._replace_system_plugin(
                db,
                row=existing,
                parsed=parsed,
                package_bytes=package_bytes,
                file_hash=file_hash,
                filename=filename,
                enabled=enabled,
                runtime=runtime,
            )

        row = Kind(
            user_id=0,
            kind="Plugin",
            name=self._safe_kind_name(f"{parsed.name}-{runtime}"),
            namespace="default",
            json={},
            is_active=True,
        )
        db.add(row)
        db.flush()
        package_ref = self._package_ref(row.id, file_hash, len(package_bytes))
        row.json = self._build_payload(
            kind="Plugin",
            name=parsed.name,
            parsed=parsed,
            package_ref=package_ref,
            enabled=enabled,
            filename=filename,
            source_type="upload",
            runtime=runtime,
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
        return self._kind_to_system_plugin(row)

    def list_system_plugins(self, *, db: Session) -> SystemPluginListResponse:
        rows = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Plugin",
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .order_by(Kind.updated_at.desc())
            .all()
        )
        return SystemPluginListResponse(
            total=len(rows),
            items=[self._kind_to_system_plugin(row) for row in rows],
        )

    def list_system_plugin_catalog(
        self, *, db: Session, user_id: int
    ) -> PluginCatalogListResponse:
        system_rows = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Plugin",
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .order_by(Kind.updated_at.desc())
            .all()
        )
        installed_by_system_id = self._installed_plugins_by_system_id(
            db, user_id=user_id
        )
        grouped = self._group_system_plugin_rows(system_rows)
        items = []
        for variants in grouped.values():
            if not self._is_complete_enabled_variant_group(variants):
                continue
            items.append(
                self._system_group_to_catalog_item(variants, installed_by_system_id)
            )
        return PluginCatalogListResponse(items=items)

    def update_system_plugin_metadata(
        self,
        *,
        db: Session,
        system_plugin_id: int,
        display_name: Optional[str] = None,
        description: Optional[str] = None,
        enabled: Optional[bool] = None,
    ) -> SystemPlugin:
        row = self._get_active_system_plugin(db, system_plugin_id=system_plugin_id)
        plugin_key = self._plugin_key_from_row(row)
        rows = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Plugin",
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .all()
        )
        for candidate in rows:
            if self._plugin_key_from_row(candidate) != plugin_key:
                continue
            spec = self._get_spec(candidate)
            if display_name is not None:
                spec["displayName"] = display_name
            if description is not None:
                spec["description"] = description
            if enabled is not None:
                spec["enabled"] = enabled
            candidate.json["spec"] = spec
            flag_modified(candidate, "json")
        db.commit()
        db.refresh(row)
        return self._kind_to_system_plugin(row)

    def delete_system_plugin(self, *, db: Session, system_plugin_id: int) -> None:
        row = self._get_active_system_plugin(db, system_plugin_id=system_plugin_id)
        spec = self._get_spec(row)
        spec["enabled"] = False
        row.json["spec"] = spec
        row.is_active = False
        flag_modified(row, "json")
        db.commit()

    def replace_system_plugin_package(
        self,
        *,
        db: Session,
        system_plugin_id: int,
        package_bytes: bytes,
        filename: str,
    ) -> SystemPlugin:
        row = self._get_active_system_plugin(db, system_plugin_id=system_plugin_id)
        parsed = claude_plugin_parser.parse_package(package_bytes)
        current_spec = self._get_spec(row)
        current_plugin_key = current_spec.get("source", {}).get("pluginKey")
        runtime = self._runtime_from_spec(current_spec)
        if parsed.name != current_plugin_key:
            raise HTTPException(
                status_code=400,
                detail="Replacement plugin package must use the same plugin name",
            )
        file_hash = hashlib.sha256(package_bytes).hexdigest()
        return self._replace_system_plugin(
            db,
            row=row,
            parsed=parsed,
            package_bytes=package_bytes,
            file_hash=file_hash,
            filename=filename,
            enabled=current_spec.get("enabled", True),
            runtime=runtime,
            display_name=current_spec.get("displayName"),
            description=current_spec.get("description"),
        )

    def install_system_plugin(
        self, *, db: Session, user_id: int, system_plugin_id: int
    ) -> InstalledPluginListResponse:
        system_row = self._get_enabled_system_plugin(
            db, system_plugin_id=system_plugin_id
        )
        variants = self._complete_enabled_variants_for_row(db, system_row)
        installed_items = []
        for variant in self._ordered_variant_rows(variants):
            existing = self._find_installed_system_plugin(
                db, user_id=user_id, system_plugin_id=variant.id
            )
            if existing and existing.is_active:
                installed_items.append(self._kind_to_installed_plugin(existing))
                continue
            installed_items.append(
                self._copy_system_plugin_to_installed(
                    db,
                    user_id=user_id,
                    system_row=variant,
                    row=existing,
                )
            )
        return InstalledPluginListResponse(items=installed_items)

    def update_installed_plugin_from_system(
        self, *, db: Session, user_id: int, system_plugin_id: int
    ) -> InstalledPluginListResponse:
        system_row = self._get_enabled_system_plugin(
            db, system_plugin_id=system_plugin_id
        )
        variants = self._complete_enabled_variants_for_row(db, system_row)
        installed_items = []
        for variant in self._ordered_variant_rows(variants):
            installed = self._find_installed_system_plugin(
                db, user_id=user_id, system_plugin_id=variant.id
            )
            if not installed or not installed.is_active:
                installed = None
            installed_items.append(
                self._copy_system_plugin_to_installed(
                    db,
                    user_id=user_id,
                    system_row=variant,
                    row=installed,
                )
            )
        return InstalledPluginListResponse(items=installed_items)

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
            )

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
            kind="InstalledPlugin",
            name=parsed.name,
            parsed=parsed,
            package_ref=package_ref,
            enabled=enabled,
            filename=filename,
            source_type="upload",
            runtime="claudecode",
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
    ) -> InstalledPlugin:
        package_ref = self._package_ref(row.id, file_hash, len(package_bytes))
        row.json = self._build_payload(
            kind="InstalledPlugin",
            name=parsed.name,
            parsed=parsed,
            package_ref=package_ref,
            enabled=enabled,
            filename=filename,
            source_type="upload",
            runtime="claudecode",
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

    def _find_system_plugin(
        self, db: Session, *, plugin_key: str, runtime: PluginRuntime
    ) -> Optional[Kind]:
        rows = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Plugin",
                Kind.namespace == "default",
            )
            .all()
        )
        for row in rows:
            source = self._get_spec(row).get("source", {})
            if (
                isinstance(source, dict)
                and source.get("pluginKey") == plugin_key
                and self._runtime_from_spec(self._get_spec(row)) == runtime
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
        kind: str,
        name: str,
        parsed: PluginUploadInfo,
        package_ref: InstalledPluginPackageRef,
        enabled: bool,
        filename: str,
        source_type: str,
        runtime: PluginRuntime,
    ) -> Dict[str, Any]:
        provider_key = "codex" if runtime == "codex" else "claude-code"
        return {
            "apiVersion": "agent.wecode.io/v1",
            "kind": kind,
            "metadata": {
                "name": self._safe_kind_name(f"{name}-{runtime}"),
                "namespace": "default",
            },
            "spec": {
                "source": {
                    "type": source_type,
                    "providerKey": provider_key,
                    "pluginKey": name,
                    "runtime": runtime,
                },
                "runtime": runtime,
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

    def _replace_system_plugin(
        self,
        db: Session,
        *,
        row: Kind,
        parsed: PluginUploadInfo,
        package_bytes: bytes,
        file_hash: str,
        filename: str,
        enabled: bool,
        runtime: PluginRuntime,
        display_name: Optional[str] = None,
        description: Optional[str] = None,
    ) -> SystemPlugin:
        package_ref = self._package_ref(row.id, file_hash, len(package_bytes))
        row.json = self._build_payload(
            kind="Plugin",
            name=parsed.name,
            parsed=parsed,
            package_ref=package_ref,
            enabled=enabled,
            filename=filename,
            source_type="upload",
            runtime=runtime,
        )
        spec = self._get_spec(row)
        if display_name is not None:
            spec["displayName"] = display_name
        if description is not None:
            spec["description"] = description
        row.json["spec"] = spec
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
        return self._kind_to_system_plugin(row)

    def _get_active_system_plugin(self, db: Session, *, system_plugin_id: int) -> Kind:
        row = (
            db.query(Kind)
            .filter(
                Kind.id == system_plugin_id,
                Kind.user_id == 0,
                Kind.kind == "Plugin",
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .first()
        )
        if not row:
            raise HTTPException(status_code=404, detail="System plugin not found")
        return row

    def _get_enabled_system_plugin(self, db: Session, *, system_plugin_id: int) -> Kind:
        row = self._get_active_system_plugin(db, system_plugin_id=system_plugin_id)
        if not self._get_spec(row).get("enabled", True):
            raise HTTPException(status_code=404, detail="System plugin not found")
        return row

    def _complete_enabled_variants_for_row(
        self, db: Session, system_row: Kind
    ) -> dict[PluginRuntime, Kind]:
        plugin_key = self._plugin_key_from_row(system_row)
        rows = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Plugin",
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .all()
        )
        grouped = self._group_system_plugin_rows(rows)
        variants = grouped.get(plugin_key, {})
        if not self._is_complete_enabled_variant_group(variants):
            raise HTTPException(
                status_code=404,
                detail="System plugin must include enabled ClaudeCode and Codex packages",
            )
        return variants

    def _group_system_plugin_rows(
        self, rows: list[Kind]
    ) -> dict[str, dict[PluginRuntime, Kind]]:
        grouped: dict[str, dict[PluginRuntime, Kind]] = {}
        for row in rows:
            plugin_key = self._plugin_key_from_row(row)
            if not plugin_key:
                continue
            runtime = self._runtime_from_spec(self._get_spec(row))
            grouped.setdefault(plugin_key, {})[runtime] = row
        return grouped

    def _is_complete_enabled_variant_group(
        self, variants: dict[PluginRuntime, Kind]
    ) -> bool:
        for runtime in self.REQUIRED_SYSTEM_PLUGIN_RUNTIMES:
            row = variants.get(runtime)
            if not row or not self._get_spec(row).get("enabled", True):
                return False
        return True

    def _ordered_variant_rows(self, variants: dict[PluginRuntime, Kind]) -> list[Kind]:
        return [variants[runtime] for runtime in self.REQUIRED_SYSTEM_PLUGIN_RUNTIMES]

    def _plugin_key_from_row(self, row: Kind) -> str:
        spec = self._get_spec(row)
        source = spec.get("source") or {}
        if isinstance(source, dict):
            plugin_key = source.get("pluginKey")
            if isinstance(plugin_key, str) and plugin_key:
                return plugin_key
        return row.name

    def _runtime_from_spec(self, spec: dict[str, Any]) -> PluginRuntime:
        value = spec.get("runtime")
        if value not in self.REQUIRED_SYSTEM_PLUGIN_RUNTIMES:
            source = spec.get("source") or {}
            if isinstance(source, dict):
                value = source.get("runtime")
        return "codex" if value == "codex" else "claudecode"

    def _installed_plugins_by_system_id(
        self, db: Session, *, user_id: int
    ) -> dict[int, Kind]:
        rows = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "InstalledPlugin",
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .all()
        )
        result: dict[int, Kind] = {}
        for row in rows:
            source = self._get_spec(row).get("source", {})
            system_id = self._system_plugin_id_from_source(source)
            if system_id is not None:
                result[system_id] = row
        return result

    def _find_installed_system_plugin(
        self, db: Session, *, user_id: int, system_plugin_id: int
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
            if self._system_plugin_id_from_source(source) == system_plugin_id:
                return row
        return None

    def _system_plugin_id_from_source(self, source: Any) -> Optional[int]:
        if not isinstance(source, dict) or source.get("type") != "system":
            return None
        value = source.get("systemPluginId") or source.get("catalogItemId")
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return None
        return parsed if parsed > 0 else None

    def _system_group_to_catalog_item(
        self,
        variants: dict[PluginRuntime, Kind],
        installed_by_system_id: dict[int, Kind],
    ) -> PluginCatalogItem:
        primary = variants["claudecode"]
        spec = self._get_spec(primary)
        package_ref = spec.get("packageRef") or {}
        installed_by_runtime: dict[PluginRuntime, Kind] = {}
        for runtime, row in variants.items():
            installed = installed_by_system_id.get(row.id)
            if installed:
                installed_by_runtime[runtime] = installed
        installed = installed_by_runtime.get("claudecode")
        installed_spec = self._get_spec(installed) if installed else {}
        installed_ref = installed_spec.get("packageRef") or {}
        source_checksum = package_ref.get("checksum")
        installed_checksum = installed_ref.get("checksum")
        install_state = "not_installed"
        installed_id = None
        if installed_by_runtime:
            installed_id = installed.id
            install_state = "installed"
            for runtime, row in variants.items():
                variant_ref = self._get_spec(row).get("packageRef") or {}
                installed_row = installed_by_runtime.get(runtime)
                installed_ref = (
                    self._get_spec(installed_row).get("packageRef")
                    if installed_row
                    else {}
                ) or {}
                if not installed_row or variant_ref.get(
                    "checksum"
                ) != installed_ref.get("checksum"):
                    install_state = "update_available"
                    break
        return PluginCatalogItem(
            id=primary.id,
            name=spec.get("source", {}).get("pluginKey") or primary.name,
            displayName=spec.get("displayName") or primary.name,
            description=spec.get("description") or "",
            version=spec.get("version"),
            author=spec.get("author"),
            enabled=spec.get("enabled", True),
            installState=install_state,
            installedPluginId=installed_id,
            installedPluginIds={
                runtime: row.id for runtime, row in installed_by_runtime.items()
            },
            variantIds={runtime: row.id for runtime, row in variants.items()},
            sourceChecksum=source_checksum,
            installedChecksum=installed_checksum,
            components=spec.get("components") or {},
        )

    def _copy_system_plugin_to_installed(
        self,
        db: Session,
        *,
        user_id: int,
        system_row: Kind,
        row: Optional[Kind],
    ) -> InstalledPlugin:
        package = (
            db.query(SkillBinary).filter(SkillBinary.kind_id == system_row.id).first()
        )
        if not package or not package.binary_data:
            raise HTTPException(
                status_code=404, detail="System plugin package not found"
            )
        if row is None:
            row = Kind(
                user_id=user_id,
                kind="InstalledPlugin",
                name=system_row.name,
                namespace="default",
                json={},
                is_active=True,
            )
            db.add(row)
            db.flush()
        previous_spec = self._get_spec(row)
        row.json = self._installed_payload_from_system(
            row=row,
            system_row=system_row,
            package=package,
            enabled=previous_spec.get("enabled", True),
            component_states=previous_spec.get("componentStates"),
        )
        row.is_active = True
        flag_modified(row, "json")
        self._upsert_package(
            db,
            kind_id=row.id,
            package_bytes=package.binary_data,
            file_hash=package.file_hash,
            filename=package.file_name or f"{system_row.name}.zip",
        )
        db.commit()
        db.refresh(row)
        return self._kind_to_installed_plugin(row)

    def _installed_payload_from_system(
        self,
        *,
        row: Kind,
        system_row: Kind,
        package: SkillBinary,
        enabled: bool,
        component_states: Optional[Dict[str, bool]],
    ) -> Dict[str, Any]:
        payload = dict(system_row.json)
        payload["kind"] = "InstalledPlugin"
        metadata = dict(payload.get("metadata") or {})
        metadata["name"] = row.name
        metadata["namespace"] = "default"
        payload["metadata"] = metadata
        spec = dict(payload.get("spec") or {})
        source = dict(spec.get("source") or {})
        source.update(
            {
                "type": "system",
                "catalogItemId": str(system_row.id),
                "systemPluginId": system_row.id,
            }
        )
        spec["source"] = source
        spec["installState"] = "installed"
        spec["enabled"] = enabled
        if component_states:
            spec["componentStates"] = component_states
        spec["packageRef"] = self._package_ref(
            row.id,
            package.file_hash,
            package.file_size,
        ).model_dump()
        spec["sourcePayload"] = {
            "filename": package.file_name,
            "systemPluginId": system_row.id,
        }
        payload["spec"] = spec
        return payload

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

    def _kind_to_system_plugin(self, row: Kind) -> SystemPlugin:
        payload = dict(row.json)
        metadata = dict(payload.get("metadata", {}))
        labels = dict(metadata.get("labels", {}))
        labels["id"] = str(row.id)
        metadata["labels"] = labels
        payload["metadata"] = metadata
        return SystemPlugin.model_validate(payload)

    def _get_spec(self, row: Kind) -> Dict[str, Any]:
        payload = row.json if isinstance(row.json, dict) else {}
        spec = payload.get("spec", {})
        return spec if isinstance(spec, dict) else {}


installed_plugin_service = InstalledPluginService()
