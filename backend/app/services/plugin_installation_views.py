"""Batch response enrichment for account plugin installation mutations."""

import logging
from itertools import chain
from time import perf_counter

from sqlalchemy.orm import Session

from app.models.plugin_marketplace import (
    Plugin,
    PluginDeviceInstallation,
    unset_datetime,
    unset_id,
    unset_str,
)
from app.schemas.installed_plugin import (
    InstalledPlugin,
    InstalledPluginListResponse,
    PluginDeviceInstallationItem,
)
from app.services.plugin_device_identity import coalesce_plugin_device_rows_resolved
from app.services.plugin_device_snapshot import PluginDeviceSnapshot
from shared.telemetry.decorators import trace_sync

logger = logging.getLogger(__name__)


def installed_item_id(item: InstalledPlugin) -> int | None:
    value = (item.metadata.get("labels") or {}).get("id")
    return int(value) if str(value).isdigit() else None


def device_has_materialized_release(row: PluginDeviceInstallation | None) -> bool:
    return bool(row and row.actual_release_id)


def device_installation_item(
    row: PluginDeviceInstallation,
) -> PluginDeviceInstallationItem:
    return PluginDeviceInstallationItem(
        deviceId=row.device_id,
        desiredReleaseId=row.desired_release_id,
        actualReleaseId=unset_id(row.actual_release_id),
        state=row.state,
        errorCode=unset_str(row.error_code),
        errorMessage=unset_str(row.error_message),
        attemptCount=row.attempt_count,
        lastSyncAt=unset_datetime(row.last_sync_at),
        updatedAt=row.updated_at,
    )


def _marketplace_candidates(
    response: InstalledPluginListResponse,
    rows_by_install: dict[int, PluginDeviceInstallation],
    device_id: str | None,
) -> list[InstalledPlugin]:
    candidates = []
    for item in response.items:
        if not item.spec.pluginId:
            continue
        installed_id = installed_item_id(item)
        if device_id and installed_id:
            row = rows_by_install.get(installed_id)
            if not device_has_materialized_release(row):
                item.spec.installState = (
                    "failed" if row and row.state == "failed" else "not_installed"
                )
                continue
            if row.actual_release_id != item.spec.releaseId:
                item.spec.installState = "update_available"
                continue
            item.spec.installState = "installed"
        candidates.append(item)
    return candidates


@trace_sync("plugins.enrich_installations", "backend.plugins")
def enrich_plugin_installations(
    db: Session,
    response: InstalledPluginListResponse,
    *,
    device_id: str | None,
) -> InstalledPluginListResponse:
    started = perf_counter()
    installed = {
        int(item.metadata["labels"]["id"]): item
        for item in response.items
        if str((item.metadata.get("labels") or {}).get("id", "")).isdigit()
    }
    rows = (
        db.query(PluginDeviceInstallation)
        .filter(PluginDeviceInstallation.installed_kind_id.in_(installed))
        .order_by(PluginDeviceInstallation.device_id)
        .all()
        if installed
        else []
    )
    rows_loaded = perf_counter()
    snapshot = PluginDeviceSnapshot.load(
        db,
        chain(
            ((row.user_id, row.device_id) for row in rows),
            ((row.user_id, device_id) for row in rows if device_id),
        ),
    )
    selected = coalesce_plugin_device_rows_resolved(rows, snapshot.resolve)
    rows_by_install = {}
    for (_, canonical), row in selected.items():
        item = installed.get(row.installed_kind_id)
        if item is None:
            continue
        matched = bool(
            device_id and snapshot.resolve(row.user_id, device_id) == canonical
        )
        display = device_id if matched else canonical
        item.status.devices.append(
            device_installation_item(row).model_copy(update={"deviceId": display})
        )
        if matched:
            rows_by_install[row.installed_kind_id] = row
    devices_resolved = perf_counter()
    candidates = _marketplace_candidates(response, rows_by_install, device_id)
    plugin_ids = {item.spec.pluginId for item in candidates}
    versions = (
        dict(
            db.query(Plugin.id, Plugin.latest_release_id)
            .filter(Plugin.id.in_(plugin_ids))
            .all()
        )
        if plugin_ids
        else {}
    )
    for item in candidates:
        if (
            item.spec.pluginId in versions
            and versions[item.spec.pluginId] != item.spec.releaseId
        ):
            item.spec.installState = "update_available"
    logger.debug(
        "Plugin enrichment plugins=%d installations=%d identities=%d rows_ms=%.3f devices_ms=%.3f versions_ms=%.3f",
        len(response.items),
        len(rows),
        len(selected),
        (rows_loaded - started) * 1000,
        (devices_resolved - rows_loaded) * 1000,
        (perf_counter() - devices_resolved) * 1000,
    )
    return response
