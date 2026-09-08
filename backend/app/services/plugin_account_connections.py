"""Account plugin connections, isolated from device startup and package sync.

Secret reads are an internal boundary. No HTTP or model tool exports credentials.
Callers must authenticate the runtime before invoking read_for_device.
"""

import hashlib
import json
import time
from typing import Any

from pydantic import SecretStr
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.schemas.plugin_account_auth import (
    PluginAccountAuthDefinition,
    PluginAccountConnectionResponse,
    PluginCredentialWrite,
)
from app.services.device.identity import record_id_from_route
from app.services.device.runtime_route import resolve_runtime_route_identity
from app.services.plugin_credential_cipher import PluginCredentialCipher
from shared.telemetry.decorators import trace_sync

CONNECTION_KIND = "ConnectorConnection"
CONNECTION_NAMESPACE = "plugin-auth"


class PluginAccountAuthError(RuntimeError):
    """Stable errors contain no credential values or upstream error bodies."""

    def __init__(self, code: str, status_code: int = 409):
        super().__init__(code)
        self.code = code
        self.status_code = status_code


class PluginAccountConnectionService:
    def __init__(self, cipher: PluginCredentialCipher | None = None):
        self._cipher = cipher

    def _cipher_instance(self) -> PluginCredentialCipher:
        return self._cipher or PluginCredentialCipher.from_environment()

    @trace_sync("plugin_auth.enroll", "backend.plugin_auth")
    def enroll(
        self, db: Session, *, user_id: int, request: PluginCredentialWrite
    ) -> PluginAccountConnectionResponse:
        """Store a migrated credential; updates require the observed revision."""
        plugin, definition = self._plugin(
            db, user_id, request.installed_plugin_id, request.connector_slug
        )
        source = plugin.json["spec"]["source"]
        identity = self._source_identity(source)
        name = hashlib.sha256(
            json.dumps(
                [identity, request.connector_slug, request.account_id],
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        # Serialize first enrollment, since Kind has no unique name constraint.
        # MySQL holds this lock until the caller commits or rolls back.
        self._lock_owner(db, user_id)
        from app.services.plugin_auth_transfers import require_no_pending_transfer

        require_no_pending_transfer(
            db, user_id, identity, request.connector_slug, request.account_id
        )
        # A locking read observes the latest committed state even when earlier
        # request authentication established a MySQL REPEATABLE READ snapshot.
        row = (
            self._query(db, user_id, name).populate_existing().with_for_update().first()
        )
        previous = dict(row.json["spec"]) if row else {}
        if (previous.get("oauthRevocation") or {}).get("state") in {
            "pending",
            "in_flight",
            "attention",
        }:
            raise PluginAccountAuthError("plugin_auth_revocation_pending", 409)
        if request.expected_revision != previous.get("revision", 0):
            raise PluginAccountAuthError("plugin_auth_revision_conflict")
        spec = {
            "installedPluginId": plugin.id,
            "pluginKey": str(source["pluginKey"]),
            "sourceIdentity": identity,
            "connectorSlug": request.connector_slug,
            "accountId": request.account_id,
            "accountLabel": request.account_label,
            "credentialType": definition.credentialType,
            "authDefinition": definition.model_dump(exclude_none=True),
            "status": "connected",
            "revision": request.expected_revision + 1,
            "deviceRevocations": previous.get("deviceRevocations", []),
            "localAuthSources": previous.get("localAuthSources", {}),
            "deviceGrants": (
                previous.get("deviceGrants", {})
                if previous.get("authDefinition")
                == definition.model_dump(exclude_none=True)
                else {}
            ),
        }
        spec["credential"] = self._cipher_instance().encrypt(
            request.credential.get_secret_value(), context=self._context(user_id, spec)
        )
        if row is None:
            row = Kind(
                user_id=user_id,
                kind=CONNECTION_KIND,
                namespace=CONNECTION_NAMESPACE,
                name=name,
                json={"spec": spec},
                is_active=True,
            )
            db.add(row)
            db.flush()
        else:
            self._replace(db, row, spec, request.expected_revision)
        return self._response(row)

    def list_connections(
        self, db: Session, *, user_id: int
    ) -> list[PluginAccountConnectionResponse]:
        return [
            self._response(row)
            for row in self._query(db, user_id).order_by(Kind.id).all()
        ]

    @trace_sync("plugin_auth.grant_device", "backend.plugin_auth")
    def grant_device(
        self,
        db: Session,
        *,
        user_id: int,
        connection_id: str,
        device_id: str,
        expected_revision: int,
    ) -> PluginAccountConnectionResponse:
        self._get(db, user_id, connection_id)
        self._lock_owner(db, user_id)
        row = self._get(db, user_id, connection_id, lock=True)
        spec = dict(row.json["spec"])
        self._require_connected(spec)
        self._validate_current_plugin(db, user_id, spec)
        logical_id, binding = self._device_binding(db, user_id, device_id)
        grants = dict(spec["deviceGrants"])
        grants[logical_id] = binding
        spec["deviceRevocations"] = [
            item for item in spec.get("deviceRevocations", []) if item != logical_id
        ]
        spec["deviceGrants"] = grants
        self._advance(db, row, spec, expected_revision)
        return self._response(row)

    @trace_sync("plugin_auth.revoke_device", "backend.plugin_auth")
    def revoke_device(
        self,
        db: Session,
        *,
        user_id: int,
        connection_id: str,
        device_id: str,
        expected_revision: int,
    ) -> PluginAccountConnectionResponse:
        self._get(db, user_id, connection_id)
        self._lock_owner(db, user_id)
        row = self._get(db, user_id, connection_id, lock=True)
        spec = dict(row.json["spec"])
        grants = dict(spec["deviceGrants"])
        # Use the persisted logical ID so deleted/offline devices remain revocable.
        grants.pop(device_id, None)
        spec["deviceRevocations"] = sorted(
            set(spec.get("deviceRevocations", [])) | {device_id}
        )
        spec["deviceGrants"] = grants
        self._advance(db, row, spec, expected_revision)
        return self._response(row)

    @trace_sync("plugin_auth.disconnect", "backend.plugin_auth")
    def disconnect(
        self,
        db: Session,
        *,
        user_id: int,
        connection_id: str,
        expected_revision: int,
        device_id: str | None = None,
    ) -> PluginAccountConnectionResponse:
        self._get(db, user_id, connection_id)
        self._lock_owner(db, user_id)
        row = self._get(db, user_id, connection_id, lock=True)
        spec = dict(row.json["spec"])
        if spec["status"] == "connected" and spec["credentialType"] == "oauth2":
            devices = dict(spec["deviceGrants"])
            if device_id is not None:
                logical_id, binding = self._device_binding(db, user_id, device_id)
                devices[logical_id] = binding
            if "revoke" in (spec["authDefinition"].get("oauth2") or []):
                refresh = spec.get("oauthRefresh") or {}
                spec["oauthRevocation"] = {
                    "state": (
                        "attention"
                        if refresh.get("state") == "uncertain"
                        else "pending"
                    ),
                    "credential": spec["credential"],
                    "devices": devices,
                    "attempts": 0,
                    "nextAttemptAt": int(time.time()),
                    "refreshOperation": (
                        refresh.get("id")
                        if refresh.get("state") in {"in_flight", "uncertain"}
                        else None
                    ),
                    "waitUntil": (
                        refresh.get("expiresAt", 0)
                        if refresh.get("state") == "in_flight"
                        else 0
                    ),
                }
            else:
                spec["oauthRevocation"] = {"state": "unsupported"}
        spec.update(status="disconnected", credential=None, deviceGrants={})
        self._advance(db, row, spec, expected_revision)
        return self._response(row)

    @trace_sync("plugin_auth.read_for_device", "backend.plugin_auth")
    def read_for_device(
        self,
        db: Session,
        *,
        user_id: int,
        connection_id: str,
        device_id: str,
        installed_plugin_id: int,
        expected_revision: int,
    ) -> SecretStr:
        """Authorize an already-authenticated runtime before decrypting a value."""
        row = self._get(db, user_id, connection_id)
        spec = row.json["spec"]
        self._require_connected(spec)
        if spec["revision"] != expected_revision:
            raise PluginAccountAuthError("plugin_auth_revision_conflict")
        if spec["installedPluginId"] != installed_plugin_id:
            raise PluginAccountAuthError("plugin_auth_plugin_mismatch", 403)
        self._validate_current_plugin(db, user_id, spec)
        logical_id, binding = self._device_binding(db, user_id, device_id)
        if spec["deviceGrants"].get(logical_id) != binding:
            raise PluginAccountAuthError("plugin_auth_device_not_granted", 403)
        return SecretStr(
            self._cipher_instance().decrypt(
                spec["credential"], context=self._context(user_id, spec)
            )
        )

    def _advance(self, db: Session, row: Kind, spec: dict, revision: int) -> None:
        spec["revision"] = revision + 1
        self._replace(db, row, spec, revision)

    @staticmethod
    def _replace(db: Session, row: Kind, spec: dict, revision: int) -> None:
        updated = (
            db.query(Kind)
            .filter(
                Kind.id == row.id,
                Kind.user_id == row.user_id,
                Kind.kind == CONNECTION_KIND,
                Kind.namespace == CONNECTION_NAMESPACE,
                Kind.name == row.name,
                Kind.is_active.is_(True),
                Kind.json["spec"]["revision"].as_integer() == revision,
            )
            .update({Kind.json: {"spec": spec}}, synchronize_session=False)
        )
        if updated != 1:
            raise PluginAccountAuthError("plugin_auth_revision_conflict")
        db.refresh(row)

    @staticmethod
    def _lock_owner(db: Session, user_id: int) -> None:
        owner = (
            db.query(User)
            .filter(User.id == user_id)
            .populate_existing()
            .with_for_update()
            .first()
        )
        if owner is None or not owner.is_active:
            raise PluginAccountAuthError("plugin_auth_owner_unavailable", 403)

    @staticmethod
    def _query(db: Session, user_id: int, name: str | None = None):
        query = db.query(Kind).filter(
            Kind.kind == CONNECTION_KIND,
            Kind.namespace == CONNECTION_NAMESPACE,
            Kind.user_id == user_id,
            Kind.is_active.is_(True),
        )
        return query.filter(Kind.name == name) if name is not None else query

    def _get(
        self, db: Session, user_id: int, connection_id: str, *, lock: bool = False
    ) -> Kind:
        query = self._query(db, user_id, connection_id).populate_existing()
        if lock:
            query = query.with_for_update()
        row = query.first()
        if row is None:
            raise PluginAccountAuthError("plugin_auth_connection_not_found", 404)
        return row

    @staticmethod
    def _plugin(
        db: Session, user_id: int, plugin_id: int, slug: str
    ) -> tuple[Kind, PluginAccountAuthDefinition]:
        plugin = (
            db.query(Kind)
            .filter(
                Kind.id == plugin_id,
                Kind.user_id == user_id,
                Kind.kind == "InstalledPlugin",
                Kind.namespace == "default",
                Kind.is_active.is_(True),
            )
            .first()
        )
        if plugin is None:
            raise PluginAccountAuthError("plugin_auth_plugin_not_found", 404)
        spec = plugin.json.get("spec", {})
        if spec.get("enabled") is False:
            raise PluginAccountAuthError("plugin_auth_plugin_disabled", 403)
        connectors = spec.get("components", {}).get("connectors", [])
        connector = next((item for item in connectors if item.get("slug") == slug), {})
        if not connector.get("accountAuth") or not spec.get("source", {}).get(
            "pluginKey"
        ):
            raise PluginAccountAuthError("plugin_auth_not_supported", 422)
        return plugin, PluginAccountAuthDefinition.model_validate(
            connector["accountAuth"]
        )

    def _validate_current_plugin(self, db: Session, user_id: int, spec: dict) -> None:
        plugin, definition = self._plugin(
            db, user_id, spec["installedPluginId"], spec["connectorSlug"]
        )
        if (
            self._source_identity(plugin.json["spec"]["source"])
            != spec["sourceIdentity"]
            or definition.model_dump(exclude_none=True) != spec["authDefinition"]
        ):
            raise PluginAccountAuthError("plugin_auth_definition_changed", 403)

    @staticmethod
    def _source_identity(source: dict) -> str:
        return json.dumps(
            {
                key: source.get(key)
                for key in (
                    "type",
                    "providerKey",
                    "pluginKey",
                    "catalogItemId",
                    "marketplace",
                )
            },
            sort_keys=True,
            separators=(",", ":"),
        )

    @staticmethod
    def _device_binding(db: Session, user_id: int, device_id: str) -> tuple[str, dict]:
        identity = resolve_runtime_route_identity(
            db, user_id=user_id, submitted_device_id=device_id
        )
        if identity is None:
            raise PluginAccountAuthError("plugin_auth_device_not_found", 404)
        if not identity.runtime_instance_id:
            raise PluginAccountAuthError("plugin_auth_device_upgrade_required", 409)
        record_id = record_id_from_route(identity.runtime_device_id)
        device = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Device",
                Kind.namespace == "default",
                (
                    Kind.id == record_id
                    if record_id is not None
                    else Kind.name == identity.logical_device_id
                ),
                Kind.is_active.is_(True),
            )
            .one()
        )
        return identity.logical_device_id, {
            "deviceRowId": device.id,
            "runtimeDeviceId": identity.runtime_device_id,
            "runtimeInstanceId": identity.runtime_instance_id,
        }

    @staticmethod
    def _require_connected(spec: dict) -> None:
        if spec["status"] != "connected" or not spec.get("credential"):
            raise PluginAccountAuthError("plugin_auth_disconnected", 403)

    @staticmethod
    def _context(user_id: int, spec: dict[str, Any]) -> str:
        return json.dumps(
            [
                user_id,
                spec["sourceIdentity"],
                spec["connectorSlug"],
                spec["accountId"],
                spec["credentialType"],
                spec["authDefinition"],
            ],
            sort_keys=True,
            separators=(",", ":"),
        )

    @staticmethod
    def _response(row: Kind) -> PluginAccountConnectionResponse:
        spec = row.json["spec"]
        return PluginAccountConnectionResponse(
            id=row.name,
            installed_plugin_id=spec["installedPluginId"],
            plugin_key=spec["pluginKey"],
            connector_slug=spec["connectorSlug"],
            account_id=spec["accountId"],
            account_label=spec["accountLabel"],
            credential_type=spec["credentialType"],
            status=spec["status"],
            revision=spec["revision"],
            device_ids=sorted(spec["deviceGrants"]),
            provider_revocation=(
                "pending"
                if (spec.get("oauthRevocation") or {}).get("state") == "in_flight"
                else (spec.get("oauthRevocation") or {}).get("state")
            ),
        )


plugin_account_connection_service = PluginAccountConnectionService()
