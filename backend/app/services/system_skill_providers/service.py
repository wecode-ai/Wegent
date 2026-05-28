# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io
import logging
import zipfile
from typing import Any, Dict, List, Optional, Tuple

import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.schemas.system_skills import (
    InstalledSkill,
    InstalledSkillListResponse,
    InstalledSkillRef,
    InstalledSkillSource,
    InstalledSkillSpec,
    SystemSkillCatalogItem,
    SystemSkillInstallRequest,
    SystemSkillListResponse,
    SystemSkillProviderError,
    SystemSkillProviderInfo,
    SystemSkillProviderListResponse,
    SystemSkillUpdateInstalledRequest,
)
from app.services.adapters.skill_kinds import skill_kinds_service
from app.services.system_skill_providers.core.registry import (
    SystemSkillProviderRegistry,
    system_skill_provider_registry,
)
from app.services.system_skill_providers.providers.base import SystemSkillProvider

logger = logging.getLogger(__name__)

InstalledSkillStateMap = Dict[Tuple[str, str], Tuple[int, Dict[str, Any]]]


class SystemSkillProviderService:
    """Aggregate system skill providers and merge user install state."""

    def __init__(
        self,
        registry: SystemSkillProviderRegistry = system_skill_provider_registry,
    ) -> None:
        self._registry = registry

    def list_providers(self) -> SystemSkillProviderListResponse:
        providers = [
            SystemSkillProviderInfo(
                key=config.key,
                name=config.name,
                description=config.description,
                requiresToken=config.requires_token,
                hasToken=False,
                priority=config.priority,
            )
            for config in self._registry.list_all()
        ]
        return SystemSkillProviderListResponse(providers=providers)

    async def list_system_skills(
        self,
        *,
        db: Session,
        user_id: int,
        user_name: Optional[str],
        provider_key: Optional[str],
        keyword: Optional[str],
        tags: Optional[List[str]],
        page: int,
        page_size: int,
    ) -> SystemSkillListResponse:
        providers = self._select_providers(provider_key)
        installed_state = self._load_installed_state(db, user_id)
        items: List[SystemSkillCatalogItem] = []
        provider_errors: List[SystemSkillProviderError] = []
        total = 0
        should_apply_global_pagination = provider_key is None and len(providers) > 1
        provider_page = 1 if should_apply_global_pagination else page
        provider_page_size = (
            page * page_size if should_apply_global_pagination else page_size
        )

        if provider_key and not providers:
            provider_errors.append(
                SystemSkillProviderError(
                    providerKey=provider_key,
                    code="provider_error",
                    message=f"Unknown provider: {provider_key}",
                )
            )

        for provider in providers:
            result_items, result_total, error = await self._fetch_provider_items(
                provider=provider,
                keyword=keyword,
                tags=tags,
                page=provider_page,
                page_size=provider_page_size,
                user_name=user_name,
            )
            if error:
                provider_errors.append(error)
                continue

            total += result_total
            items.extend(
                self._merge_installed_state(item, installed_state)
                for item in result_items
            )

        if should_apply_global_pagination:
            start = (page - 1) * page_size
            end = start + page_size
            items = items[start:end]

        return SystemSkillListResponse(
            total=total,
            page=page,
            pageSize=page_size,
            items=items,
            providerErrors=provider_errors,
        )

    def _select_providers(
        self, provider_key: Optional[str]
    ) -> List[SystemSkillProvider]:
        if provider_key:
            provider = self._registry.get(provider_key)
            return [provider] if provider else []
        return self._registry.providers()

    async def install_system_skill(
        self,
        *,
        db: Session,
        user_id: int,
        request: SystemSkillInstallRequest,
    ) -> InstalledSkill:
        provider = self._registry.get(request.providerKey)
        if not provider:
            raise HTTPException(
                status_code=404, detail="System skill provider not found"
            )

        existing_installed = self._find_installed_skill(
            db,
            user_id=user_id,
            provider_key=request.providerKey,
            skill_key=request.skillKey,
        )
        if existing_installed:
            logger.info(
                "Reactivating existing InstalledSkill: user_id=%s installed_id=%s name=%s old_enabled=%s old_state=%s",
                user_id,
                existing_installed.id,
                existing_installed.name,
                self._get_spec(existing_installed).get("enabled"),
                self._get_spec(existing_installed).get("installState"),
            )
            existing_spec = self._get_spec(existing_installed)
            existing_spec["enabled"] = True
            existing_spec["installState"] = "installed"
            existing_installed.json["spec"] = existing_spec
            existing_installed.is_active = True
            flag_modified(existing_installed, "json")
            db.commit()
            db.refresh(existing_installed)
            return self._kind_to_installed_skill(existing_installed)

        skill = self._find_skill(db, user_id=user_id, skill_key=request.skillKey)
        if not skill:
            source_skill_key = self._source_skill_key(request)
            archive = await provider.download_skill(
                source_skill_key=source_skill_key,
                version=request.version,
            )
            archive = self._normalize_skill_zip_root(
                file_content=archive,
                target_name=request.skillKey,
            )
            created = skill_kinds_service.create_skill(
                db=db,
                name=request.skillKey,
                namespace="default",
                file_content=archive,
                file_name=f"{request.skillKey}.zip",
                user_id=user_id,
                source={
                    "type": "system",
                    "providerKey": request.providerKey,
                    "skillKey": request.skillKey,
                    "catalogItemId": request.catalogItemId,
                },
            )
            skill = self._find_skill(
                db, user_id=user_id, skill_key=created.metadata.name
            )

        installed = self._create_installed_skill(
            db,
            user_id=user_id,
            request=request,
            skill=skill,
        )
        db.add(installed)
        db.commit()
        db.refresh(installed)
        return self._kind_to_installed_skill(installed)

    def list_installed_system_skills(
        self, *, db: Session, user_id: int
    ) -> InstalledSkillListResponse:
        rows = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "InstalledSkill",
                Kind.is_active == True,
            )
            .order_by(Kind.created_at.desc())
            .all()
        )
        items = [
            self._kind_to_installed_skill(row)
            for row in rows
            if self._get_spec(row).get("source", {}).get("type") == "system"
        ]
        return InstalledSkillListResponse(items=items)

    def update_installed_system_skill(
        self,
        *,
        db: Session,
        user_id: int,
        installed_id: int,
        request: SystemSkillUpdateInstalledRequest,
    ) -> InstalledSkill:
        installed = (
            db.query(Kind)
            .filter(
                Kind.id == installed_id,
                Kind.user_id == user_id,
                Kind.kind == "InstalledSkill",
                Kind.is_active == True,
            )
            .first()
        )
        if not installed:
            raise HTTPException(status_code=404, detail="Installed skill not found")

        spec = self._get_spec(installed)
        logger.info(
            "Updating InstalledSkill row: user_id=%s installed_id=%s name=%s old_enabled=%s old_state=%s new_enabled=%s",
            user_id,
            installed.id,
            installed.name,
            spec.get("enabled"),
            spec.get("installState"),
            request.enabled,
        )
        spec["enabled"] = request.enabled
        installed.json["spec"] = spec
        flag_modified(installed, "json")
        db.commit()
        db.refresh(installed)
        return self._kind_to_installed_skill(installed)

    def uninstall_installed_system_skill(
        self,
        *,
        db: Session,
        user_id: int,
        installed_id: int,
    ) -> None:
        installed = (
            db.query(Kind)
            .filter(
                Kind.id == installed_id,
                Kind.user_id == user_id,
                Kind.kind == "InstalledSkill",
                Kind.is_active == True,
            )
            .first()
        )
        if not installed:
            raise HTTPException(status_code=404, detail="Installed skill not found")

        spec = self._get_spec(installed)
        logger.info(
            "Uninstalling InstalledSkill row: user_id=%s installed_id=%s name=%s skill_ref=%s old_enabled=%s old_state=%s old_active=%s",
            user_id,
            installed.id,
            installed.name,
            spec.get("skillRef"),
            spec.get("enabled"),
            spec.get("installState"),
            installed.is_active,
        )
        spec["enabled"] = False
        spec["installState"] = "uninstalled"
        installed.json["spec"] = spec
        installed.is_active = False
        flag_modified(installed, "json")
        db.commit()
        logger.info(
            "InstalledSkill row uninstalled: user_id=%s installed_id=%s name=%s active=%s",
            user_id,
            installed.id,
            installed.name,
            installed.is_active,
        )

    async def _fetch_provider_items(
        self,
        *,
        provider: SystemSkillProvider,
        keyword: Optional[str],
        tags: Optional[List[str]],
        page: int,
        page_size: int,
        user_name: Optional[str],
    ) -> tuple[List[SystemSkillCatalogItem], int, Optional[SystemSkillProviderError]]:
        config = provider.get_config()
        if config.requires_token:
            return (
                [],
                0,
                SystemSkillProviderError(
                    providerKey=config.key,
                    code="token_required",
                    message="Provider token is required",
                ),
            )

        try:
            result = await provider.fetch_skills(
                keyword=keyword,
                tags=tags,
                page=page,
                page_size=page_size,
                token=None,
                user_name=user_name,
            )
            return result.items, result.total, None
        except Exception as exc:
            logger.warning(
                "System skill provider failed: provider_key=%s error=%s",
                config.key,
                str(exc) or type(exc).__name__,
                exc_info=True,
            )
            return [], 0, self._build_provider_error(config.key, exc)

    def _build_provider_error(
        self, provider_key: str, exc: Exception
    ) -> SystemSkillProviderError:
        code = "provider_error"
        message = "Provider request failed"

        if isinstance(exc, httpx.TimeoutException):
            code = "timeout"
            message = "Provider request timed out"
        elif isinstance(exc, httpx.ConnectError):
            code = "connect_error"
            message = "Provider connection failed"
        elif isinstance(exc, httpx.HTTPStatusError):
            if exc.response.status_code in (401, 403):
                code = "unauthorized"
                message = "Provider authentication failed"
        else:
            error_code = getattr(exc, "code", None)
            if error_code in {
                "token_required",
                "unauthorized",
                "timeout",
                "connect_error",
                "provider_error",
                "mapping_error",
            }:
                code = error_code
                message = str(exc) or message

        return SystemSkillProviderError(
            providerKey=provider_key,
            code=code,
            message=message,
        )

    def _source_skill_key(self, request: SystemSkillInstallRequest) -> str:
        if request.catalogItemId and "/" in request.catalogItemId:
            return request.catalogItemId.split("/", 1)[1]
        return request.skillKey

    def _normalize_skill_zip_root(
        self, *, file_content: bytes, target_name: str
    ) -> bytes:
        source = io.BytesIO(file_content)
        with zipfile.ZipFile(source, "r") as archive:
            skill_md_path = next(
                (name for name in archive.namelist() if name.endswith("SKILL.md")),
                None,
            )
            if not skill_md_path or "/" not in skill_md_path:
                return file_content

            source_root = skill_md_path.split("/", 1)[0]
            if source_root == target_name:
                return file_content

            output = io.BytesIO()
            with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as normalized:
                for info in archive.infolist():
                    if info.is_dir():
                        continue
                    name = info.filename
                    if name.startswith(f"{source_root}/"):
                        name = f"{target_name}/{name[len(source_root) + 1:]}"
                    normalized.writestr(name, archive.read(info.filename))
            return output.getvalue()

    def _find_skill(
        self, db: Session, *, user_id: int, skill_key: str
    ) -> Optional[Kind]:
        return (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Skill",
                Kind.name == skill_key,
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .first()
        )

    def _find_installed_skill(
        self,
        db: Session,
        *,
        user_id: int,
        provider_key: str,
        skill_key: str,
    ) -> Optional[Kind]:
        rows = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "InstalledSkill",
                Kind.is_active == True,
            )
            .all()
        )
        for row in rows:
            source = self._get_spec(row).get("source", {})
            if (
                isinstance(source, dict)
                and source.get("providerKey") == provider_key
                and source.get("skillKey") == skill_key
            ):
                return row
        return None

    def _create_installed_skill(
        self,
        db: Session,
        *,
        user_id: int,
        request: SystemSkillInstallRequest,
        skill: Optional[Kind],
    ) -> Kind:
        source_skill_key = self._source_skill_key(request)
        skill_ref = None
        if skill:
            skill_ref = {
                "kind": "Skill",
                "name": skill.name,
                "namespace": skill.namespace,
                "user_id": skill.user_id,
            }

        name = f"{request.providerKey}-{request.skillKey}"
        return Kind(
            user_id=user_id,
            kind="InstalledSkill",
            name=name[:100],
            namespace="default",
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "InstalledSkill",
                "metadata": {"name": name[:100], "namespace": "default"},
                "spec": {
                    "source": {
                        "type": "system",
                        "providerKey": request.providerKey,
                        "skillKey": request.skillKey,
                        "catalogItemId": request.catalogItemId,
                    },
                    "skillRef": skill_ref,
                    "displayName": request.displayName,
                    "description": request.description,
                    "version": request.version,
                    "installState": "installed",
                    "enabled": True,
                    "sourcePayload": {
                        "sourceSkillKey": source_skill_key,
                        "author": request.author,
                        "tags": request.tags,
                    },
                },
                "status": {"state": "Available"},
            },
            is_active=True,
        )

    def _kind_to_installed_skill(self, row: Kind) -> InstalledSkill:
        payload = dict(row.json)
        metadata = dict(payload.get("metadata", {}))
        labels = dict(metadata.get("labels", {}))
        labels["id"] = str(row.id)
        metadata["labels"] = labels
        payload["metadata"] = metadata
        return InstalledSkill.model_validate(payload)

    def _load_installed_state(
        self, db: Session, user_id: int
    ) -> InstalledSkillStateMap:
        rows = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "InstalledSkill",
                Kind.is_active == True,
            )
            .all()
        )

        installed_state: InstalledSkillStateMap = {}
        for row in rows:
            spec = self._get_spec(row)
            source = spec.get("source", {})
            if not isinstance(source, dict) or source.get("type") != "system":
                continue

            provider_key = source.get("providerKey")
            skill_key = source.get("skillKey")
            if isinstance(provider_key, str) and isinstance(skill_key, str):
                installed_state[(provider_key, skill_key)] = (row.id, spec)

        return installed_state

    def _get_spec(self, row: Kind) -> Dict[str, Any]:
        payload = row.json if isinstance(row.json, dict) else {}
        spec = payload.get("spec", {})
        return spec if isinstance(spec, dict) else {}

    def _merge_installed_state(
        self,
        item: SystemSkillCatalogItem,
        installed_state: InstalledSkillStateMap,
    ) -> SystemSkillCatalogItem:
        installed = installed_state.get((item.providerKey, item.name))
        if not installed:
            return item.model_copy(
                update={
                    "installState": "not_installed",
                    "installedSkillId": None,
                    "enabled": False,
                }
            )

        installed_id, spec = installed
        return item.model_copy(
            update={
                "installState": spec.get("installState", "installed"),
                "installedSkillId": installed_id,
                "enabled": bool(spec.get("enabled", False)),
            }
        )


system_skill_provider_service = SystemSkillProviderService()
