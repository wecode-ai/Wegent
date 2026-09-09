"""Reconcile account-owned plugin authentication on registered native devices."""

import time

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.device import DeviceType
from app.schemas.plugin_account_auth import PluginMigrationCreate
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

POLICY_KIND = "ConnectorAuthPolicy"


class PluginAuthAutomationService:
    def __init__(self, connections: PluginAccountConnectionService):
        self.connections = connections
        self.migrations = PluginAuthMigrationService(connections)

    @staticmethod
    def _policy(db: Session, user_id: int):
        return db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == POLICY_KIND,
            Kind.namespace == CONNECTION_NAMESPACE,
            Kind.name == "account",
            Kind.is_active.is_(True),
        )

    def enabled(self, db: Session, user_id: int) -> bool:
        row = self._policy(db, user_id).populate_existing().with_for_update().first()
        return row is None or row.json.get("spec", {}).get("enabled") is True

    @trace_sync("plugin_auth.automation.configure", "backend.plugin_auth")
    def configure(self, db: Session, user_id: int, enabled: bool) -> dict:
        self.connections._lock_owner(db, user_id)
        row = self._policy(db, user_id).with_for_update().first()
        if row is None:
            row = Kind(
                user_id=user_id,
                kind=POLICY_KIND,
                namespace=CONNECTION_NAMESPACE,
                name="account",
                is_active=True,
            )
            db.add(row)
        row.json = {"spec": {"enabled": enabled}}
        db.flush()
        return {"enabled": enabled}

    @trace_sync("plugin_auth.automation.reconcile", "backend.plugin_auth")
    def reconcile(
        self, db: Session, *, user_id: int, device_id: str, installed_ids: list[int]
    ) -> dict:
        self.connections._lock_owner(db, user_id)
        if not self.enabled(db, user_id):
            return {"migrations": []}
        identity = resolve_runtime_route_identity(
            db, user_id=user_id, submitted_device_id=device_id
        )
        if identity is None:
            raise PluginAccountAuthError("plugin_auth_device_not_found", 404)
        self.grant_current_device(db, user_id=user_id, device_id=device_id)
        if identity.device_type not in {DeviceType.LOCAL, DeviceType.APP}:
            return {"migrations": []}
        plugins = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.namespace == "default",
                Kind.kind == "InstalledPlugin",
                Kind.is_active.is_(True),
                Kind.id.in_(installed_ids),
            )
            .order_by(Kind.id)
            .all()
        )
        result = []
        for plugin in plugins:
            spec = plugin.json.get("spec", {})
            if spec.get("enabled") is False:
                continue
            for connector in spec.get("components", {}).get("connectors", []):
                if not connector.get("accountAuth"):
                    continue
                try:
                    with db.begin_nested():
                        intent = self._intent(db, user_id, device_id, plugin, connector)
                except PluginAccountAuthError:
                    continue
                if intent is not None:
                    result.append(intent)
                if len(result) >= 256:
                    return {"migrations": result}
        return {"migrations": result}

    def _intent(
        self, db: Session, user_id: int, device_id: str, plugin: Kind, connector: dict
    ) -> dict | None:
        slug = connector["slug"]
        source = self.connections._source_identity(plugin.json["spec"]["source"])
        from app.services.plugin_auth_local_lifecycle import (
            local_login_pending,
            local_sync_enabled,
        )

        if not local_sync_enabled(db, user_id, source, slug):
            return None
        rows = (
            self.connections._query(db, user_id)
            .populate_existing()
            .with_for_update()
            .filter(
                Kind.json["spec"]["sourceIdentity"].as_string() == source,
                Kind.json["spec"]["connectorSlug"].as_string() == slug,
            )
            .all()
        )
        disconnected = any(row.json["spec"]["status"] == "disconnected" for row in rows)
        logical, binding = self.connections._device_binding(db, user_id, device_id)
        fresh_login = local_login_pending(db, user_id, source, slug, logical, binding)
        rows = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.namespace == CONNECTION_NAMESPACE,
                Kind.kind == MIGRATION_KIND,
                Kind.is_active.is_(True),
                Kind.json["spec"]["automatic"].as_boolean().is_(True),
                Kind.json["spec"]["device_id"].as_string() == logical,
                Kind.json["spec"]["installed_plugin_id"].as_integer() == plugin.id,
                Kind.json["spec"]["connector_slug"].as_string() == slug,
            )
            .all()
        )
        for row in rows:
            spec = row.json["spec"]
            if (
                spec["expires_at"] > time.time()
                and spec["binding"] == binding
                and spec["auth_definition"] == connector["accountAuth"]
            ):
                if fresh_login and not spec.get("local_login"):
                    row.json = {"spec": {**spec, "local_login": True}}
                if disconnected and not (fresh_login or spec.get("local_login")):
                    continue
                return {
                    "id": row.name,
                    "installed_plugin_id": plugin.id,
                    "connector_slug": slug,
                }
            # Expired intents contain only public metadata and cannot be reused.
            db.delete(row)
        if disconnected and not fresh_login:
            return None
        intent = self.migrations.create(
            db,
            user_id=user_id,
            request=PluginMigrationCreate(
                device_id=device_id,
                installed_plugin_id=plugin.id,
                connector_slug=slug,
                expected_revision=0,
            ),
        )
        row = self.migrations._query(db, user_id, intent.id).first()
        if row is not None:
            row.json = {
                "spec": {
                    **row.json["spec"],
                    "automatic": True,
                    "local_login": fresh_login,
                }
            }
        db.flush()
        return {
            "id": intent.id,
            "installed_plugin_id": plugin.id,
            "connector_slug": slug,
        }

    @trace_sync("plugin_auth.automation.grant", "backend.plugin_auth")
    def grant_current_device(
        self, db: Session, *, user_id: int, device_id: str
    ) -> None:
        self.connections._lock_owner(db, user_id)
        if not self.enabled(db, user_id):
            return
        identity = resolve_runtime_route_identity(
            db, user_id=user_id, submitted_device_id=device_id
        )
        if identity is None or identity.device_type not in {
            DeviceType.CLOUD,
            DeviceType.REMOTE,
        }:
            return
        logical, binding = self.connections._device_binding(db, user_id, device_id)
        rows = (
            self.connections._query(db, user_id)
            .populate_existing()
            .with_for_update()
            .all()
        )
        for row in rows:
            spec = dict(row.json["spec"])
            if (
                spec.get("status") != "connected"
                or not spec.get("credential")
                or logical in spec.get("deviceRevocations", [])
                or logical in spec.get("deviceGrants", {})
            ):
                continue
            try:
                self.connections._validate_current_plugin(db, user_id, spec)
            except PluginAccountAuthError:
                continue
            spec["deviceGrants"] = {**spec.get("deviceGrants", {}), logical: binding}
            self.connections._advance(db, row, spec, spec["revision"])


plugin_auth_automation = PluginAuthAutomationService(plugin_account_connection_service)
