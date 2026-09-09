"""Short-lived, single-use user intent for native credential enrollment."""

import json
import secrets
import time

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.device import DeviceType
from app.schemas.plugin_account_auth import (
    PluginAccountAuthDefinition,
    PluginAccountConnectionResponse,
    PluginCredentialWrite,
    PluginMigrationCreate,
    PluginMigrationResponse,
    PluginNativeEnrollment,
)
from app.services.device.runtime_route import resolve_runtime_route_identity
from app.services.plugin_account_connections import (
    CONNECTION_NAMESPACE,
    PluginAccountAuthError,
    PluginAccountConnectionService,
    plugin_account_connection_service,
)
from app.services.plugin_auth_execution import package_metadata
from shared.telemetry.decorators import trace_sync

MIGRATION_KIND = "ConnectorMigration"
MIGRATION_TTL_SECONDS = 300


class PluginAuthMigrationService:
    def __init__(self, connections: PluginAccountConnectionService):
        self.connections = connections

    @trace_sync("plugin_auth.migration.create", "backend.plugin_auth")
    def create(
        self, db: Session, *, user_id: int, request: PluginMigrationCreate
    ) -> PluginMigrationResponse:
        identity = resolve_runtime_route_identity(
            db, user_id=user_id, submitted_device_id=request.device_id
        )
        if identity is None or identity.device_type not in {
            DeviceType.LOCAL,
            DeviceType.APP,
        }:
            raise PluginAccountAuthError("plugin_auth_local_device_required", 403)
        device_id, binding = self.connections._device_binding(
            db, user_id, request.device_id
        )
        plugin, definition = self.connections._plugin(
            db, user_id, request.installed_plugin_id, request.connector_slug
        )
        if request.operation == "authorize" and "authorize" not in (
            definition.oauth2 or []
        ):
            raise PluginAccountAuthError("plugin_auth_operation_unsupported", 409)
        from app.services.plugin_auth_transfers import PluginAuthTransferService

        resumed = PluginAuthTransferService(self.connections).resume(
            db, user_id=user_id, request=request
        )
        if resumed is not None:
            return resumed
        name = secrets.token_hex(32)
        expires_at = int(time.time()) + MIGRATION_TTL_SECONDS
        db.add(
            Kind(
                kind=MIGRATION_KIND,
                namespace=CONNECTION_NAMESPACE,
                user_id=user_id,
                name=name,
                is_active=True,
                json={
                    "spec": {
                        **request.model_dump(),
                        "device_id": device_id,
                        "binding": binding,
                        "source_identity": self.connections._source_identity(
                            plugin.json["spec"]["source"]
                        ),
                        "auth_definition": definition.model_dump(exclude_none=True),
                        "expires_at": expires_at,
                    }
                },
            )
        )
        db.flush()
        return PluginMigrationResponse(id=name, expires_at=expires_at)

    @trace_sync("plugin_auth.migration.consume", "backend.plugin_auth")
    def consume(
        self,
        db: Session,
        *,
        user_id: int,
        device_id: str,
        request: PluginNativeEnrollment,
    ) -> PluginAccountConnectionResponse:
        row, _, definition = self._validated(
            db, user_id, device_id, request.migration_id
        )
        if (
            definition.exportMode == "exclusive"
            and row.json["spec"]["operation"] == "export"
        ):
            raise PluginAccountAuthError("plugin_auth_transfer_required", 409)
        query = self._query(db, user_id, request.migration_id)
        spec = row.json["spec"]
        logical_id = spec["device_id"]
        if spec.get("expected_account_id") not in (None, request.account_id):
            raise PluginAccountAuthError("plugin_auth_account_mismatch", 409)
        self._validate_credential(request, definition.credentialType)
        # Claim and enroll share one transaction. Failure rolls back the claim.
        if query.update({Kind.is_active: False}, synchronize_session=False) != 1:
            raise PluginAccountAuthError("plugin_auth_migration_expired", 403)
        if spec.get("automatic"):
            from app.services.plugin_auth_source_sync import PluginAuthSourceSync

            return PluginAuthSourceSync(self.connections).consume(
                db, user_id, spec, request
            )
        connection = self.connections.enroll(
            db,
            user_id=user_id,
            request=PluginCredentialWrite(
                installed_plugin_id=spec["installed_plugin_id"],
                connector_slug=spec["connector_slug"],
                expected_revision=spec["expected_revision"],
                account_id=request.account_id,
                account_label=request.account_label,
                credential=request.credential,
            ),
        )
        connection = self.connections.grant_device(
            db,
            user_id=user_id,
            connection_id=connection.id,
            device_id=logical_id,
            expected_revision=connection.revision,
        )

        from app.services.plugin_auth_source_sync import PluginAuthSourceSync

        sync = PluginAuthSourceSync(self.connections)
        sync.remember(
            db,
            user_id,
            connection.id,
            spec,
            sync.observation(user_id, spec, request, None),
        )
        return connection

    def _validated(
        self, db: Session, user_id: int, device_id: str, migration_id: str
    ) -> tuple[Kind, Kind, PluginAccountAuthDefinition]:
        if self._query(db, user_id, migration_id).first() is None:
            raise PluginAccountAuthError("plugin_auth_migration_expired", 403)
        self.connections._lock_owner(db, user_id)
        row = (
            self._query(db, user_id, migration_id)
            .populate_existing()
            .with_for_update()
            .first()
        )
        if row is None or row.json["spec"]["expires_at"] <= time.time():
            raise PluginAccountAuthError("plugin_auth_migration_expired", 403)
        spec = row.json["spec"]
        if spec.get("automatic"):
            from app.services.plugin_auth_automation import PluginAuthAutomationService

            self.connections._lock_owner(db, user_id)
            if not PluginAuthAutomationService(self.connections).enabled(db, user_id):
                raise PluginAccountAuthError("plugin_auth_automation_disabled", 403)
        logical_id, binding = self.connections._device_binding(db, user_id, device_id)
        if logical_id != spec["device_id"] or binding != spec["binding"]:
            raise PluginAccountAuthError("plugin_auth_migration_device_mismatch", 403)
        plugin, definition = self.connections._plugin(
            db, user_id, spec["installed_plugin_id"], spec["connector_slug"]
        )
        if (
            self.connections._source_identity(plugin.json["spec"]["source"])
            != spec["source_identity"]
            or definition.model_dump(exclude_none=True) != spec["auth_definition"]
        ):
            raise PluginAccountAuthError("plugin_auth_plugin_mismatch", 403)
        return row, plugin, definition

    @staticmethod
    def _query(db: Session, user_id: int, migration_id: str):
        return db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == MIGRATION_KIND,
            Kind.namespace == CONNECTION_NAMESPACE,
            Kind.name == migration_id,
            Kind.is_active.is_(True),
        )

    @trace_sync("plugin_auth.migration.prepare", "backend.plugin_auth")
    def prepare(
        self, db: Session, *, user_id: int, device_id: str, migration_id: str
    ) -> dict:
        from app.services.plugin_auth_transfers import PluginAuthTransferService

        transfers = PluginAuthTransferService(self.connections)
        transfer = transfers._query(db, user_id, migration_id).first()
        if transfer is not None:
            plugin, definition = transfers._validated(db, user_id, device_id, transfer)
            return {
                "package": package_metadata(
                    plugin, transfer.json["spec"]["connector_slug"], definition
                ),
                "operation": "transfer",
            }
        row, plugin, definition = self._validated(db, user_id, device_id, migration_id)
        return {
            "package": package_metadata(
                plugin, row.json["spec"]["connector_slug"], definition
            ),
            "operation": row.json["spec"]["operation"],
        }

    @staticmethod
    def _validate_credential(
        request: PluginNativeEnrollment, credential_type: str
    ) -> None:
        def unique_object(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError
                result[key] = value
            return result

        try:
            payload = json.loads(
                request.credential.get_secret_value(), object_pairs_hook=unique_object
            )
            if not isinstance(payload, dict):
                raise ValueError
            json.dumps(payload, allow_nan=False)
            fields = {
                "password": ("username", "password"),
                "bearer": ("token",),
                "oauth2": ("access_token",),
            }[credential_type]
            if any(
                not isinstance(payload.get(key), str) or not payload[key].strip()
                for key in fields
            ):
                raise ValueError
        except (ValueError, TypeError, KeyError, RecursionError):
            raise PluginAccountAuthError(
                "plugin_auth_invalid_credential", 400
            ) from None


plugin_auth_migrations = PluginAuthMigrationService(plugin_account_connection_service)
