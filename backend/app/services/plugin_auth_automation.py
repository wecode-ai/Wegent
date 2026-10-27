"""Reconcile account-owned plugin authentication on registered native devices."""

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.device import DeviceType
from app.schemas.plugin_account_auth import (
    PluginMigrationCreate,
    PluginNativeAutomationTarget,
)
from app.services.device.runtime_route import resolve_runtime_route_identity
from app.services.plugin_account_connections import (
    CONNECTION_NAMESPACE,
    PluginAccountAuthError,
    PluginAccountConnectionService,
    plugin_account_connection_service,
)
from app.services.plugin_auth_execution import package_metadata
from app.services.plugin_auth_migrations import PluginAuthMigrationService
from app.services.plugin_write_coordination import configure_auth_policy
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
        row = self._policy(db, user_id).populate_existing().first()
        return row is None or row.json.get("spec", {}).get("enabled") is True

    @trace_sync("plugin_auth.automation.configure", "backend.plugin_auth")
    def configure(self, db: Session, user_id: int, enabled: bool) -> dict:
        self.connections._coordinate_owner(db, user_id)
        configure_auth_policy(db, user_id, enabled)
        return {"enabled": enabled}

    @trace_sync("plugin_auth.automation.reconcile", "backend.plugin_auth")
    def reconcile(
        self,
        db: Session,
        *,
        user_id: int,
        device_id: str,
        installed_ids: list[int],
        prepare_only: bool = False,
        targets: list[PluginNativeAutomationTarget] | None = None,
    ) -> dict:
        self.connections._coordinate_owner(db, user_id)
        result_key = "packages" if prepare_only else "migrations"
        if not self.enabled(db, user_id):
            return {result_key: []}
        identity = resolve_runtime_route_identity(
            db, user_id=user_id, submitted_device_id=device_id
        )
        if identity is None:
            raise PluginAccountAuthError("plugin_auth_device_not_found", 404)
        self.grant_current_device(db, user_id=user_id, device_id=device_id)
        if identity.device_type not in {DeviceType.LOCAL, DeviceType.APP}:
            return {result_key: []}
        plugins = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.namespace == "default",
                Kind.kind == "InstalledPlugin",
                Kind.is_active.is_(True),
                Kind.id.in_(installed_ids),
            )
            .populate_existing()
            .order_by(Kind.id)
            .all()
        )
        result = []
        selected = (
            {(target.installed_plugin_id, target.connector_slug) for target in targets}
            if targets is not None
            else None
        )
        for plugin in plugins:
            spec = plugin.json.get("spec", {})
            if spec.get("enabled") is False:
                continue
            for connector in spec.get("components", {}).get("connectors", []):
                if not connector.get("accountAuth") or (
                    selected is not None
                    and (plugin.id, connector["slug"]) not in selected
                ):
                    continue
                try:
                    with db.begin_nested():
                        if prepare_only:
                            intent = self._preparation(
                                db, user_id, device_id, plugin, connector
                            )
                        else:
                            intent = self._intent(
                                db, user_id, device_id, plugin, connector
                            )
                except PluginAccountAuthError:
                    continue
                if intent is not None:
                    result.append(intent)
                if len(result) >= 256:
                    return {result_key: result}
        return {result_key: result}

    def _preparation(
        self, db: Session, user_id: int, device_id: str, plugin: Kind, connector: dict
    ) -> dict | None:
        if self._local_login(db, user_id, device_id, plugin, connector) is None:
            return None
        current, definition = self.connections._plugin(
            db, user_id, plugin.id, connector["slug"]
        )
        return package_metadata(current, connector["slug"], definition)

    def _intent(
        self, db: Session, user_id: int, device_id: str, plugin: Kind, connector: dict
    ) -> dict | None:
        fresh_login = self._local_login(db, user_id, device_id, plugin, connector)
        if fresh_login is None:
            return None
        intent = self.migrations.create(
            db,
            user_id=user_id,
            request=PluginMigrationCreate(
                device_id=device_id,
                installed_plugin_id=plugin.id,
                connector_slug=connector["slug"],
                expected_revision=0,
            ),
            automatic=True,
            local_login=fresh_login,
        )
        return {
            "id": intent.id,
            "installed_plugin_id": plugin.id,
            "connector_slug": connector["slug"],
        }

    def _local_login(
        self, db: Session, user_id: int, device_id: str, plugin: Kind, connector: dict
    ) -> bool | None:
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
            .filter(
                Kind.json["spec"]["sourceIdentity"].as_string() == source,
                Kind.json["spec"]["connectorSlug"].as_string() == slug,
            )
            .all()
        )
        disconnected = any(row.json["spec"]["status"] == "disconnected" for row in rows)
        logical, binding = self.connections._device_binding(db, user_id, device_id)
        fresh_login = local_login_pending(db, user_id, source, slug, logical, binding)
        if disconnected and not fresh_login:
            return None
        return fresh_login

    @trace_sync("plugin_auth.automation.grant", "backend.plugin_auth")
    def grant_current_device(
        self, db: Session, *, user_id: int, device_id: str
    ) -> None:
        self.connections._coordinate_owner(db, user_id)
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
        rows = self.connections._query(db, user_id).populate_existing().all()
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
