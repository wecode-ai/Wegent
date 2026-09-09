"""Platform-owned, single-use refresh leases executed by native provider adapters."""

import json
import secrets
import time

from sqlalchemy.orm import Session

from app.schemas.plugin_account_auth import PluginNativeExecution, PluginOAuthFinish
from app.services.plugin_account_connections import PluginAccountAuthError
from app.services.plugin_auth_execution import (
    PluginAuthExecutionService,
    plugin_auth_execution,
)
from app.services.plugin_oauth_credentials import requires_refresh, token_payload
from shared.telemetry.decorators import trace_sync


class PluginOAuthOperations:
    def __init__(self, execution: PluginAuthExecutionService):
        self.execution = execution
        self.connections = execution.connections

    @trace_sync("plugin_auth.oauth.begin", "backend.plugin_auth")
    def begin(
        self,
        db: Session,
        *,
        user_id: int,
        device_id: str,
        request: PluginNativeExecution,
    ) -> dict:
        self.connections._lock_owner(db, user_id)
        package, connection, credential = self.execution.resolve(
            db, user_id=user_id, device_id=device_id, request=request
        )
        from app.services.plugin_auth_transfers import require_no_pending_transfer

        connection_row = self.connections._get(db, user_id, connection.id, lock=True)
        connection_spec = connection_row.json["spec"]
        require_no_pending_transfer(
            db,
            user_id,
            connection_spec["sourceIdentity"],
            request.connector_slug,
            connection.account_id,
        )
        definition = package["auth_definition"]
        if definition["credentialType"] != "oauth2" or "refresh" not in (
            definition.get("oauth2") or []
        ):
            raise PluginAccountAuthError("plugin_auth_operation_unsupported", 409)
        payload = token_payload(credential)
        if not requires_refresh(payload):
            return {"state": "ready"}
        if (
            not isinstance(payload.get("refresh_token"), str)
            or not payload["refresh_token"]
        ):
            raise PluginAccountAuthError("plugin_auth_reconnect_required", 409)
        row = (
            self.connections._query(db, user_id, connection.id)
            .with_for_update()
            .populate_existing()
            .one()
        )
        spec = dict(row.json["spec"])
        if spec["revision"] != connection.revision:
            raise PluginAccountAuthError("plugin_auth_revision_conflict", 409)
        operation = spec.get("oauthRefresh") or {}
        if (
            operation.get("state") == "in_flight"
            and operation["expiresAt"] > time.time()
        ):
            raise PluginAccountAuthError("plugin_auth_refresh_in_progress", 409)
        if operation.get("state") in {"in_flight", "uncertain"}:
            raise PluginAccountAuthError("plugin_auth_reconnect_required", 409)
        logical_id, binding = self.connections._device_binding(db, user_id, device_id)
        operation_id = secrets.token_hex(32)
        spec["oauthRefresh"] = {
            "id": operation_id,
            "state": "in_flight",
            "deviceId": logical_id,
            "binding": binding,
            "expiresAt": int(time.time()) + 90,
        }
        self.connections._advance(db, row, spec, connection.revision)
        return {
            "state": "claimed",
            "operation_id": operation_id,
            "connection_id": connection.id,
            "package": package,
            "credential": credential.get_secret_value(),
        }

    @trace_sync("plugin_auth.oauth.finish", "backend.plugin_auth")
    def finish(
        self, db: Session, *, user_id: int, device_id: str, request: PluginOAuthFinish
    ) -> dict:
        row = (
            self.connections._query(db, user_id, request.connection_id)
            .with_for_update()
            .populate_existing()
            .first()
        )
        if row is None:
            raise PluginAccountAuthError("plugin_auth_connection_not_found", 404)
        spec = dict(row.json["spec"])
        operation = spec.get("oauthRefresh") or {}
        logical_id, binding = self.connections._device_binding(db, user_id, device_id)
        if (
            operation.get("id") != request.operation_id
            or operation.get("deviceId") != logical_id
            or operation.get("binding") != binding
        ):
            raise PluginAccountAuthError("plugin_auth_operation_mismatch", 403)
        if operation["state"] == "finished":
            return {"state": "finished"}
        revocation = dict(spec.get("oauthRevocation") or {})
        revoking = (
            spec["status"] == "disconnected"
            and revocation.get("state") in {"pending", "attention"}
            and revocation.get("refreshOperation") == request.operation_id
        )
        if not revoking:
            self.connections._require_connected(spec)
            self.connections._validate_current_plugin(db, user_id, spec)
        if operation["state"] != "in_flight" or (
            not revoking and operation["expiresAt"] <= time.time()
        ):
            raise PluginAccountAuthError("plugin_auth_reconnect_required", 409)
        if request.succeeded:
            payload = token_payload(request.credential)
            if (
                request.account_id != spec["accountId"]
                or requires_refresh(payload)
                or "expires_at" not in payload
                or not isinstance(payload.get("refresh_token"), str)
                or not payload["refresh_token"]
            ):
                raise PluginAccountAuthError("plugin_auth_invalid_refresh_result", 400)
            encrypted = self.connections._cipher_instance().encrypt(
                json.dumps(payload), context=self.connections._context(user_id, spec)
            )
            if revoking:
                revocation["credential"] = encrypted
            else:
                spec["credential"] = encrypted
        if revoking:
            known_token = request.succeeded or not request.attempted
            revocation.update(
                state="pending" if known_token else "attention",
                waitUntil=0,
                refreshOperation=None if known_token else request.operation_id,
            )
            spec["oauthRevocation"] = revocation
        spec["oauthRefresh"] = {
            **operation,
            "state": (
                "finished"
                if request.succeeded
                else ("uncertain" if request.attempted else "cancelled")
            ),
        }
        self.connections._advance(db, row, spec, spec["revision"])
        return {"state": spec["oauthRefresh"]["state"]}


plugin_oauth_operations = PluginOAuthOperations(plugin_auth_execution)
