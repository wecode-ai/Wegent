"""Native-only credential exchange; never routed through task or runtime RPC logs."""

import asyncio
import logging
from typing import Any

from pydantic import ValidationError

from app.db.session import SessionLocal
from app.schemas.plugin_account_auth import (
    PluginNativeAutomation,
    PluginNativeEnrollment,
    PluginNativeExecution,
    PluginNativeLocalLifecycle,
    PluginNativePreparation,
    PluginNativeRead,
    PluginOAuthFinish,
    PluginRevocationBegin,
    PluginRevocationFinish,
)
from app.services.device.runtime_route import (
    RuntimeRouteError,
    resolve_runtime_route_identity,
    runtime_route_resolver,
)
from app.services.plugin_account_connections import (
    PluginAccountAuthError,
    plugin_account_connection_service,
)
from app.services.plugin_auth_automation import plugin_auth_automation
from app.services.plugin_auth_execution import plugin_auth_execution
from app.services.plugin_auth_migrations import plugin_auth_migrations
from app.services.plugin_auth_transfers import plugin_auth_transfers
from app.services.plugin_credential_cipher import PluginCredentialCipherError
from app.services.plugin_oauth_credentials import business_credential
from app.services.plugin_oauth_operations import plugin_oauth_operations
from app.services.plugin_oauth_revocations import plugin_oauth_revocations
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)


@trace_async("plugin_auth.native.exchange", "backend.plugin_auth")
async def exchange(
    *, sid: str, session: dict[str, Any], operation: str, data: Any
) -> dict:
    """Identity comes exclusively from the authenticated, registered socket."""
    stage = "session"
    try:
        user_id = session.get("user_id")
        runtime_id = session.get("device_id")
        # Registered app-record routes are unique even when desktop restarts
        # leave several installations with the same app exposure alias.
        device_id = runtime_id
        instance_id = session.get("runtime_instance_id")
        if not user_id or not device_id or not runtime_id or not instance_id:
            raise PluginAccountAuthError("plugin_auth_device_not_registered", 403)
        stage = "route"
        route = await runtime_route_resolver.resolve(
            user_id=user_id, submitted_device_id=device_id
        )
        if (
            route.socket_id != sid
            or route.runtime_device_id != runtime_id
            or route.runtime_instance_id != instance_id
        ):
            raise PluginAccountAuthError("plugin_auth_stale_device_socket", 403)
        stage = "exchange"
        return await asyncio.to_thread(
            _exchange_sync,
            user_id,
            device_id,
            runtime_id,
            instance_id,
            operation,
            data,
        )
    except (PluginAccountAuthError, RuntimeRouteError) as exc:
        logger.warning(
            "Plugin auth exchange rejected stage=%s code=%s", stage, exc.code
        )
        return {"success": False, "error": exc.code}
    except (ValidationError, ValueError, TypeError):
        return {"success": False, "error": "plugin_auth_invalid_request"}
    except PluginCredentialCipherError:
        return {"success": False, "error": "plugin_auth_keyring_unavailable"}
    except Exception as exc:
        # Never include the exception: upstream validation may embed credentials.
        logger.warning(
            "Plugin auth exchange failed stage=%s error_type=%s",
            stage,
            type(exc).__name__,
        )
        return {"success": False, "error": "plugin_auth_exchange_failed"}


def _exchange_sync(
    user_id: int,
    device_id: str,
    runtime_id: str,
    instance_id: str,
    operation: str,
    data: Any,
) -> dict:
    with SessionLocal() as db:
        identity = resolve_runtime_route_identity(
            db, user_id=user_id, submitted_device_id=device_id
        )
        if (
            identity is None
            or identity.runtime_device_id != runtime_id
            or identity.runtime_instance_id != instance_id
        ):
            raise PluginAccountAuthError("plugin_auth_stale_device_socket", 403)
        if operation == "task_token":
            from app.services.auth.runtime_task_token import issue_runtime_task_token

            return issue_runtime_task_token(
                db, user_id=user_id, device_id=device_id, data=data
            )
        if operation == "local_lifecycle":
            from app.services.plugin_auth_local_lifecycle import (
                plugin_auth_local_lifecycle,
            )

            result = plugin_auth_local_lifecycle.exchange(
                db,
                user_id=user_id,
                device_id=device_id,
                request=PluginNativeLocalLifecycle.model_validate(data),
            )
            db.commit()
            return {"success": True, **result}
        if operation == "automatic":
            request = PluginNativeAutomation.model_validate(data)
            result = plugin_auth_automation.reconcile(
                db,
                user_id=user_id,
                device_id=device_id,
                installed_ids=request.installed_plugin_ids,
            )
            db.commit()
            return {"success": True, **result}
        if operation == "oauth_begin":
            result = plugin_oauth_operations.begin(
                db,
                user_id=user_id,
                device_id=device_id,
                request=PluginNativeExecution.model_validate(data),
            )
            db.commit()
            return {"success": True, **result}
        if operation == "transfer_stage":
            result = plugin_auth_transfers.stage(
                db,
                user_id=user_id,
                device_id=device_id,
                request=PluginNativeEnrollment.model_validate(data),
            )
            db.commit()
            return {"success": True, **result}
        if operation in {"transfer_prepare", "transfer_finish", "transfer_abort"}:
            request = PluginNativePreparation.model_validate(data)
            if operation == "transfer_abort":
                result = plugin_auth_transfers.abort(
                    db,
                    user_id=user_id,
                    device_id=device_id,
                    migration_id=request.migration_id,
                )
                db.commit()
                return {"success": True, **result}
            if operation == "transfer_prepare":
                result = plugin_auth_transfers.prepare(
                    db,
                    user_id=user_id,
                    device_id=device_id,
                    migration_id=request.migration_id,
                )
                return {"success": True, **result}
            result = plugin_auth_transfers.finish(
                db,
                user_id=user_id,
                device_id=device_id,
                migration_id=request.migration_id,
            )
            db.commit()
            return {"success": True, "connection": result.model_dump()}
        if operation == "oauth_revocations":
            if data != {}:
                raise PluginAccountAuthError("plugin_auth_invalid_request", 400)
            ids = plugin_oauth_revocations.pending(
                db, user_id=user_id, device_id=device_id
            )
            return {"success": True, "connection_ids": ids}
        if operation == "oauth_revoke_begin":
            request = PluginRevocationBegin.model_validate(data)
            result = plugin_oauth_revocations.begin(
                db,
                user_id=user_id,
                device_id=device_id,
                connection_id=request.connection_id,
            )
            db.commit()
            return {"success": True, **result}
        if operation == "oauth_revoke_finish":
            request = PluginRevocationFinish.model_validate(data)
            result = plugin_oauth_revocations.finish(
                db, user_id=user_id, device_id=device_id, request=request
            )
            db.commit()
            return {"success": True, **result}
        if operation == "oauth_finish":
            result = plugin_oauth_operations.finish(
                db,
                user_id=user_id,
                device_id=device_id,
                request=PluginOAuthFinish.model_validate(data),
            )
            db.commit()
            return {"success": True, **result}
        if operation == "execute":
            return {
                "success": True,
                **plugin_auth_execution.prepare(
                    db,
                    user_id=user_id,
                    device_id=device_id,
                    request=PluginNativeExecution.model_validate(data),
                ),
            }
        if operation == "prepare":
            request = PluginNativePreparation.model_validate(data)
            return {
                "success": True,
                **plugin_auth_migrations.prepare(
                    db,
                    user_id=user_id,
                    device_id=device_id,
                    migration_id=request.migration_id,
                ),
            }
        if operation == "enroll":
            result = plugin_auth_migrations.consume(
                db,
                user_id=user_id,
                device_id=device_id,
                request=PluginNativeEnrollment.model_validate(data),
            )
            db.commit()
            return {"success": True, "connection": result.model_dump()}
        if operation == "read":
            request = PluginNativeRead.model_validate(data)
            secret = plugin_account_connection_service.read_for_device(
                db, user_id=user_id, device_id=device_id, **request.model_dump()
            )
            row = plugin_account_connection_service._get(
                db, user_id, request.connection_id
            )
            secret = business_credential(secret, row.json["spec"]["credentialType"])
            return {"success": True, "credential": secret.get_secret_value()}
        raise PluginAccountAuthError("plugin_auth_invalid_operation", 400)
