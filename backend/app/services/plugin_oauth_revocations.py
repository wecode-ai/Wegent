"""Durable, revoke-only native work after platform access has been removed."""

import secrets
import time

from sqlalchemy.orm import Session

from app.schemas.plugin_account_auth import PluginRevocationFinish
from app.services.plugin_account_connections import (
    PluginAccountAuthError,
    PluginAccountConnectionService,
    plugin_account_connection_service,
)
from app.services.plugin_auth_execution import package_metadata
from shared.telemetry.decorators import trace_sync


class PluginOAuthRevocations:
    def __init__(self, connections: PluginAccountConnectionService):
        self.connections = connections

    @trace_sync("plugin_auth.oauth.revocations", "backend.plugin_auth")
    def pending(self, db: Session, *, user_id: int, device_id: str) -> list[str]:
        logical_id, binding = self.connections._device_binding(db, user_id, device_id)
        result = []
        for row in self.connections._query(db, user_id).order_by("id").all():
            spec = row.json["spec"]
            job = spec.get("oauthRevocation") or {}
            if (
                spec["status"] != "disconnected"
                or job.get("devices", {}).get(logical_id) != binding
            ):
                continue
            if job.get("state") in {"pending", "in_flight"} and self._due(job):
                result.append(row.name)
            if len(result) >= 10:
                break
        return result

    @staticmethod
    def _due(job: dict) -> bool:
        now = time.time()
        if job.get("waitUntil", 0) > now:
            return False
        if job.get("state") == "in_flight":
            return job["leaseExpiresAt"] <= now
        return job.get("nextAttemptAt", 0) <= now

    def _locked(self, db: Session, user_id: int, connection_id: str):
        row = (
            self.connections._query(db, user_id, connection_id)
            .with_for_update()
            .populate_existing()
            .first()
        )
        if row is None:
            raise PluginAccountAuthError("plugin_auth_connection_not_found", 404)
        if row.json["spec"]["status"] != "disconnected":
            raise PluginAccountAuthError("plugin_auth_operation_mismatch", 409)
        return row

    @trace_sync("plugin_auth.oauth.revoke_begin", "backend.plugin_auth")
    def begin(
        self, db: Session, *, user_id: int, device_id: str, connection_id: str
    ) -> dict:
        row = self._locked(db, user_id, connection_id)
        spec = dict(row.json["spec"])
        job = dict(spec.get("oauthRevocation") or {})
        logical_id, binding = self.connections._device_binding(db, user_id, device_id)
        if job.get("devices", {}).get(logical_id) != binding:
            raise PluginAccountAuthError("plugin_auth_device_not_granted", 403)
        if job.get("state") not in {"pending", "in_flight"} or not self._due(job):
            return {"state": "unavailable"}
        # A missing rotation result cannot be treated as revocation of the new grant.
        if job.get("refreshOperation"):
            job["state"] = "attention"
            spec["oauthRevocation"] = job
            self.connections._advance(db, row, spec, spec["revision"])
            return {"state": "unavailable"}
        try:
            self.connections._validate_current_plugin(db, user_id, spec)
            plugin, definition = self.connections._plugin(
                db, user_id, spec["installedPluginId"], spec["connectorSlug"]
            )
        except PluginAccountAuthError:
            # Never run a replacement adapter with retained credentials. Expose a
            # recoverable state if the original package was removed or disabled.
            job["state"] = "attention"
            spec["oauthRevocation"] = job
            self.connections._advance(db, row, spec, spec["revision"])
            return {"state": "unavailable"}
        package = package_metadata(plugin, spec["connectorSlug"], definition)
        credential = self.connections._cipher_instance().decrypt(
            job["credential"], context=self.connections._context(user_id, spec)
        )
        operation_id = secrets.token_hex(32)
        spec["oauthRevocation"] = {
            **job,
            "state": "in_flight",
            "operationId": operation_id,
            "leaseExpiresAt": int(time.time()) + 90,
            "deviceId": logical_id,
            "binding": binding,
        }
        self.connections._advance(db, row, spec, spec["revision"])
        return {
            "state": "claimed",
            "connection_id": row.name,
            "operation_id": operation_id,
            "package": package,
            "credential": credential,
        }

    @trace_sync("plugin_auth.oauth.revoke_finish", "backend.plugin_auth")
    def finish(
        self,
        db: Session,
        *,
        user_id: int,
        device_id: str,
        request: PluginRevocationFinish,
    ) -> dict:
        row = self._locked(db, user_id, request.connection_id)
        spec = dict(row.json["spec"])
        job = dict(spec.get("oauthRevocation") or {})
        logical_id, binding = self.connections._device_binding(db, user_id, device_id)
        if (
            job.get("operationId") != request.operation_id
            or job.get("deviceId") != logical_id
            or job.get("binding") != binding
        ):
            raise PluginAccountAuthError("plugin_auth_operation_mismatch", 403)
        if job.get("state") == "revoked":
            return {"state": "revoked"}
        if job.get("state") != "in_flight":
            raise PluginAccountAuthError("plugin_auth_operation_mismatch", 409)
        if request.succeeded:
            # Preserve only the idempotent acknowledgement identity; erase the secret.
            job = {key: job[key] for key in ("operationId", "deviceId", "binding")}
            job["state"] = "revoked"
        else:
            attempts = job["attempts"] + 1
            job.update(
                state="attention" if attempts >= 5 else "pending",
                attempts=attempts,
                nextAttemptAt=int(time.time()) + min(600, 15 * 2**attempts),
            )
        spec["oauthRevocation"] = job
        self.connections._advance(db, row, spec, spec["revision"])
        return {"state": job["state"]}

    @trace_sync("plugin_auth.oauth.revoke_retry", "backend.plugin_auth")
    def retry(
        self,
        db: Session,
        *,
        user_id: int,
        connection_id: str,
        device_id: str,
        expected_revision: int,
    ):
        row = self._locked(db, user_id, connection_id)
        spec = dict(row.json["spec"])
        job = dict(spec.get("oauthRevocation") or {})
        if job.get("state") not in {"pending", "attention", "in_flight"}:
            raise PluginAccountAuthError("plugin_auth_operation_unsupported", 409)
        if job.get("state") == "in_flight" and not self._due(job):
            raise PluginAccountAuthError("plugin_auth_revocation_in_progress", 409)
        if job.get("refreshOperation"):
            raise PluginAccountAuthError("plugin_auth_provider_action_required", 409)
        logical_id, binding = self.connections._device_binding(db, user_id, device_id)
        self.connections._validate_current_plugin(db, user_id, spec)
        job.update(
            state="pending",
            attempts=0,
            nextAttemptAt=int(time.time()),
            devices={**job.get("devices", {}), logical_id: binding},
        )
        # Invalidate an old, expired worker before another device can claim it.
        job.pop("operationId", None)
        spec["oauthRevocation"] = job
        self.connections._advance(db, row, spec, expected_revision)
        return self.connections._response(row)

    @trace_sync("plugin_auth.oauth.revoke_confirm", "backend.plugin_auth")
    def confirm_external(
        self, db: Session, *, user_id: int, connection_id: str, expected_revision: int
    ):
        row = self._locked(db, user_id, connection_id)
        spec = dict(row.json["spec"])
        if (spec.get("oauthRevocation") or {}).get("state") not in {
            "attention",
            "unsupported",
        }:
            raise PluginAccountAuthError("plugin_auth_operation_unsupported", 409)
        # User attestation is distinct from a provider-confirmed native result.
        spec["oauthRevocation"] = {"state": "confirmed"}
        self.connections._advance(db, row, spec, expected_revision)
        return self.connections._response(row)


plugin_oauth_revocations = PluginOAuthRevocations(plugin_account_connection_service)
