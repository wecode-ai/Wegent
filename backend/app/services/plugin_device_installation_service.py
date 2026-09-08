# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Persist device-level materialization of account plugin desired state."""

from datetime import datetime

from sqlalchemy.orm import Session

from app.core.constants import PLUGIN_AUTO_UPDATE_FAILURE_LIMIT
from app.models.kind import Kind
from app.models.plugin_marketplace import PluginDeviceInstallation
from app.schemas.device import (
    DeviceCapabilityItemResult,
    DeviceCapabilitySyncResponse,
    DeviceCapabilitySyncResult,
)
from app.schemas.installed_plugin import PluginDeviceReportItem
from app.services.device_service import device_service
from app.services.plugin_device_identity import (
    plugin_device_id,
    reconcile_plugin_device_rows,
)


class PluginDeviceInstallationService:
    """Translate capability sync acknowledgements into queryable device state."""

    async def ensure_pending_for_all_devices(
        self,
        db: Session,
        *,
        user_id: int,
        installed_kind_id: int,
        desired_release_id: int,
        reset_failures: bool = False,
    ) -> None:
        """Materialize desired state for registered online and offline devices."""
        reconcile_plugin_device_rows(db, user_id)
        devices = await device_service.get_all_devices(db, user_id)
        for device in devices:
            device_id = self._device_id(device)
            if not device_id:
                continue
            device_id = plugin_device_id(db, user_id, device_id)
            row = self._device_row(db, installed_kind_id, device_id)
            if not row:
                row = PluginDeviceInstallation(
                    installed_kind_id=installed_kind_id,
                    user_id=user_id,
                    device_id=device_id,
                    desired_release_id=desired_release_id,
                )
                db.add(row)
            desired_changed = row.desired_release_id != desired_release_id
            row.desired_release_id = desired_release_id
            if desired_changed or reset_failures:
                row.attempt_count = 0
            if row.actual_release_id != desired_release_id:
                if self._auto_update_blocked(row) and not reset_failures:
                    continue
                row.state = "pending"
                row.error_code = ""
                row.error_message = ""
        db.commit()

    def mark_uninstalling(
        self, db: Session, *, user_id: int, installed_kind_id: int
    ) -> None:
        rows = (
            db.query(PluginDeviceInstallation)
            .filter(
                PluginDeviceInstallation.user_id == user_id,
                PluginDeviceInstallation.installed_kind_id == installed_kind_id,
            )
            .all()
        )
        for row in rows:
            row.state = "uninstalling"
            row.error_code = ""
            row.error_message = ""
        db.commit()

    def record_uninstall_response(
        self,
        db: Session,
        *,
        user_id: int,
        installed_kind_id: int,
        response: DeviceCapabilitySyncResponse,
    ) -> None:
        """Remove materialized rows only for devices that confirmed uninstall."""
        successful_device_ids = {
            item.device_id for item in response.results if item.success
        }
        if successful_device_ids:
            (
                db.query(PluginDeviceInstallation)
                .filter(
                    PluginDeviceInstallation.user_id == user_id,
                    PluginDeviceInstallation.installed_kind_id == installed_kind_id,
                    PluginDeviceInstallation.device_id.in_(successful_device_ids),
                )
                .delete(synchronize_session=False)
            )
            db.commit()

    def clear_installations(
        self,
        db: Session,
        *,
        user_id: int,
        installed_kind_id: int,
    ) -> None:
        """Drop all device rows for an account-level uninstall.

        Account desired state already excludes the plugin; leftover rows only
        keep the UI stuck on sync-failed / uninstalling banners.
        """
        (
            db.query(PluginDeviceInstallation)
            .filter(
                PluginDeviceInstallation.user_id == user_id,
                PluginDeviceInstallation.installed_kind_id == installed_kind_id,
            )
            .delete(synchronize_session=False)
        )
        db.commit()

    def record_sync_response(
        self,
        db: Session,
        *,
        user_id: int,
        response: DeviceCapabilitySyncResponse,
    ) -> None:
        for device_result in response.results:
            self._record_device_sync_result(db, user_id, device_result)
        db.commit()

    def record_device_sync_result(
        self,
        db: Session,
        *,
        user_id: int,
        result: DeviceCapabilitySyncResult,
    ) -> None:
        """Persist a reconnect-time sync result for one device."""
        self._record_device_sync_result(db, user_id, result)
        db.commit()

    def acknowledge_local_installs(
        self,
        db: Session,
        *,
        user_id: int,
        device_id: str,
        reported_plugins: list[PluginDeviceReportItem],
    ) -> list[int]:
        """Mark locally present plugins as installed without pushing packages."""
        reconcile_plugin_device_rows(db, user_id)
        normalized_device_id = plugin_device_id(db, user_id, device_id)
        reports_by_id = {
            report.installedPluginId: report for report in reported_plugins
        }
        if not normalized_device_id or not reports_by_id:
            return []
        acknowledged_ids: list[int] = []
        for installed in self._desired_installs(db, user_id):
            report = reports_by_id.get(installed.id)
            if report is None:
                continue
            if self._acknowledge_local_install(
                db,
                user_id=user_id,
                device_id=normalized_device_id,
                installed=installed,
                reported_release_id=report.releaseId,
                reported_version=report.version,
            ):
                acknowledged_ids.append(installed.id)
        if acknowledged_ids:
            db.commit()
        return acknowledged_ids

    def _record_device_sync_result(
        self,
        db: Session,
        user_id: int,
        result: DeviceCapabilitySyncResult,
    ) -> None:
        reconcile_plugin_device_rows(db, user_id)
        result = result.model_copy(
            update={"device_id": plugin_device_id(db, user_id, result.device_id)}
        )
        installs = self._desired_installs(db, user_id)
        desired_ids = {installed.id for installed in installs}
        self._record_removed_installs(db, user_id, result, desired_ids)
        plugin_results = {
            int(item.id): item
            for item in result.plugins
            if item.id is not None and str(item.id).isdigit()
        }
        for installed in installs:
            self._record_desired_install(
                db,
                user_id=user_id,
                installed=installed,
                result=result,
                item_result=plugin_results.get(installed.id),
            )

    def _acknowledge_local_install(
        self,
        db: Session,
        *,
        user_id: int,
        device_id: str,
        installed: Kind,
        reported_release_id: int,
        reported_version: str,
    ) -> bool:
        spec = installed.json.get("spec", {})
        release_id = spec.get("releaseId")
        desired_version = str(spec.get("version") or "").strip()
        if (
            not isinstance(release_id, int)
            or reported_release_id != release_id
            or not desired_version
            or reported_version.strip() != desired_version
        ):
            return False
        row = self._device_row(db, installed.id, device_id)
        if row and row.state == "uninstalling":
            return False
        if row and self._auto_update_blocked(row, desired_release_id=release_id):
            return False
        if not row:
            row = PluginDeviceInstallation(
                installed_kind_id=installed.id,
                user_id=user_id,
                device_id=device_id,
                desired_release_id=release_id,
            )
            db.add(row)
        row.desired_release_id = release_id
        row.actual_release_id = release_id
        row.state = "installed"
        row.error_code = ""
        row.error_message = ""
        row.attempt_count = 0
        row.last_sync_at = datetime.now()
        return True

    def _record_removed_installs(
        self,
        db: Session,
        user_id: int,
        result: DeviceCapabilitySyncResult,
        desired_ids: set[int],
    ) -> None:
        rows = (
            db.query(PluginDeviceInstallation)
            .filter(
                PluginDeviceInstallation.user_id == user_id,
                PluginDeviceInstallation.device_id == result.device_id,
            )
            .all()
        )
        for row in rows:
            if row.installed_kind_id in desired_ids:
                continue
            if result.success:
                db.delete(row)
                continue
            row.state = "failed"
            row.error_code = "PLUGIN_SYNC_FAILED"
            row.error_message = result.error or "Device rejected plugin removal"
            row.attempt_count = (row.attempt_count or 0) + 1
            row.last_sync_at = datetime.now()

    def _record_desired_install(
        self,
        db: Session,
        *,
        user_id: int,
        installed: Kind,
        result: DeviceCapabilitySyncResult,
        item_result: DeviceCapabilityItemResult | None,
    ) -> None:
        release_id = installed.json.get("spec", {}).get("releaseId")
        if not isinstance(release_id, int):
            return
        row = self._device_row(db, installed.id, result.device_id)
        if row and self._auto_update_blocked(row, desired_release_id=release_id):
            return
        state, error_message = self._device_install_state(result, item_result)
        if (
            item_result is None
            and result.success
            and row
            and row.state == "installed"
            and row.actual_release_id == release_id
        ):
            # Device omitted an already-materialized plugin; keep the confirmed state.
            return
        if not row:
            row = PluginDeviceInstallation(
                installed_kind_id=installed.id,
                user_id=user_id,
                device_id=result.device_id,
                desired_release_id=release_id,
            )
            db.add(row)
        desired_changed = row.desired_release_id != release_id
        row.desired_release_id = release_id
        if state == "installed":
            row.actual_release_id = release_id
            row.attempt_count = 0
        elif state == "failed":
            row.attempt_count = 1 if desired_changed else (row.attempt_count or 0) + 1
        elif desired_changed:
            row.attempt_count = 0
        row.state = state
        row.error_code = "PLUGIN_SYNC_FAILED" if state == "failed" else ""
        row.error_message = error_message or ""
        row.last_sync_at = datetime.now()

    def ensure_pending_for_device(
        self,
        db: Session,
        *,
        user_id: int,
        device_id: str,
        manual_retry: bool = False,
    ) -> int:
        """Ensure account desired plugins are pending on one device until synced.

        Creates missing rows and retries failed updates until their per-release
        circuit breaker opens. Manual retries reset that breaker.
        """
        reconcile_plugin_device_rows(db, user_id)
        normalized_device_id = plugin_device_id(db, user_id, device_id)
        if not normalized_device_id:
            return 0
        changed = 0
        for installed in self._desired_installs(db, user_id):
            release_id = installed.json.get("spec", {}).get("releaseId")
            if not isinstance(release_id, int):
                continue
            row = self._device_row(db, installed.id, normalized_device_id)
            if not row:
                db.add(
                    PluginDeviceInstallation(
                        installed_kind_id=installed.id,
                        user_id=user_id,
                        device_id=normalized_device_id,
                        desired_release_id=release_id,
                        state="pending",
                    )
                )
                changed += 1
                continue
            desired_changed = row.desired_release_id != release_id
            row.desired_release_id = release_id
            if desired_changed or manual_retry:
                row.attempt_count = 0
            if row.state == "installed" and row.actual_release_id == release_id:
                continue
            # Never interrupt an in-flight uninstall; the Kind may still be
            # active for a brief window before account uninstall completes.
            if row.state == "uninstalling":
                continue
            if self._auto_update_blocked(row) and not manual_retry:
                continue
            if (
                row.state == "pending"
                and not row.error_code
                and not row.error_message
                and row.actual_release_id in {0, release_id}
            ):
                continue
            row.state = "pending"
            row.error_code = ""
            row.error_message = ""
            changed += 1
        db.commit()
        return changed

    def auto_update_blocked_release_id(
        self,
        row: PluginDeviceInstallation | None,
        *,
        desired_release_id: int,
    ) -> int | None:
        """Return the preserved release when automatic retries are exhausted."""
        if not row or not self._auto_update_blocked(
            row, desired_release_id=desired_release_id
        ):
            return None
        return row.actual_release_id

    def _auto_update_blocked(
        self,
        row: PluginDeviceInstallation,
        *,
        desired_release_id: int | None = None,
    ) -> bool:
        expected_release_id = desired_release_id or row.desired_release_id
        return bool(
            row.state == "failed"
            and row.attempt_count >= PLUGIN_AUTO_UPDATE_FAILURE_LIMIT
            and row.actual_release_id
            and row.actual_release_id != expected_release_id
            and row.desired_release_id == expected_release_id
        )

    def _device_install_state(
        self,
        result: DeviceCapabilitySyncResult,
        item_result: DeviceCapabilityItemResult | None,
    ) -> tuple[str, str | None]:
        if item_result is not None:
            if item_result.status in {"failed", "error"}:
                return "failed", item_result.error or "Device rejected plugin install"
            if item_result.status == "synced":
                return "installed", None
        if not result.success:
            return "failed", item_result.error if item_result else result.error
        if item_result is None:
            # Overall ack succeeded but this plugin was not reported yet — keep
            # waiting instead of marking a hard failure that surfaces as retry.
            return "pending", None
        return "installed", None

    def _device_row(
        self, db: Session, installed_kind_id: int, device_id: str
    ) -> PluginDeviceInstallation | None:
        return (
            db.query(PluginDeviceInstallation)
            .filter(
                PluginDeviceInstallation.installed_kind_id == installed_kind_id,
                PluginDeviceInstallation.device_id == device_id,
            )
            .first()
        )

    def _device_id(self, device: dict) -> str | None:
        for key in ("device_id", "deviceId", "id"):
            value = device.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None

    def _desired_installs(self, db: Session, user_id: int) -> list[Kind]:
        return (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "InstalledPlugin",
                Kind.namespace == "default",
                Kind.is_active,
            )
            .all()
        )


plugin_device_installation_service = PluginDeviceInstallationService()
