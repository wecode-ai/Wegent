"""Durable escrow for moving a CLI's exclusive OAuth refresh ownership.

Staging never creates a usable connection. Only the source native device may
confirm that its adapter durably detached the old store, then activate escrow.
An interrupted transfer stays encrypted and reserved until resumed explicitly.
"""

import json
from copy import deepcopy

from pydantic import SecretStr
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.plugin_account_auth import (
    PluginAccountConnectionResponse,
    PluginCredentialWrite,
    PluginMigrationCreate,
    PluginMigrationResponse,
    PluginNativeEnrollment,
)
from app.services.plugin_account_connections import (
    CONNECTION_NAMESPACE,
    PluginAccountAuthError,
    PluginAccountConnectionService,
    plugin_account_connection_service,
)
from app.services.plugin_auth_execution import package_metadata
from app.services.plugin_auth_migrations import PluginAuthMigrationService
from app.services.plugin_oauth_credentials import token_payload
from shared.telemetry.decorators import trace_sync

TRANSFER_KIND = "ConnectorTransfer"


def require_no_pending_transfer(
    db: Session, user_id: int, source: str, connector: str, account: str
) -> None:
    """Called under the enrollment owner lock, before any credential replacement."""
    pending = (
        db.query(Kind.id)
        .filter(
            Kind.user_id == user_id,
            Kind.namespace == CONNECTION_NAMESPACE,
            Kind.kind == TRANSFER_KIND,
            Kind.is_active.is_(True),
            Kind.json["spec"]["source_identity"].as_string() == source,
            Kind.json["spec"]["connector_slug"].as_string() == connector,
            Kind.json["spec"]["account_id"].as_string() == account,
        )
        .with_for_update()
        .first()
    )
    if pending:
        raise PluginAccountAuthError("plugin_auth_transfer_pending", 409)


class PluginAuthTransferService:
    def __init__(self, connections: PluginAccountConnectionService):
        self.connections = connections
        self.migrations = PluginAuthMigrationService(connections)

    def resume(
        self, db: Session, *, user_id: int, request: PluginMigrationCreate
    ) -> PluginMigrationResponse | None:
        """An explicit UI action may rebind escrow to a restarted source runtime."""
        self.connections._lock_owner(db, user_id)
        logical, binding = self.connections._device_binding(
            db, user_id, request.device_id
        )
        rows = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.namespace == CONNECTION_NAMESPACE,
                Kind.kind == TRANSFER_KIND,
                Kind.is_active.is_(True),
                Kind.json["spec"]["installed_plugin_id"].as_integer()
                == request.installed_plugin_id,
                Kind.json["spec"]["connector_slug"].as_string()
                == request.connector_slug,
            )
            .populate_existing()
            .with_for_update()
            .all()
        )
        matching = [row for row in rows if row.json["spec"]["device_id"] == logical]
        if not matching:
            return None
        if len(matching) != 1 or request.operation != "export":
            raise PluginAccountAuthError("plugin_auth_transfer_pending", 409)
        row = matching[0]
        spec = deepcopy(row.json["spec"])
        if any(
            binding[key] != spec["binding"][key]
            for key in ("deviceRowId", "runtimeDeviceId")
        ):
            raise PluginAccountAuthError("plugin_auth_migration_device_mismatch", 403)
        if request.expected_account_id not in (None, spec["account_id"]):
            raise PluginAccountAuthError("plugin_auth_account_mismatch", 409)
        if spec.get("automatic"):
            from app.services.plugin_auth_source_sync import PluginAuthSourceSync

            target = PluginAuthSourceSync(self.connections).target(
                db, user_id, spec, spec["account_id"]
            )
            revision = target.json["spec"]["revision"] if target else 0
        else:
            revision = request.expected_revision
        spec.update(binding=binding, expected_revision=revision)
        self._check_target(db, user_id, spec, spec["account_id"])
        row.json = {"spec": spec}
        self._validated(db, user_id, logical, row)
        db.flush()
        return PluginMigrationResponse(id=row.name, expires_at=spec["expires_at"])

    @trace_sync("plugin_auth.transfer.stage", "backend.plugin_auth")
    def stage(
        self,
        db: Session,
        *,
        user_id: int,
        device_id: str,
        request: PluginNativeEnrollment,
    ) -> dict:
        self.connections._lock_owner(db, user_id)
        existing = self._query(db, user_id, request.migration_id).first()
        if existing is not None:
            self._validated(db, user_id, device_id, existing)
            if existing.json["spec"]["account_id"] != request.account_id:
                raise PluginAccountAuthError("plugin_auth_account_mismatch", 409)
            # An uncertain stage acknowledgement must never overwrite escrow.
            return {"state": existing.json["spec"]["state"]}
        migration, plugin, definition = self.migrations._validated(
            db, user_id, device_id, request.migration_id
        )
        spec = deepcopy(migration.json["spec"])
        package_metadata(plugin, spec["connector_slug"], definition)
        if definition.exportMode != "exclusive" or spec["operation"] != "export":
            raise PluginAccountAuthError("plugin_auth_operation_unsupported", 409)
        if spec.get("expected_account_id") not in (None, request.account_id):
            raise PluginAccountAuthError("plugin_auth_account_mismatch", 409)
        self.migrations._validate_credential(request, "oauth2")
        token_payload(request.credential)
        require_no_pending_transfer(
            db,
            user_id,
            spec["source_identity"],
            spec["connector_slug"],
            request.account_id,
        )
        if spec.get("automatic"):
            from app.services.plugin_auth_source_sync import PluginAuthSourceSync

            sync = PluginAuthSourceSync(self.connections)
            target = sync.target(db, user_id, spec, request.account_id)
            previous = (
                target.json["spec"].get("localAuthSources", {}).get(spec["device_id"])
                if target
                else None
            )
            spec["source_observation"] = sync.observation(
                user_id, spec, request, previous
            )
            if previous == spec["source_observation"]:
                raise PluginAccountAuthError("plugin_auth_source_unchanged", 409)
            spec["expected_revision"] = target.json["spec"]["revision"] if target else 0
        # Validate the target revision and pending revocation before the adapter
        # can detach its source store. No connection/grant is written here.
        self._check_target(db, user_id, spec, request.account_id)
        spec.update(
            account_id=request.account_id,
            account_label=request.account_label,
            state="staged",
        )
        spec["credential"] = self.connections._cipher_instance().encrypt(
            request.credential.get_secret_value(),
            context=self._context(user_id, request.migration_id, spec),
        )
        claimed = self.migrations._query(db, user_id, request.migration_id).update(
            {Kind.is_active: False}, synchronize_session=False
        )
        if claimed != 1:
            raise PluginAccountAuthError("plugin_auth_migration_expired", 403)
        db.add(
            Kind(
                user_id=user_id,
                namespace=CONNECTION_NAMESPACE,
                kind=TRANSFER_KIND,
                name=request.migration_id,
                is_active=True,
                json={"spec": spec},
            )
        )
        db.flush()
        return {"state": "staged"}

    @trace_sync("plugin_auth.transfer.prepare", "backend.plugin_auth")
    def prepare(
        self, db: Session, *, user_id: int, device_id: str, migration_id: str
    ) -> dict:
        self.connections._lock_owner(db, user_id)
        row = self._get(db, user_id, migration_id)
        plugin, definition = self._validated(db, user_id, device_id, row)
        spec = row.json["spec"]
        if spec["state"] == "completed":
            return {"state": "completed"}
        credential = self.connections._cipher_instance().decrypt(
            spec["credential"], context=self._context(user_id, migration_id, spec)
        )
        return {
            "state": "staged",
            "package": package_metadata(plugin, spec["connector_slug"], definition),
            "account_id": spec["account_id"],
            "credential": credential,
        }

    @trace_sync("plugin_auth.transfer.finish", "backend.plugin_auth")
    def finish(
        self,
        db: Session,
        *,
        user_id: int,
        device_id: str,
        migration_id: str,
    ) -> PluginAccountConnectionResponse:
        """Native-only confirmation after the source adapter's durable detach."""
        self.connections._lock_owner(db, user_id)
        row = self._get(db, user_id, migration_id)
        self._validated(db, user_id, device_id, row)
        spec = deepcopy(row.json["spec"])
        if spec["state"] == "completed":
            connection = self.connections._get(
                db, user_id, spec["connection_id"], lock=True
            )
            return self.connections._response(connection)
        credential = self.connections._cipher_instance().decrypt(
            spec["credential"], context=self._context(user_id, migration_id, spec)
        )
        # Reservation release, credential activation and escrow cleanup are one
        # transaction. The caller must roll back on any failed finalization.
        row.is_active = False
        db.flush()
        connection = self.connections.enroll(
            db,
            user_id=user_id,
            request=PluginCredentialWrite(
                installed_plugin_id=spec["installed_plugin_id"],
                connector_slug=spec["connector_slug"],
                expected_revision=spec["expected_revision"],
                account_id=spec["account_id"],
                account_label=spec["account_label"],
                credential=SecretStr(credential),
            ),
        )
        connection = self.connections.grant_device(
            db,
            user_id=user_id,
            connection_id=connection.id,
            device_id=spec["device_id"],
            expected_revision=connection.revision,
        )
        from app.services.plugin_auth_source_sync import PluginAuthSourceSync

        sync = PluginAuthSourceSync(self.connections)
        observation = spec.pop("source_observation", None) or sync.observation(
            user_id,
            spec,
            PluginNativeEnrollment(
                migration_id=migration_id,
                account_id=spec["account_id"],
                credential=SecretStr(credential),
            ),
            None,
        )
        sync.remember(db, user_id, connection.id, spec, observation)
        spec.pop("credential")
        spec.update(state="completed", connection_id=connection.id)
        row.json = {"spec": spec}
        db.flush()
        return connection

    @trace_sync("plugin_auth.transfer.abort", "backend.plugin_auth")
    def abort(
        self, db: Session, *, user_id: int, device_id: str, migration_id: str
    ) -> dict:
        """Native-only receipt: the adapter durably fenced off this transfer ID."""
        self.connections._lock_owner(db, user_id)
        row = self._get(db, user_id, migration_id)
        self._validated(db, user_id, device_id, row, allow_aborted=True)
        spec = deepcopy(row.json["spec"])
        if spec["state"] == "completed":
            raise PluginAccountAuthError("plugin_auth_transfer_completed", 409)
        spec.pop("credential", None)
        spec["state"] = "aborted"
        row.is_active = False
        row.json = {"spec": spec}
        db.flush()
        return {"state": "aborted"}

    def _check_target(self, db: Session, user_id: int, spec: dict, account: str):
        rows = (
            self.connections._query(db, user_id)
            .populate_existing()
            .with_for_update()
            .all()
        )
        previous = next(
            (
                row.json["spec"]
                for row in rows
                if row.json["spec"]["sourceIdentity"] == spec["source_identity"]
                and row.json["spec"]["connectorSlug"] == spec["connector_slug"]
                and row.json["spec"]["accountId"] == account
            ),
            {},
        )
        if previous.get("revision", 0) != spec["expected_revision"]:
            raise PluginAccountAuthError("plugin_auth_revision_conflict", 409)
        if previous.get("status") == "connected" and not spec.get("automatic"):
            raise PluginAccountAuthError("plugin_auth_disconnect_required", 409)
        if (previous.get("oauthRevocation") or {}).get("state") in {
            "pending",
            "in_flight",
            "attention",
        }:
            raise PluginAccountAuthError("plugin_auth_revocation_pending", 409)

    def _validated(
        self,
        db: Session,
        user_id: int,
        device_id: str,
        row: Kind,
        *,
        allow_aborted: bool = False,
    ):
        spec = row.json["spec"]
        logical, binding = self.connections._device_binding(db, user_id, device_id)
        if logical != spec["device_id"] or binding != spec["binding"]:
            raise PluginAccountAuthError("plugin_auth_migration_device_mismatch", 403)
        if spec["state"] == "aborted" and not allow_aborted:
            raise PluginAccountAuthError("plugin_auth_source_changed", 409)
        plugin, definition = self.connections._plugin(
            db, user_id, spec["installed_plugin_id"], spec["connector_slug"]
        )
        if (
            self.connections._source_identity(plugin.json["spec"]["source"])
            != spec["source_identity"]
            or definition.model_dump(exclude_none=True) != spec["auth_definition"]
        ):
            raise PluginAccountAuthError("plugin_auth_plugin_mismatch", 403)
        return plugin, definition

    @staticmethod
    def _query(db: Session, user_id: int, migration_id: str):
        return (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.namespace == CONNECTION_NAMESPACE,
                Kind.kind == TRANSFER_KIND,
                Kind.name == migration_id,
            )
            .populate_existing()
            .with_for_update()
        )

    def _get(self, db: Session, user_id: int, migration_id: str) -> Kind:
        row = self._query(db, user_id, migration_id).first()
        if row is None:
            raise PluginAccountAuthError("plugin_auth_transfer_not_found", 404)
        return row

    @staticmethod
    def _context(user_id: int, migration_id: str, spec: dict) -> str:
        return json.dumps(
            [
                "transfer",
                user_id,
                migration_id,
                spec["source_identity"],
                spec["connector_slug"],
                spec["account_id"],
                spec["auth_definition"],
            ],
            sort_keys=True,
            separators=(",", ":"),
        )


plugin_auth_transfers = PluginAuthTransferService(plugin_account_connection_service)
