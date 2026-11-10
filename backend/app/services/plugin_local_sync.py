"""Opt-in account transactions; legacy requests never enter this module."""

import hashlib
import json
import os
import re
from collections.abc import Iterator
from contextlib import contextmanager
from copy import deepcopy
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.schemas.installed_plugin import InstalledPlugin, InstalledPluginUpdateRequest
from app.services.device.plugin_sync_protocol import lock_plugin_sync_state
from app.services.installed_plugin_service import installed_plugin_service
from app.services.plugin_marketplace_service import plugin_marketplace_service
from app.services.plugin_write_coordination import acquire_plugin_write_lock
from shared.telemetry.decorators import trace_sync

LOCAL_DELIVERY_MODE = "local_pull_v1"
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")


def validate_local_request(
    mode: str | None, instance: str | None, operation: str | None
) -> bool:
    if mode is None:
        return False
    if mode != LOCAL_DELIVERY_MODE:
        raise HTTPException(422, "LOCAL_SYNC_PROTOCOL_UNSUPPORTED")
    if not all(
        value and _IDENTIFIER.fullmatch(value) for value in (instance, operation)
    ):
        raise HTTPException(422, "INVALID_LOCAL_SYNC_IDENTITY")
    return True


@trace_sync("plugins.local_intent", "backend.plugins")
def mutate_local_plugin(
    db: Session,
    *,
    user_id: int,
    instance_id: str,
    operation_id: str,
    intent_order: int | None = None,
    action: str,
    target_id: int | str,
    payload: dict[str, Any] | None = None,
    source_device_id: str | None = None,
) -> dict[str, Any] | None:
    """Commit account intent, idempotent result in one transaction."""
    with _rejection_context(db, user_id, instance_id, operation_id, intent_order):
        if type(intent_order) is not int or not 0 < intent_order < 2**63:
            raise HTTPException(422, "INVALID_LOCAL_INTENT_ORDER")
        if source_device_id and not _IDENTIFIER.fullmatch(source_device_id):
            raise HTTPException(422, "INVALID_SOURCE_DEVICE_ID")
        request_hash = hashlib.sha256(
            json.dumps(
                {
                    "action": action,
                    "target": target_id,
                    "payload": payload,
                    "intentOrder": intent_order,
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        enabled = (
            os.getenv(
                "PLUGIN_LOCAL_SYNC_ENABLED", str(settings.PLUGIN_LOCAL_SYNC_ENABLED)
            ).lower()
            == "true"
        )
        if not enabled:
            acquire_plugin_write_lock(db, user_id)
            previous = _replay_operation(
                db, user_id, instance_id, operation_id, request_hash
            )
            if previous is None:
                if action in {"update", "uninstall"}:
                    target = int(target_id)
                elif action == "install":
                    installed = plugin_marketplace_service._find_installed(
                        db, user_id=user_id, plugin_id=target_id
                    )
                    target = installed.id if installed is not None else None
                else:
                    installed = (
                        db.query(Kind)
                        .filter_by(
                            user_id=user_id, kind="InstalledPlugin", namespace="default"
                        )
                        .filter(
                            Kind.json["spec"]["source"]["pluginKey"].as_string()
                            == str(target_id)
                        )
                        .first()
                    )
                    target = installed.id if installed is not None else None
                if target is not None:
                    _guard_intent_order(
                        db, user_id, instance_id, target, intent_order, advance=False
                    )
                raise HTTPException(409, "LOCAL_SYNC_DISABLED")
            return _current_result(db, user_id, previous)
        if action in {"install", "ensure_builtin"}:
            # Legacy catalog repair owns its own commit; finish it before opening
            # the atomic intent/operation transaction.
            plugin_marketplace_service.reconcile_stale_installed_catalog_refs(
                db, user_id=user_id
            )
        acquire_plugin_write_lock(db, user_id)
        existing = _replay_operation(
            db, user_id, instance_id, operation_id, request_hash
        )
        if existing is not None:
            return _current_result(db, user_id, existing)
        if action in {"update", "uninstall"}:
            _guard_intent_order(
                db, user_id, instance_id, int(target_id), intent_order, advance=False
            )
        installed: InstalledPlugin | None = None
        if action == "install":
            installed = plugin_marketplace_service.install(
                db,
                user_id=user_id,
                plugin_id=target_id,
                release_id=(payload or {}).get("releaseId"),
                commit=False,
            )
        elif action == "ensure_builtin":
            from app.services.plugin_installation_operations import (
                install_builtin_account_plugin,
            )

            installed = install_builtin_account_plugin(
                db, user_id=user_id, plugin_key=str(target_id), commit=False
            )
        elif action == "update":
            request = InstalledPluginUpdateRequest.model_validate(payload or {})
            if request.releaseId is not None:
                installed = plugin_marketplace_service.update_release(
                    db,
                    user_id=user_id,
                    installed_id=target_id,
                    release_id=request.releaseId,
                    commit=False,
                )
            else:
                installed = installed_plugin_service.update_installed_plugin(
                    db=db,
                    user_id=user_id,
                    installed_id=target_id,
                    request=request,
                    commit=False,
                )
        elif action == "uninstall":
            row = (
                db.query(Kind)
                .filter_by(
                    id=target_id,
                    user_id=user_id,
                    kind="InstalledPlugin",
                    namespace="default",
                )
                .one_or_none()
            )
            if row is None:
                raise HTTPException(404, "Installed plugin not found")
            if row.is_active:
                installed_plugin_service.uninstall_installed_plugin(
                    db=db,
                    user_id=user_id,
                    installed_id=target_id,
                    commit=False,
                )
        else:
            raise HTTPException(422, "INVALID_PLUGIN_OPERATION")
        installed_id = (
            int(installed.metadata["labels"]["id"]) if installed else target_id
        )
        _guard_intent_order(db, user_id, instance_id, int(installed_id), intent_order)
        result = installed.model_dump(mode="json") if installed else None
        state = lock_plugin_sync_state(db, user_id)
        document = deepcopy(state.json)
        slots = document.setdefault("spec", {}).setdefault("localIntents", {})
        local = slots.setdefault(instance_id, {})
        row = db.get(Kind, int(installed_id))
        local[str(installed_id)] = {
            "operationId": operation_id,
            "requestHash": request_hash,
            "installedId": int(installed_id),
            "intentOrder": intent_order,
            "installedRevision": row.json.get("spec", {}).get("revision", 0),
            "action": action,
        }
        state.json = document
        db.commit()
        return result


def _lookup_operation(
    db: Session, user_id: int, instance_id: str, operation_id: str
) -> dict[str, Any] | None:
    state = lock_plugin_sync_state(db, user_id)
    slots = state.json.get("spec", {}).get("localIntents", {}).get(instance_id, {})
    if not isinstance(slots, dict):
        raise HTTPException(409, "plugin_write_conflict")
    found = [slot for slot in slots.values() if slot.get("operationId") == operation_id]
    if len(found) > 1:
        raise HTTPException(409, "plugin_write_conflict")
    return found[0] if found else None


def _current_result(db: Session, user_id: int, slot: dict) -> dict | None:
    row = (
        db.query(Kind)
        .filter_by(
            id=slot["installedId"],
            user_id=user_id,
            kind="InstalledPlugin",
            namespace="default",
        )
        .one_or_none()
    )
    if (
        row is None
        or row.json.get("spec", {}).get("revision", 0) != slot["installedRevision"]
    ):
        raise HTTPException(409, "INTENT_SUPERSEDED")
    if slot["action"] == "uninstall":
        if row.is_active:
            raise HTTPException(409, "INTENT_SUPERSEDED")
        return None
    if not row.is_active:
        raise HTTPException(409, "INTENT_SUPERSEDED")
    return installed_plugin_service._kind_to_installed_plugin(row).model_dump(
        mode="json"
    )


def _replay_operation(
    db: Session, user_id: int, instance_id: str, operation_id: str, request_hash: str
) -> dict[str, Any] | None:
    existing = _lookup_operation(db, user_id, instance_id, operation_id)
    if existing is not None and existing["requestHash"] != request_hash:
        raise HTTPException(409, "IDEMPOTENCY_CONFLICT")
    return existing


def _guard_intent_order(
    db: Session,
    user_id: int,
    instance: str,
    installed_id: int,
    order: int,
    *,
    advance: bool = True,
) -> None:
    """Fence first-arrival replay as well as duplicate requests, under the lease.

    This watermark outlives operation retention. A rejected post-flush
    install is rolled back by run_plugin_operation together with all its writes.
    """
    state = lock_plugin_sync_state(db, user_id)
    document = deepcopy(state.json)
    orders = document.setdefault("spec", {}).setdefault("localIntentOrders", {})
    if not isinstance(orders, dict) or not isinstance(orders.get(instance, {}), dict):
        raise HTTPException(409, "plugin_write_conflict")
    local = orders.setdefault(instance, {})
    previous = local.get(str(installed_id), 0)
    if type(previous) is not int or previous < 0:
        raise HTTPException(409, "plugin_write_conflict")
    if order <= previous:
        raise HTTPException(409, "INTENT_SUPERSEDED")
    if advance:
        local[str(installed_id)] = order
        state.json = document


@contextmanager
def _rejection_context(
    db: Session, user_id: int, instance: str, operation: str, order: int | None
) -> Iterator[None]:
    """Identify only known, unaccepted business rejections for this exact request.

    Auth dependencies, transport failures, retryable errors and previously
    accepted operations cannot acquire this acknowledgement.
    """
    try:
        yield
    except HTTPException as failure:
        definitive = failure.status_code in {400, 403, 404, 422} or (
            failure.status_code == 409 and failure.detail == "INTENT_SUPERSEDED"
        )
        if definitive and type(order) is int and 0 < order < 2**63:
            # A timed-out predecessor may still be committing this same ID.
            # Serialize the proof with account writes, including failures from
            # catalog repair or validation before the normal lease acquisition.
            acquire_plugin_write_lock(db, user_id)
            with db.no_autoflush:
                accepted = _lookup_operation(db, user_id, instance, operation)
            state = lock_plugin_sync_state(db, user_id)
            orders = (
                state.json.get("spec", {})
                .get("localIntentOrders", {})
                .get(instance, {})
            )
            if not isinstance(orders, dict) or any(
                type(value) is not int for value in orders.values()
            ):
                raise HTTPException(409, "plugin_write_conflict") from failure
            # A compacted ID is not proof of nonacceptance. A strictly newer
            # order cannot have been accepted before any retained watermark.
            unaccepted = accepted is None and order > max(orders.values(), default=0)
            if unaccepted or failure.detail == "INTENT_SUPERSEDED":
                failure.headers = {
                    **(failure.headers or {}),
                    "X-Plugin-Delivery-Mode": LOCAL_DELIVERY_MODE,
                    "X-Plugin-Operation-Id": operation,
                    "X-Plugin-Intent-Order": str(order),
                    "X-Plugin-Operation-State": (
                        "superseded"
                        if failure.detail == "INTENT_SUPERSEDED"
                        else "rejected"
                    ),
                }
        raise
