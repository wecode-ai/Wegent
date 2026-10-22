# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Record only acknowledged plugin state that still matches the account."""

from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.plugin_marketplace import PluginDeviceInstallation
from app.schemas.device import DeviceCapabilitySyncResult
from app.services.device.plugin_sync_protocol import (
    advance_plugin_snapshot_watermark,
    lock_plugin_sync_state,
    plugin_snapshot_watermark,
)


def stable_plugin(plugin: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in plugin.items()
        if key not in {"download_path", "download_url_expires_at"}
    }


def record_versioned_result(
    recorder: Any, db: Session, user_id: int, result: DeviceCapabilitySyncResult
) -> None:
    from app.services.device.capability_sync_service import (
        device_capability_sync_service,
    )

    payload = result.desired_plugin_snapshot or {}
    metadata = payload["plugin_sync"]
    generation = metadata["generation"]
    sync_state = lock_plugin_sync_state(db, user_id)
    expected = {
        item["installed_plugin_id"]: item for item in payload.get("plugins") or []
    }
    removed_ids = {
        item["installed_plugin_id"] for item in payload.get("removed_plugins") or []
    }
    rows = (
        db.query(PluginDeviceInstallation)
        .filter_by(
            user_id=user_id,
            device_id=result.device_id,
        )
        .all()
    )
    if (payload.get("plugin_sync") or {}).get("complete"):
        removed_ids.update(
            row.installed_kind_id
            for row in rows
            if row.installed_kind_id not in expected
        )
    ids = sorted(set(expected) | removed_ids)
    # The account write lease and revision CAS serialize this refresh with
    # install/remove transactions. No network work occurs inside the lease.
    installs = (
        db.query(Kind)
        .filter(
            Kind.user_id == user_id,
            Kind.kind == "InstalledPlugin",
            Kind.namespace == "default",
            Kind.id.in_(ids),
        )
        .order_by(Kind.id)
        .populate_existing()
        .all()
    )
    current = {
        item["installed_plugin_id"]: item
        for item in device_capability_sync_service._load_installed_plugins(
            db,
            user_id=user_id,
            device_id=result.device_id,
            only_ids=ids,
        )
    }
    acknowledgements = {str(item.id): item for item in result.plugins}
    for installed in installs:
        if generation < plugin_snapshot_watermark(
            sync_state, result.device_id, installed.id
        ):
            continue
        item = acknowledgements.get(str(installed.id))
        if item is not None and item.status == "superseded":
            continue
        desired = current.get(installed.id)
        previous = expected.get(installed.id)
        if previous is not None and desired is not None:
            if stable_plugin(desired) != stable_plugin(previous):
                continue
            recorder._record_desired_install(
                db,
                user_id=user_id,
                installed=installed,
                result=result,
                item_result=item,
            )
        elif installed.id in removed_ids and desired is None:
            row = next(
                (row for row in rows if row.installed_kind_id == installed.id), None
            )
            if row is None:
                continue
            if result.success and (item is None or item.status == "removed"):
                db.delete(row)
            elif not result.success or (item and item.status == "failed"):
                row.state = "failed"
                row.error_code = "PLUGIN_SYNC_FAILED"
                row.error_message = (
                    result.error
                    or (item.error if item else None)
                    or "Device rejected plugin removal"
                )
                row.attempt_count = (row.attempt_count or 0) + 1
                row.last_sync_at = datetime.now()
    advance_plugin_snapshot_watermark(
        sync_state,
        result.device_id,
        generation=generation,
        complete=metadata["complete"],
        installed_plugin_ids=ids,
    )
