# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Worker-owned database phases for plugin HTTP orchestration."""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.db.session import get_db_session
from app.models.plugin_marketplace import Plugin, PluginDeviceInstallation
from app.models.subtask import SubtaskStatus
from app.models.task import TaskResource
from app.schemas.device import DeviceCapabilitySyncResponse, DeviceCapabilitySyncResult
from app.schemas.installed_plugin import (
    BuiltinPluginInstallRequest,
    InstalledPlugin,
    InstalledPluginListResponse,
    InstalledPluginUpdateRequest,
    PluginAccessResponse,
    PluginAccessUpdateRequest,
    PluginAutoUpdateBatchResponse,
    PluginCopyResponse,
    PluginDeleteImpactResponse,
    PluginDeleteRequest,
    PluginDeviceReportItem,
    PluginMarketplaceItem,
    PluginMarketplaceListResponse,
    PluginReleaseListResponse,
    PluginSubmissionCompleteResponse,
    PluginSubmissionInitRequest,
    PluginSubmissionInitResponse,
    PluginSubmissionItem,
)
from app.services.auth.task_token import TaskTokenInfo
from app.services.device.capability_sync_service import (
    device_capability_sync_service,
)
from app.services.installed_plugin_service import installed_plugin_service
from app.services.plugin_device_installation_service import (
    plugin_device_installation_service,
)
from app.services.plugin_marketplace_service import plugin_marketplace_service
from app.stores.tasks import subtask_store, task_store

ACTIVE_PLUGIN_SUBMISSION_SUBTASK_STATUSES = (
    SubtaskStatus.PENDING,
    SubtaskStatus.RUNNING,
    SubtaskStatus.PENDING_CONFIRMATION,
)


@dataclass(frozen=True)
class PluginDeviceSyncPlan:
    pending_count: int
    payload: dict[str, object]


@dataclass(frozen=True)
class InstalledPluginPlan:
    plugin: InstalledPlugin
    installed_id: int
    release_id: int | None
    legacy: bool = False


@dataclass(frozen=True)
class PluginAccessUpdatePlan:
    access: PluginAccessResponse
    revoked_installs: tuple[tuple[int, int], ...]


class PluginEndpointDB:
    """Execute every plugin database phase with a short owned session."""

    def validate_task_token(self, user_id: int, token_info: TaskTokenInfo) -> None:
        with get_db_session() as db:
            task = task_store.get_by_id_for_update(
                db,
                task_id=token_info.task_id,
                owner_user_id=user_id,
            )
            subtask = subtask_store.get_basic_by_id_for_update(
                db,
                subtask_id=token_info.subtask_id,
                owner_user_id=user_id,
            )
            if (
                task is None
                or task.kind != "Task"
                or task.is_active not in TaskResource.is_active_query()
                or subtask is None
                or subtask.task_id != token_info.task_id
                or subtask.user_id != user_id
                or subtask.status not in ACTIVE_PLUGIN_SUBMISSION_SUBTASK_STATUSES
            ):
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Task token is no longer active",
                    headers={"WWW-Authenticate": "Bearer"},
                )

    def list_installed(
        self,
        user_id: int,
        device_id: str | None,
    ) -> InstalledPluginListResponse:
        with get_db_session() as db:
            return plugin_marketplace_service.enrich_installed_list(
                db,
                installed_plugin_service.list_installed_plugins(
                    db=db,
                    user_id=user_id,
                ),
                device_id=device_id,
            )

    def auto_update_batch(self, user_id: int) -> PluginAutoUpdateBatchResponse:
        with get_db_session() as db:
            return plugin_marketplace_service.auto_update_batch(db, user_id=user_id)

    def prepare_device_sync(
        self,
        user_id: int,
        device_id: str,
    ) -> PluginDeviceSyncPlan:
        with get_db_session() as db:
            plugin_marketplace_service.reconcile_stale_installed_catalog_refs(
                db,
                user_id=user_id,
            )
            pending_count = (
                plugin_device_installation_service.ensure_pending_for_device(
                    db,
                    user_id=user_id,
                    device_id=device_id,
                )
            )
            payload = device_capability_sync_service.build_desired_capabilities(
                db,
                user_id=user_id,
                device_id=device_id,
            )
            return PluginDeviceSyncPlan(
                pending_count=pending_count,
                payload=payload,
            )

    def record_device_sync(
        self,
        user_id: int,
        result: DeviceCapabilitySyncResult,
    ) -> None:
        with get_db_session() as db:
            plugin_device_installation_service.record_device_sync_result(
                db,
                user_id=user_id,
                result=result,
            )

    def report_device(
        self,
        user_id: int,
        device_id: str,
        reported_plugins: list[PluginDeviceReportItem],
    ) -> list[int]:
        with get_db_session() as db:
            return plugin_device_installation_service.acknowledge_local_installs(
                db,
                user_id=user_id,
                device_id=device_id,
                reported_plugins=reported_plugins,
            )

    def upload(
        self,
        user_id: int,
        package_bytes: bytes,
        filename: str,
        enabled: bool,
    ) -> InstalledPlugin:
        with get_db_session() as db:
            return installed_plugin_service.upload_plugin(
                db=db,
                user_id=user_id,
                package_bytes=package_bytes,
                filename=filename,
                enabled=enabled,
            )

    def list_marketplace(
        self,
        user_id: int | None,
        query: str | None,
        source: str | None,
        listing_type: str | None,
        device_id: str | None,
    ) -> PluginMarketplaceListResponse:
        with get_db_session() as db:
            return plugin_marketplace_service.list_plugins(
                db,
                user_id=user_id,
                query=query,
                source=source,
                listing_type=listing_type,
                device_id=device_id,
            )

    def get_marketplace(
        self,
        plugin_id: int,
        user_id: int,
        device_id: str | None,
    ) -> PluginMarketplaceItem:
        with get_db_session() as db:
            return plugin_marketplace_service.get_plugin(
                db,
                plugin_id=plugin_id,
                user_id=user_id,
                device_id=device_id,
            )

    def list_releases(self, plugin_id: int, user_id: int) -> PluginReleaseListResponse:
        with get_db_session() as db:
            return plugin_marketplace_service.list_releases(
                db,
                plugin_id=plugin_id,
                user_id=user_id,
            )

    def get_access(self, plugin_id: int, user_id: int) -> PluginAccessResponse:
        with get_db_session() as db:
            return plugin_marketplace_service.get_plugin_access(
                db,
                plugin_id=plugin_id,
                user_id=user_id,
            )

    def update_access(
        self,
        plugin_id: int,
        user_id: int,
        request: PluginAccessUpdateRequest,
    ) -> PluginAccessUpdatePlan:
        with get_db_session() as db:
            access, revoked_installs = plugin_marketplace_service.update_plugin_access(
                db,
                plugin_id=plugin_id,
                user_id=user_id,
                request=request,
            )
            return PluginAccessUpdatePlan(
                access=access,
                revoked_installs=tuple(revoked_installs),
            )

    def delete_impact(self, plugin_id: int, user_id: int) -> PluginDeleteImpactResponse:
        with get_db_session() as db:
            return plugin_marketplace_service.get_personal_plugin_delete_impact(
                db,
                plugin_id=plugin_id,
                user_id=user_id,
            )

    def delete_marketplace(
        self,
        plugin_id: int,
        user_id: int,
        request: PluginDeleteRequest,
    ) -> tuple[tuple[int, int], ...]:
        with get_db_session() as db:
            installations = plugin_marketplace_service.delete_owned_personal_plugin(
                db,
                plugin_id=plugin_id,
                user_id=user_id,
                impact_revision=request.impactRevision,
                revoke_and_delete=request.revokeAndDelete,
            )
            return tuple(installations)

    def pending_device_count(self, installed_ids: tuple[int, ...]) -> int:
        if not installed_ids:
            return 0
        with get_db_session() as db:
            return (
                db.query(PluginDeviceInstallation.id)
                .filter(PluginDeviceInstallation.installed_kind_id.in_(installed_ids))
                .count()
            )

    def mark_uninstalling(self, user_id: int, installed_id: int) -> None:
        with get_db_session() as db:
            plugin_device_installation_service.mark_uninstalling(
                db,
                user_id=user_id,
                installed_kind_id=installed_id,
            )

    def record_uninstall(
        self,
        user_id: int,
        installed_id: int,
        response: DeviceCapabilitySyncResponse,
    ) -> None:
        with get_db_session() as db:
            plugin_device_installation_service.record_uninstall_response(
                db,
                user_id=user_id,
                installed_kind_id=installed_id,
                response=response,
            )

    def copy_descriptor(self, plugin_id: int, user_id: int) -> PluginCopyResponse:
        with get_db_session() as db:
            return plugin_marketplace_service.plugin_copy_descriptor(
                db,
                plugin_id=plugin_id,
                user_id=user_id,
            )

    def install_marketplace(
        self,
        marketplace_id: int,
        user_id: int,
        release_id: int | None,
    ) -> InstalledPluginPlan:
        with get_db_session() as db:
            plugin = plugin_marketplace_service.install(
                db,
                user_id=user_id,
                plugin_id=marketplace_id,
                release_id=release_id,
            )
            return self._installed_plan(plugin)

    def ensure_builtin(
        self,
        plugin_key: str,
        user_id: int,
    ) -> InstalledPluginPlan:
        with get_db_session() as db:
            item = db.query(Plugin).filter(Plugin.slug == plugin_key).first()
            if item is None:
                plugin = installed_plugin_service.install_builtin_plugin(
                    db=db,
                    user_id=user_id,
                    plugin_key=plugin_key,
                )
                return self._installed_plan(plugin, legacy=True)
            plugin = plugin_marketplace_service.install(
                db,
                user_id=user_id,
                plugin_id=item.id,
            )
            return self._installed_plan(plugin)

    def enrich_installed(
        self,
        plugin: InstalledPlugin,
        device_id: str | None,
    ) -> InstalledPlugin:
        with get_db_session() as db:
            enriched = plugin_marketplace_service.enrich_installed_list(
                db,
                InstalledPluginListResponse(items=[plugin]),
                device_id=device_id,
            )
            return enriched.items[0]

    def download_package(self, user_id: int, installed_id: int) -> tuple[bytes, str]:
        with get_db_session() as db:
            try:
                return plugin_marketplace_service.release_package_for_install(
                    db,
                    user_id=user_id,
                    installed_id=installed_id,
                )
            except HTTPException as exc:
                if exc.status_code != 404:
                    raise
                return installed_plugin_service.package_data_for_download(
                    db=db,
                    user_id=user_id,
                    installed_id=installed_id,
                )

    def update_installed(
        self,
        user_id: int,
        installed_id: int,
        request: InstalledPluginUpdateRequest,
    ) -> InstalledPluginPlan:
        with get_db_session() as db:
            if request.releaseId is not None:
                plugin = plugin_marketplace_service.update_release(
                    db,
                    user_id=user_id,
                    installed_id=installed_id,
                    release_id=request.releaseId,
                )
            else:
                plugin = installed_plugin_service.update_installed_plugin(
                    db=db,
                    user_id=user_id,
                    installed_id=installed_id,
                    request=request,
                )
            return self._installed_plan(plugin)

    def begin_uninstall(self, user_id: int, installed_id: int) -> None:
        with get_db_session() as db:
            plugin_device_installation_service.mark_uninstalling(
                db,
                user_id=user_id,
                installed_kind_id=installed_id,
            )
            try:
                installed_plugin_service.uninstall_installed_plugin(
                    db=db,
                    user_id=user_id,
                    installed_id=installed_id,
                )
            except HTTPException as exc:
                if exc.status_code != status.HTTP_404_NOT_FOUND:
                    raise

    def finalize_uninstall(
        self,
        user_id: int,
        installed_id: int,
        response: DeviceCapabilitySyncResponse,
    ) -> None:
        with get_db_session() as db:
            plugin_device_installation_service.record_uninstall_response(
                db,
                user_id=user_id,
                installed_kind_id=installed_id,
                response=response,
            )
            plugin_device_installation_service.clear_installations(
                db,
                user_id=user_id,
                installed_kind_id=installed_id,
            )

    def should_retry_device_install(
        self,
        device_id: str,
        installed_id: int,
        manual_retry: bool,
    ) -> bool:
        with get_db_session() as db:
            row = (
                db.query(PluginDeviceInstallation)
                .filter(
                    PluginDeviceInstallation.installed_kind_id == installed_id,
                    PluginDeviceInstallation.device_id == device_id,
                )
                .first()
            )
            if row and row.state == "installed":
                return False
            return not (
                not manual_retry
                and row
                and plugin_device_installation_service.auto_update_blocked_release_id(
                    row,
                    desired_release_id=row.desired_release_id,
                )
            )

    def record_global_sync(
        self,
        user_id: int,
        response: DeviceCapabilitySyncResponse,
        required_device_id: str | None,
        required_installed_id: int | None,
        expect_installed: bool,
    ) -> bool:
        with get_db_session() as db:
            plugin_device_installation_service.record_sync_response(
                db,
                user_id=user_id,
                response=response,
            )
            if required_device_id is None or required_installed_id is None:
                return True
            row = (
                db.query(PluginDeviceInstallation)
                .filter(
                    PluginDeviceInstallation.installed_kind_id == required_installed_id,
                    PluginDeviceInstallation.device_id == required_device_id,
                )
                .first()
            )
            materialized = bool(row and row.state == "installed")
            return materialized == expect_installed

    def record_merge_sync(
        self,
        user_id: int,
        response: DeviceCapabilitySyncResponse,
    ) -> None:
        with get_db_session() as db:
            plugin_device_installation_service.record_sync_response(
                db,
                user_id=user_id,
                response=response,
            )

    def init_submission(
        self,
        user_id: int,
        request: PluginSubmissionInitRequest,
        task_token: TaskTokenInfo | None,
    ) -> PluginSubmissionInitResponse:
        with get_db_session() as db:
            return plugin_marketplace_service.init_submission(
                db,
                user_id=user_id,
                request=request,
                task_binding=(
                    (task_token.task_id, task_token.subtask_id) if task_token else None
                ),
            )

    def complete_submission(
        self,
        submission_id: int,
        user_id: int,
        task_token: TaskTokenInfo | None,
        publish_allowed: bool,
    ) -> PluginSubmissionCompleteResponse:
        with get_db_session() as db:
            self._ensure_submission_task_binding(
                db,
                submission_id=submission_id,
                user_id=user_id,
                task_token=task_token,
            )
            existing = plugin_marketplace_service.get_submission(
                db,
                user_id=user_id,
                submission_id=submission_id,
            )
            if existing.purpose == "marketplace_publish" and not publish_allowed:
                raise HTTPException(
                    status_code=403,
                    detail="Plugin publishing is not enabled",
                )
            item = plugin_marketplace_service.complete_submission(
                db,
                user_id=user_id,
                submission_id=submission_id,
            )
            plugin = None
            if item.status in {"approved", "pending"}:
                try:
                    plugin = plugin_marketplace_service.get_plugin(
                        db,
                        plugin_id=item.pluginId,
                        user_id=user_id,
                    )
                except HTTPException:
                    plugin = None
            return PluginSubmissionCompleteResponse(submission=item, plugin=plugin)

    def cancel_submission(
        self,
        submission_id: int,
        user_id: int,
        task_token: TaskTokenInfo | None,
    ) -> PluginSubmissionItem:
        with get_db_session() as db:
            self._ensure_submission_task_binding(
                db,
                submission_id=submission_id,
                user_id=user_id,
                task_token=task_token,
            )
            return plugin_marketplace_service.cancel_submission(
                db,
                user_id=user_id,
                submission_id=submission_id,
            )

    def get_submission(
        self,
        submission_id: int,
        user_id: int,
        user_role: str,
        task_token: TaskTokenInfo | None,
    ) -> PluginSubmissionItem:
        with get_db_session() as db:
            self._ensure_submission_task_binding(
                db,
                submission_id=submission_id,
                user_id=user_id,
                task_token=task_token,
            )
            return plugin_marketplace_service.get_submission(
                db,
                user_id=user_id,
                submission_id=submission_id,
                is_admin=user_role == "admin",
            )

    def _installed_plan(
        self,
        plugin: InstalledPlugin,
        *,
        legacy: bool = False,
    ) -> InstalledPluginPlan:
        return InstalledPluginPlan(
            plugin=plugin,
            installed_id=int(plugin.metadata["labels"]["id"]),
            release_id=plugin.spec.releaseId,
            legacy=legacy,
        )

    def _ensure_submission_task_binding(
        self,
        db: Session,
        *,
        submission_id: int,
        user_id: int,
        task_token: TaskTokenInfo | None,
    ) -> None:
        if task_token is None:
            return
        plugin_marketplace_service.ensure_submission_task_binding(
            db,
            user_id=user_id,
            submission_id=submission_id,
            task_id=task_token.task_id,
            subtask_id=task_token.subtask_id,
        )


plugin_endpoint_db = PluginEndpointDB()
