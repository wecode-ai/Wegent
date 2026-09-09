"""Detect local credential changes without exposing or retaining plaintext fingerprints."""

import hashlib
import hmac
import json
from copy import deepcopy

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.plugin_account_auth import (
    PluginCredentialWrite,
    PluginNativeEnrollment,
)
from app.services.plugin_account_connections import (
    PluginAccountAuthError,
    PluginAccountConnectionService,
)


class PluginAuthSourceSync:
    def __init__(self, connections: PluginAccountConnectionService):
        self.connections = connections

    def target(
        self, db: Session, user_id: int, spec: dict, account_id: str
    ) -> Kind | None:
        row = (
            self.connections._query(db, user_id)
            .populate_existing()
            .with_for_update()
            .filter(
                Kind.json["spec"]["sourceIdentity"].as_string()
                == spec["source_identity"],
                Kind.json["spec"]["connectorSlug"].as_string()
                == spec["connector_slug"],
                Kind.json["spec"]["accountId"].as_string() == account_id,
            )
            .first()
        )
        if row is not None:
            current = row.json["spec"]
            if current["status"] != "connected" or spec["device_id"] in current.get(
                "deviceRevocations", []
            ):
                raise PluginAccountAuthError("plugin_auth_connection_disabled", 403)
            self.connections._validate_current_plugin(db, user_id, current)
            if (current.get("oauthRefresh") or {}).get("state") == "in_flight":
                raise PluginAccountAuthError("plugin_auth_refresh_in_progress", 409)
        return row

    def observation(
        self,
        user_id: int,
        spec: dict,
        request: PluginNativeEnrollment,
        previous: dict | None,
    ) -> dict:
        cipher = self.connections._cipher_instance()
        key_id = previous["keyId"] if previous else cipher.active_key_id
        # Domain-separated HMAC avoids an offline password dictionary oracle.
        canonical = json.dumps(
            json.loads(request.credential.get_secret_value()),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
        message = json.dumps(
            [
                "wework-local-auth-observation-v1",
                user_id,
                spec["source_identity"],
                spec["connector_slug"],
                request.account_id,
                canonical,
            ],
            separators=(",", ":"),
        ).encode()
        return {
            "keyId": key_id,
            "digest": hmac.new(
                hmac.new(
                    cipher.keys[key_id],
                    b"wework-source-observation-key-v1",
                    hashlib.sha256,
                ).digest(),
                message,
                hashlib.sha256,
            ).hexdigest(),
            "deviceRowId": spec["binding"]["deviceRowId"],
            "runtimeDeviceId": spec["binding"]["runtimeDeviceId"],
        }

    def remember(
        self,
        db: Session,
        user_id: int,
        connection_id: str,
        source: dict,
        observation: dict,
    ) -> None:
        row = self.connections._get(db, user_id, connection_id, lock=True)
        spec = deepcopy(row.json["spec"])
        spec["localAuthSources"] = {
            **spec.get("localAuthSources", {}),
            source["device_id"]: observation,
        }
        self.connections._replace(db, row, spec, spec["revision"])

    def consume(
        self, db: Session, user_id: int, spec: dict, request: PluginNativeEnrollment
    ):
        self.connections._lock_owner(db, user_id)
        row = self.target(db, user_id, spec, request.account_id)
        previous = (
            row.json["spec"].get("localAuthSources", {}).get(spec["device_id"])
            if row
            else None
        )
        observation = self.observation(user_id, spec, request, previous)
        if previous == observation:
            return self.connections._response(row)
        connection = self.connections.enroll(
            db,
            user_id=user_id,
            request=PluginCredentialWrite(
                installed_plugin_id=spec["installed_plugin_id"],
                connector_slug=spec["connector_slug"],
                account_id=request.account_id,
                account_label=request.account_label,
                credential=request.credential,
                expected_revision=row.json["spec"]["revision"] if row else 0,
            ),
        )
        if spec["device_id"] not in connection.device_ids:
            connection = self.connections.grant_device(
                db,
                user_id=user_id,
                connection_id=connection.id,
                device_id=spec["device_id"],
                expected_revision=connection.revision,
            )
        self.remember(db, user_id, connection.id, spec, observation)
        return connection
