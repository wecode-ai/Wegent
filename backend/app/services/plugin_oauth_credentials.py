"""OAuth business access never receives the centrally owned refresh token."""

import json
import math
import time

from pydantic import SecretStr

from app.services.plugin_account_connections import PluginAccountAuthError


def token_payload(credential: SecretStr) -> dict:
    try:
        payload = json.loads(credential.get_secret_value())
        if (
            not isinstance(payload, dict)
            or not isinstance(payload.get("access_token"), str)
            or not payload["access_token"]
        ):
            raise ValueError
        expires_at = payload.get("expires_at")
        if expires_at is not None and (
            type(expires_at) not in (int, float) or not math.isfinite(expires_at)
        ):
            raise ValueError
        if "provider_private" in payload and not isinstance(
            payload["provider_private"], dict
        ):
            raise ValueError
        return payload
    except (ValueError, TypeError, RecursionError):
        raise PluginAccountAuthError("plugin_auth_invalid_credential", 400) from None


def requires_refresh(payload: dict) -> bool:
    return (
        payload.get("expires_at") is not None
        and payload["expires_at"] <= time.time() + 30
    )


def business_credential(credential: SecretStr, credential_type: str) -> SecretStr:
    if credential_type != "oauth2":
        return credential
    payload = token_payload(credential)
    if requires_refresh(payload):
        raise PluginAccountAuthError("plugin_auth_refresh_required", 409)
    for field in (
        "refresh_token",
        "provider_private",
        "client_secret",
        "persistent_code",
    ):
        payload.pop(field, None)
    return SecretStr(json.dumps(payload, separators=(",", ":")))
