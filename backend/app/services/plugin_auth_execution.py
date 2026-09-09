"""Select an explicitly granted account for native business execution."""

import re

from pydantic import SecretStr
from sqlalchemy.orm import Session

from app.schemas.plugin_account_auth import (
    PluginAccountConnectionResponse,
    PluginNativeExecution,
)
from app.services.plugin_account_connections import (
    PluginAccountAuthError,
    PluginAccountConnectionService,
    plugin_account_connection_service,
)
from app.services.plugin_oauth_credentials import business_credential
from shared.telemetry.decorators import trace_sync


def package_metadata(plugin, connector_slug, definition) -> dict:
    checksum = (plugin.json["spec"].get("packageRef") or {}).get("checksum")
    if not isinstance(checksum, str) or not re.fullmatch(
        r"sha256:[a-f0-9]{64}", checksum
    ):
        raise PluginAccountAuthError("plugin_auth_package_sync_required", 409)
    return {
        "installed_plugin_id": plugin.id,
        "connector_slug": connector_slug,
        "checksum": checksum,
        "auth_definition": definition.model_dump(exclude_none=True),
    }


class PluginAuthExecutionService:
    def __init__(self, connections: PluginAccountConnectionService):
        self.connections = connections

    @trace_sync("plugin_auth.execution.prepare", "backend.plugin_auth")
    def prepare(
        self,
        db: Session,
        *,
        user_id: int,
        device_id: str,
        request: PluginNativeExecution,
    ) -> dict:
        package, connection, credential = self.resolve(
            db, user_id=user_id, device_id=device_id, request=request
        )
        credential = business_credential(credential, connection.credential_type)
        return {"package": package, "credential": credential.get_secret_value()}

    @trace_sync("plugin_auth.execution.resolve", "backend.plugin_auth")
    def resolve(
        self,
        db: Session,
        *,
        user_id: int,
        device_id: str,
        request: PluginNativeExecution,
    ) -> tuple[dict, PluginAccountConnectionResponse, SecretStr]:
        plugin, definition = self.connections._plugin(
            db, user_id, request.installed_plugin_id, request.connector_slug
        )
        package = package_metadata(plugin, request.connector_slug, definition)
        logical_id, _ = self.connections._device_binding(db, user_id, device_id)
        candidates = [
            item
            for item in self.connections.list_connections(db, user_id=user_id)
            if item.installed_plugin_id == plugin.id
            and item.connector_slug == request.connector_slug
            and item.status == "connected"
            and logical_id in item.device_ids
            and (request.account_id is None or item.account_id == request.account_id)
        ]
        if not candidates:
            raise PluginAccountAuthError("plugin_auth_device_not_granted", 403)
        if len(candidates) != 1:
            raise PluginAccountAuthError("plugin_auth_account_selection_required", 409)
        connection = candidates[0]
        credential = self.connections.read_for_device(
            db,
            user_id=user_id,
            device_id=device_id,
            connection_id=connection.id,
            installed_plugin_id=plugin.id,
            expected_revision=connection.revision,
        )
        return package, connection, credential


plugin_auth_execution = PluginAuthExecutionService(plugin_account_connection_service)
