"""Connect the existing local login entry to account-owned authentication."""

import hashlib
import time

from sqlalchemy.orm import Query, Session

from app.models.kind import Kind
from app.schemas.device import DeviceType
from app.schemas.plugin_account_auth import (
    PluginMigrationCreate,
    PluginNativeLocalLifecycle,
)
from app.services.device.runtime_route import resolve_runtime_route_identity
from app.services.plugin_account_connections import (
    CONNECTION_NAMESPACE,
    PluginAccountAuthError,
    PluginAccountConnectionService,
    plugin_account_connection_service,
)
from app.services.plugin_auth_migrations import (
    MIGRATION_KIND,
    PluginAuthMigrationService,
)
from shared.telemetry.decorators import trace_sync

LOCAL_POLICY_KIND = "ConnectorLocalAuthPolicy"


def policy_query(db: Session, user_id: int, source: str, slug: str) -> Query:
    name = hashlib.sha256(f"{source}\n{slug}".encode()).hexdigest()
    return db.query(Kind).filter(
        Kind.user_id == user_id,
        Kind.namespace == CONNECTION_NAMESPACE,
        Kind.kind == LOCAL_POLICY_KIND,
        Kind.name == name,
        Kind.is_active.is_(True),
    )


def local_sync_enabled(db: Session, user_id: int, source: str, slug: str) -> bool:
    row = policy_query(db, user_id, source, slug).populate_existing().first()
    return row is None or row.json["spec"]["enabled"] is True


def local_login_pending(
    db: Session, user_id: int, source: str, slug: str, logical: str, binding: dict
) -> bool:
    row = policy_query(db, user_id, source, slug).populate_existing().first()
    return (
        row is not None
        and row.json["spec"].get("pendingLogins", {}).get(logical) == binding
    )


def finish_local_login(db: Session, user_id: int, source: dict) -> None:
    row = (
        policy_query(db, user_id, source["source_identity"], source["connector_slug"])
        .with_for_update()
        .first()
    )
    if row is None:
        return
    spec = dict(row.json["spec"])
    pending = dict(spec.get("pendingLogins", {}))
    if pending.get(source["device_id"]) == source["binding"]:
        pending.pop(source["device_id"])
        row.json = {"spec": {**spec, "pendingLogins": pending}}
        db.flush()


class PluginAuthLocalLifecycleService:
    def __init__(self, connections: PluginAccountConnectionService):
        self.connections = connections
        self.migrations = PluginAuthMigrationService(connections)

    @trace_sync("plugin_auth.local_lifecycle", "backend.plugin_auth")
    def exchange(
        self,
        db: Session,
        *,
        user_id: int,
        device_id: str,
        request: PluginNativeLocalLifecycle,
    ) -> dict:
        identity = resolve_runtime_route_identity(
            db, user_id=user_id, submitted_device_id=device_id
        )
        if identity is None or identity.device_type not in {
            DeviceType.LOCAL,
            DeviceType.APP,
        }:
            raise PluginAccountAuthError("plugin_auth_local_device_required", 403)
        self.connections._lock_owner(db, user_id)
        plugin, _ = self.connections._plugin(
            db, user_id, request.installed_plugin_id, request.connector_slug
        )
        connector = next(
            item
            for item in plugin.json["spec"]["components"]["connectors"]
            if item["slug"] == request.connector_slug
        )
        if not connector.get("localAuth"):
            raise PluginAccountAuthError("plugin_auth_not_supported", 422)
        source = self.connections._source_identity(plugin.json["spec"]["source"])
        rows = (
            self.connections._query(db, user_id)
            .populate_existing()
            .with_for_update()
            .filter(
                Kind.json["spec"]["sourceIdentity"].as_string() == source,
                Kind.json["spec"]["connectorSlug"].as_string()
                == request.connector_slug,
            )
            .all()
        )
        if request.action == "status":
            return self._status(
                db, user_id, device_id, source, request.connector_slug, rows
            )
        if request.action == "logout":
            self._logout(db, user_id, device_id, source, request.connector_slug, rows)
            return {"status": "ok"}
        self._login(db, user_id, device_id, source, request)
        return {"status": "ok"}

    def _status(
        self,
        db: Session,
        user_id: int,
        device_id: str,
        source: str,
        slug: str,
        rows: list[Kind],
    ) -> dict:
        if not local_sync_enabled(db, user_id, source, slug):
            return {"status": "need_login"}
        logical, binding = self.connections._device_binding(db, user_id, device_id)
        for row in rows:
            spec = row.json["spec"]
            if (
                spec["status"] == "connected"
                and spec["deviceGrants"].get(logical) == binding
            ):
                self.connections._validate_current_plugin(db, user_id, spec)
                if (spec.get("oauthRefresh") or {}).get("state") == "uncertain":
                    return {"status": "need_login"}
                return {"status": "ok"}
        return {"status": "need_login" if rows else None}

    def _set_policy(
        self, db: Session, user_id: int, source: str, slug: str, enabled: bool
    ) -> None:
        row = policy_query(db, user_id, source, slug).with_for_update().first()
        if row is None:
            row = Kind(
                user_id=user_id,
                kind=LOCAL_POLICY_KIND,
                namespace=CONNECTION_NAMESPACE,
                name=hashlib.sha256(f"{source}\n{slug}".encode()).hexdigest(),
                is_active=True,
            )
            db.add(row)
        previous = (row.json or {}).get("spec", {})
        row.json = {
            "spec": {
                "enabled": enabled,
                "pendingLogins": previous.get("pendingLogins", {}) if enabled else {},
            }
        }
        db.flush()

    @staticmethod
    def _intents(db: Session, user_id: int, source: str, slug: str) -> Query:
        return db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.namespace == CONNECTION_NAMESPACE,
            Kind.kind == MIGRATION_KIND,
            Kind.is_active.is_(True),
            Kind.json["spec"]["source_identity"].as_string() == source,
            Kind.json["spec"]["connector_slug"].as_string() == slug,
        )

    def _logout(
        self,
        db: Session,
        user_id: int,
        device_id: str,
        source: str,
        slug: str,
        rows: list[Kind],
    ) -> None:
        from app.services.plugin_auth_transfers import TRANSFER_KIND

        # An escrow may already have detached its source. Let its existing
        # recovery finish before logout; never discard the only refresh owner.
        pending = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.namespace == CONNECTION_NAMESPACE,
                Kind.kind == TRANSFER_KIND,
                Kind.is_active.is_(True),
                Kind.json["spec"]["source_identity"].as_string() == source,
                Kind.json["spec"]["connector_slug"].as_string() == slug,
            )
            .first()
        )
        if pending is not None:
            raise PluginAccountAuthError("plugin_auth_transfer_pending", 409)
        self._set_policy(db, user_id, source, slug, False)
        self._intents(db, user_id, source, slug).update(
            {Kind.is_active: False}, synchronize_session=False
        )
        for row in rows:
            if row.json["spec"]["status"] == "connected":
                self.connections.disconnect(
                    db,
                    user_id=user_id,
                    connection_id=row.name,
                    device_id=device_id,
                    expected_revision=row.json["spec"]["revision"],
                )

    def _login(
        self,
        db: Session,
        user_id: int,
        device_id: str,
        source: str,
        request: PluginNativeLocalLifecycle,
    ) -> None:
        logical, binding = self.connections._device_binding(db, user_id, device_id)
        self._set_policy(db, user_id, source, request.connector_slug, True)
        policy = policy_query(db, user_id, source, request.connector_slug).first()
        policy.json = {
            "spec": {
                **policy.json["spec"],
                "pendingLogins": {
                    **policy.json["spec"].get("pendingLogins", {}),
                    logical: binding,
                },
            }
        }
        db.flush()
        for row in self._intents(db, user_id, source, request.connector_slug).all():
            spec = row.json["spec"]
            if (
                spec.get("local_login")
                and spec["binding"] == binding
                and spec["expires_at"] > time.time()
            ):
                return
        intent = self.migrations.create(
            db,
            user_id=user_id,
            request=PluginMigrationCreate(
                installed_plugin_id=request.installed_plugin_id,
                connector_slug=request.connector_slug,
                device_id=device_id,
                expected_revision=0,
            ),
        )
        row = self.migrations._query(db, user_id, intent.id).first()
        if row is not None:
            row.json = {
                "spec": {**row.json["spec"], "automatic": True, "local_login": True}
            }
        db.flush()


plugin_auth_local_lifecycle = PluginAuthLocalLifecycleService(
    plugin_account_connection_service
)
