# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""User-level MCP configuration helpers."""

from __future__ import annotations

import hashlib
import json
from contextlib import contextmanager
from copy import deepcopy
from typing import Any, Iterator

from fastapi import HTTPException
from redis.exceptions import RedisError
from sqlalchemy.exc import OperationalError

from app.core.cache import cache_manager
from app.core.config import settings
from app.db.session import SessionLocal
from app.models.user import User
from app.services.mcp_provider_registry import (
    get_mcp_provider,
    get_mcp_provider_service,
    list_mcp_provider_services,
    list_mcp_providers,
)
from shared.utils.crypto import (
    decrypt_sensitive_data,
    encrypt_sensitive_data,
    is_data_encrypted,
)

MCP_ROOT_KEY = "mcps"
MCP_SERVICES_KEY = "services"
MCP_CREDENTIALS_KEY = "credentials"
MCP_URL_KEY = "url"
MCP_AUTH_MODE_KEY = "auth_mode"
MCP_AUTH_MODE_URL = "url"
MCP_AUTH_MODE_OAUTH = "oauth"
MCP_OAUTH_KEY = "oauth"
MCP_ACCESS_TOKEN_KEY = "access_token"
MCP_REFRESH_TOKEN_KEY = "refresh_token"
MCP_EXPIRES_AT_KEY = "expires_at"
MCP_SCOPE_KEY = "scope"
MCP_ACCOUNT_KEY = "account"


class MCPPreferencesError(HTTPException):
    """A concurrent configuration change or lock timeout requires a retry."""

    def __init__(self, detail: str, status_code: int = 409) -> None:
        super().__init__(status_code=status_code, detail=detail)
        self.error_code = (
            "mcp_authorization_busy"
            if status_code == 503
            else "mcp_configuration_changed"
        )


def _encrypt(value: str) -> str:
    """Encrypt a value unless it is already stored encrypted."""
    if not value:
        return ""
    return value if is_data_encrypted(value) else encrypt_sensitive_data(value)


def _decrypt(value: Any) -> str:
    """Decrypt a stored value, tolerating plaintext for backwards compatibility."""
    if not isinstance(value, str) or not value:
        return ""
    if is_data_encrypted(value):
        return decrypt_sensitive_data(value) or ""
    return value


class UserMCPService:
    """Helper service for reading and writing user-scoped MCP settings."""

    @staticmethod
    @contextmanager
    def locked_user(user_id: int) -> Iterator[User]:
        """Own a fresh transaction; serialize all MCP writes on the user row."""
        try:
            with SessionLocal.begin() as db:
                user = (
                    db.query(User)
                    .filter(User.id == user_id)
                    .with_for_update()
                    .populate_existing()
                    .one_or_none()
                )
                if user is None:
                    raise HTTPException(status_code=404, detail="User not found")
                yield user
        except OperationalError as exc:
            error_args = getattr(exc.orig, "args", ())
            if error_args and error_args[0] in {1205, 1213, 3572}:
                raise MCPPreferencesError(
                    "MCP authorization is busy; please retry shortly", status_code=503
                ) from None
            raise

    @staticmethod
    def service_snapshot(preferences: Any, provider_id: str, service_id: str) -> str:
        """Track user-controlled configuration, excluding rotating credentials."""
        config = UserMCPService.get_provider_service_config(
            preferences, provider_id, service_id
        )
        snapshot = {key: config[key] for key in ("enabled", "url", "auth_mode")}
        return hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()

    @staticmethod
    def authorization_session_key(
        user_id: int, provider_id: str, service_id: str
    ) -> str:
        return f"user_mcp_oauth_active:{user_id}:{provider_id}:{service_id}"

    @staticmethod
    def set_authorization_session(
        user_id: int, provider_id: str, service_id: str, session_id: str | None
    ) -> None:
        """Replace or cancel pending consent while the caller holds the user row."""
        key = UserMCPService.authorization_session_key(user_id, provider_id, service_id)
        if not cache_manager.set_from_sync(
            key, session_id, expire=settings.MCP_OAUTH_SESSION_TTL_SECONDS
        ):
            raise MCPPreferencesError(
                "MCP authorization session is unavailable; please retry",
                status_code=503,
            )

    @staticmethod
    def get_authorization_session(
        user_id: int, provider_id: str, service_id: str
    ) -> Any:
        key = UserMCPService.authorization_session_key(user_id, provider_id, service_id)
        try:
            return cache_manager.get_sync_or_raise(key)
        except RedisError:
            raise MCPPreferencesError(
                "MCP authorization session is unavailable; please retry",
                status_code=503,
            ) from None

    @staticmethod
    def start_authorization(
        user_id: int, provider_id: str, service_id: str, session_id: str
    ) -> tuple[dict[str, Any], str]:
        """Claim consent before discovery so disconnect can cancel in-flight starts."""
        with UserMCPService.locked_user(user_id) as current:
            config = UserMCPService.get_provider_service_config(
                current.preferences, provider_id, service_id
            )
            if not config["url"]:
                raise HTTPException(
                    status_code=400,
                    detail="Please save the MCP OAuth server URL before connecting",
                )
            if config["auth_mode"] != MCP_AUTH_MODE_OAUTH:
                raise MCPPreferencesError("Please save OAuth mode before connecting")
            snapshot = UserMCPService.service_snapshot(
                current.preferences, provider_id, service_id
            )
            UserMCPService.set_authorization_session(
                user_id, provider_id, service_id, session_id
            )
            return config, snapshot

    @staticmethod
    def require_authorization(current: User, session: dict[str, Any]) -> None:
        """Called only while holding the owner row; never reactivate canceled consent."""
        provider_id, service_id = str(session["provider_id"]), str(
            session["service_id"]
        )
        active = UserMCPService.get_authorization_session(
            current.id, provider_id, service_id
        )
        if active != session.get("session_id"):
            raise MCPPreferencesError(
                "MCP authorization was canceled or replaced; start again"
            )
        snapshot = UserMCPService.service_snapshot(
            current.preferences, provider_id, service_id
        )
        if snapshot != session.get("service_snapshot"):
            raise MCPPreferencesError(
                "MCP configuration or authorization changed; start authorization again"
            )

    @staticmethod
    def validate_authorization(session: dict[str, Any]) -> None:
        with UserMCPService.locked_user(int(session["user_id"])) as current:
            UserMCPService.require_authorization(current, session)

    @staticmethod
    def read_service(
        user_id: int, provider_id: str, service_id: str
    ) -> tuple[dict, str]:
        """Read committed configuration without borrowing a caller's ORM session."""
        with SessionLocal() as db:
            user = db.get(User, user_id)
            if user is None:
                raise HTTPException(status_code=404, detail="User not found")
            return (
                UserMCPService.get_provider_service_config(
                    user.preferences, provider_id, service_id
                ),
                UserMCPService.service_snapshot(
                    user.preferences, provider_id, service_id
                ),
            )

    @staticmethod
    def save_service_config(
        user_id: int,
        *,
        provider_id: str,
        service_id: str,
        enabled: bool,
        url: str,
        auth_mode: str | None,
    ) -> dict[str, Any]:
        """Merge one service into current preferences while holding its owner row."""
        with UserMCPService.locked_user(user_id) as user:
            previous = UserMCPService.get_provider_service_config(
                user.preferences, provider_id, service_id
            )
            if (
                previous["auth_mode"] == MCP_AUTH_MODE_OAUTH
                or auth_mode == MCP_AUTH_MODE_OAUTH
            ):
                UserMCPService.set_authorization_session(
                    user_id, provider_id, service_id, None
                )
            preferences = UserMCPService.set_provider_service_config(
                user.preferences,
                provider_id=provider_id,
                service_id=service_id,
                enabled=enabled,
                url=url,
                auth_mode=auth_mode,
            )
            if previous["url"] != url.strip():
                preferences = UserMCPService.clear_service_oauth_credentials(
                    preferences, provider_id, service_id
                )
            user.preferences = UserMCPService.dump_preferences(preferences)
            return UserMCPService.get_provider_service_config(
                user.preferences, provider_id, service_id
            )

    @staticmethod
    def load_preferences(preferences: str | dict[str, Any] | None) -> dict[str, Any]:
        """Parse raw preferences payload into a dictionary."""
        if not preferences:
            return {}

        if isinstance(preferences, dict):
            return dict(preferences)

        try:
            parsed = json.loads(preferences)
            return parsed if isinstance(parsed, dict) else {}
        except (TypeError, json.JSONDecodeError):
            return {}

    @staticmethod
    def dump_preferences(preferences: dict[str, Any]) -> str:
        """Serialize preferences for persistence."""
        return json.dumps(preferences)

    @staticmethod
    def get_provider_service_config(
        preferences: str | dict[str, Any] | None,
        provider_id: str,
        service_id: str,
    ) -> dict[str, Any]:
        """Get a decrypted provider MCP service config from user preferences."""
        prefs = UserMCPService.load_preferences(preferences)
        provider = ((prefs.get(MCP_ROOT_KEY) or {}).get(provider_id) or {}).copy()
        services = (provider.get(MCP_SERVICES_KEY) or {}).copy()
        service = (services.get(service_id) or {}).copy()
        credentials = (service.get(MCP_CREDENTIALS_KEY) or {}).copy()

        url = credentials.get(MCP_URL_KEY, "")

        if isinstance(url, str) and url:
            if is_data_encrypted(url):
                decrypted = decrypt_sensitive_data(url)
                url = decrypted or ""
        else:
            url = ""

        refresh_token = _decrypt(credentials.get(MCP_REFRESH_TOKEN_KEY))
        access_token = _decrypt(credentials.get(MCP_ACCESS_TOKEN_KEY))
        expires_at = credentials.get(MCP_EXPIRES_AT_KEY)
        account = _decrypt(credentials.get(MCP_ACCOUNT_KEY))

        auth_mode = service.get(MCP_AUTH_MODE_KEY)
        if auth_mode not in {MCP_AUTH_MODE_URL, MCP_AUTH_MODE_OAUTH}:
            auth_mode = MCP_AUTH_MODE_URL

        return {
            "enabled": bool(service.get("enabled", False)),
            "url": url,
            "auth_mode": auth_mode,
            "oauth_connected": bool(access_token or refresh_token),
            "oauth_expires_at": (
                int(expires_at) if isinstance(expires_at, int) else None
            ),
            "oauth_account": account or None,
        }

    @staticmethod
    def get_provider_service_definition(
        preferences: str | dict[str, Any] | None,
        provider_id: str,
        service_id: str,
    ) -> dict[str, Any] | None:
        """Return static MCP service metadata."""
        provider = get_mcp_provider(provider_id)
        if not provider or provider["configuration_mode"] != "user":
            return None

        service = get_mcp_provider_service(provider_id, service_id)
        if service:
            return dict(service)

        return None

    @staticmethod
    def has_provider_services(
        preferences: str | dict[str, Any] | None,
        provider_id: str,
    ) -> bool:
        """Return whether a provider has static services."""
        provider = get_mcp_provider(provider_id)
        return bool(provider and provider["configuration_mode"] == "user")

    @staticmethod
    def list_provider_service_configs(
        preferences: str | dict[str, Any] | None,
        provider_id: str,
    ) -> list[dict[str, Any]]:
        """Return all registered provider services merged with user config."""
        configs = []
        services = list_mcp_provider_services(provider_id)

        for service in services:
            config = UserMCPService.get_provider_service_config(
                preferences, provider_id, service["service_id"]
            )
            configs.append({"provider_id": provider_id, **service, **config})
        return configs

    @staticmethod
    def get_decrypted_mcp_preferences(
        preferences: str | dict[str, Any] | None,
    ) -> dict[str, Any]:
        """Return the user MCP preferences subtree with decrypted URLs."""
        prefs = UserMCPService.load_preferences(preferences)
        mcps = deepcopy(prefs.get(MCP_ROOT_KEY) or {})

        for provider in mcps.values():
            services = provider.get(MCP_SERVICES_KEY)
            if not isinstance(services, dict):
                continue

            for service in services.values():
                credentials = service.get(MCP_CREDENTIALS_KEY)
                if not isinstance(credentials, dict):
                    continue

                url = credentials.get(MCP_URL_KEY)
                if isinstance(url, str) and url and is_data_encrypted(url):
                    credentials[MCP_URL_KEY] = decrypt_sensitive_data(url) or ""

        return mcps

    @staticmethod
    def get_provider_service_credentials(
        preferences: str | dict[str, Any] | None,
        provider_id: str,
        service_id: str,
    ) -> dict[str, str]:
        """Return all decrypted credential values of a provider service.

        Unlike ``get_provider_service_config`` this exposes every stored
        credential key (url, api_key, ...) for server-side connectors that
        need more than an MCP URL.
        """
        prefs = UserMCPService.load_preferences(preferences)
        service = (
            ((prefs.get(MCP_ROOT_KEY) or {}).get(provider_id) or {})
            .get(MCP_SERVICES_KEY, {})
            .get(service_id)
        ) or {}
        credentials = service.get(MCP_CREDENTIALS_KEY)
        if not isinstance(credentials, dict):
            return {}

        decrypted: dict[str, str] = {}
        for key, value in credentials.items():
            if not isinstance(value, str) or not value:
                continue
            if is_data_encrypted(value):
                decrypted[key] = decrypt_sensitive_data(value) or ""
            else:
                decrypted[key] = value
        return decrypted

    @staticmethod
    def get_enabled_decrypted_mcp_preferences(
        preferences: str | dict[str, Any] | None,
    ) -> dict[str, Any]:
        """Return only enabled MCP services with decrypted URLs."""
        mcps = UserMCPService.get_decrypted_mcp_preferences(preferences)
        enabled_mcps: dict[str, Any] = {}

        for provider_id, provider in mcps.items():
            provider_definition = get_mcp_provider(provider_id)
            if (
                not provider_definition
                or provider_definition["configuration_mode"] != "user"
            ):
                continue

            services = provider.get(MCP_SERVICES_KEY)
            if not isinstance(services, dict):
                continue

            enabled_services: dict[str, Any] = {}
            for service_id, service in services.items():
                if not isinstance(service, dict):
                    continue

                if not service.get("enabled"):
                    continue

                credentials = service.get(MCP_CREDENTIALS_KEY)
                url = (
                    credentials.get(MCP_URL_KEY)
                    if isinstance(credentials, dict)
                    else ""
                )
                if not isinstance(url, str) or not url.strip():
                    continue

                enabled_services[service_id] = service

            if enabled_services:
                enabled_mcps[provider_id] = {
                    **provider,
                    MCP_SERVICES_KEY: enabled_services,
                }

        return enabled_mcps

    @staticmethod
    def get_enabled_mcp_server(
        preferences: str | dict[str, Any] | None,
        provider_id: str,
        service_id: str,
        *,
        server_name: str | None = None,
    ) -> dict[str, Any] | None:
        """Build a concrete MCP server config for an enabled provider service."""
        service = UserMCPService.get_provider_service_definition(
            preferences,
            provider_id,
            service_id,
        )
        if not service:
            return None

        config = UserMCPService.get_provider_service_config(
            preferences,
            provider_id,
            service_id,
        )
        url = (config.get("url") or "").strip()
        if not config.get("enabled") or not url:
            return None

        return {
            "name": server_name or service["server_name"],
            "url": url,
            "type": "streamable-http",
        }

    @staticmethod
    def set_provider_service_config(
        preferences: str | dict[str, Any] | None,
        *,
        provider_id: str,
        service_id: str,
        enabled: bool,
        url: str,
        auth_mode: str | None = None,
    ) -> dict[str, Any]:
        """Update a provider MCP service config inside user preferences."""
        if not UserMCPService.get_provider_service_definition(
            preferences,
            provider_id,
            service_id,
        ):
            raise ValueError(
                f"Unsupported MCP provider service: {provider_id}/{service_id}"
            )

        prefs = UserMCPService.load_preferences(preferences)
        mcps = dict(prefs.get(MCP_ROOT_KEY) or {})
        provider = dict(mcps.get(provider_id) or {})
        services = dict(provider.get(MCP_SERVICES_KEY) or {})
        service = dict(services.get(service_id) or {})
        credentials = dict(service.get(MCP_CREDENTIALS_KEY) or {})

        cleaned_url = url.strip()
        if cleaned_url:
            credentials[MCP_URL_KEY] = _encrypt(cleaned_url)
        else:
            credentials.pop(MCP_URL_KEY, None)

        service["enabled"] = enabled
        if auth_mode is not None:
            if auth_mode not in {MCP_AUTH_MODE_URL, MCP_AUTH_MODE_OAUTH}:
                raise ValueError(f"Unsupported MCP auth mode: {auth_mode}")
            service[MCP_AUTH_MODE_KEY] = auth_mode
        if credentials:
            service[MCP_CREDENTIALS_KEY] = credentials
        else:
            service.pop(MCP_CREDENTIALS_KEY, None)
        if auth_mode == MCP_AUTH_MODE_URL:
            # Switching to a personal URL drops stored OAuth tokens so a
            # long-lived refresh token does not survive the mode change.
            UserMCPService._clear_oauth_credentials(service)

        services[service_id] = service
        provider[MCP_SERVICES_KEY] = services

        mcps[provider_id] = provider
        prefs[MCP_ROOT_KEY] = mcps
        return prefs

    @staticmethod
    def get_service_auth_mode(
        preferences: str | dict[str, Any] | None,
        provider_id: str,
        service_id: str,
    ) -> str:
        """Return the configured authentication mode of a provider service."""
        service = UserMCPService._get_service(
            UserMCPService.load_preferences(preferences),
            provider_id,
            service_id,
        )
        auth_mode = service.get(MCP_AUTH_MODE_KEY)
        return (
            auth_mode
            if auth_mode in {MCP_AUTH_MODE_URL, MCP_AUTH_MODE_OAUTH}
            else MCP_AUTH_MODE_URL
        )

    @staticmethod
    def set_service_auth_mode(
        preferences: str | dict[str, Any] | None,
        provider_id: str,
        service_id: str,
        auth_mode: str,
    ) -> dict[str, Any]:
        """Persist the authentication mode of a provider service."""
        if auth_mode not in {MCP_AUTH_MODE_URL, MCP_AUTH_MODE_OAUTH}:
            raise ValueError(f"Unsupported MCP auth mode: {auth_mode}")

        prefs = UserMCPService.load_preferences(preferences)
        service = UserMCPService._get_service(prefs, provider_id, service_id)
        service[MCP_AUTH_MODE_KEY] = auth_mode
        if auth_mode == MCP_AUTH_MODE_URL:
            # A personal StreamableHttp URL carries its own credential; stale
            # OAuth tokens must not survive the switch.
            UserMCPService._clear_oauth_credentials(service)

        return UserMCPService._set_service(prefs, provider_id, service_id, service)

    @staticmethod
    def get_provider_oauth_client(
        preferences: str | dict[str, Any] | None,
        provider_id: str,
    ) -> dict[str, Any]:
        """Return the cached OAuth client registration of a provider."""
        prefs = UserMCPService.load_preferences(preferences)
        provider = (prefs.get(MCP_ROOT_KEY) or {}).get(provider_id) or {}
        client = provider.get(MCP_OAUTH_KEY)
        return dict(client) if isinstance(client, dict) else {}

    @staticmethod
    def set_provider_oauth_client(
        preferences: str | dict[str, Any] | None,
        provider_id: str,
        client: dict[str, Any],
    ) -> dict[str, Any]:
        """Persist the OAuth client registration of a provider."""
        prefs = UserMCPService.load_preferences(preferences)
        mcps = dict(prefs.get(MCP_ROOT_KEY) or {})
        provider = dict(mcps.get(provider_id) or {})
        provider[MCP_OAUTH_KEY] = dict(client)
        mcps[provider_id] = provider
        prefs[MCP_ROOT_KEY] = mcps
        return prefs

    @staticmethod
    def get_service_oauth_credentials(
        preferences: str | dict[str, Any] | None,
        provider_id: str,
        service_id: str,
    ) -> dict[str, Any]:
        """Return the decrypted OAuth credentials of a provider service."""
        service = UserMCPService._get_service(
            UserMCPService.load_preferences(preferences),
            provider_id,
            service_id,
        )
        credentials = service.get(MCP_CREDENTIALS_KEY)
        if not isinstance(credentials, dict):
            credentials = {}

        expires_at = credentials.get(MCP_EXPIRES_AT_KEY)
        return {
            MCP_ACCESS_TOKEN_KEY: _decrypt(credentials.get(MCP_ACCESS_TOKEN_KEY)),
            MCP_REFRESH_TOKEN_KEY: _decrypt(credentials.get(MCP_REFRESH_TOKEN_KEY)),
            MCP_EXPIRES_AT_KEY: int(expires_at) if isinstance(expires_at, int) else 0,
            MCP_SCOPE_KEY: _decrypt(credentials.get(MCP_SCOPE_KEY)),
            MCP_ACCOUNT_KEY: _decrypt(credentials.get(MCP_ACCOUNT_KEY)),
        }

    @staticmethod
    def save_service_oauth_credentials(
        preferences: str | dict[str, Any] | None,
        provider_id: str,
        service_id: str,
        *,
        access_token: str,
        refresh_token: str,
        expires_at: int,
        scope: str = "",
        account: str = "",
    ) -> dict[str, Any]:
        """Store freshly issued OAuth credentials for a provider service."""
        prefs = UserMCPService.load_preferences(preferences)
        service = UserMCPService._get_service(prefs, provider_id, service_id)
        credentials = dict(service.get(MCP_CREDENTIALS_KEY) or {})

        credentials[MCP_ACCESS_TOKEN_KEY] = _encrypt(access_token)
        if refresh_token:
            credentials[MCP_REFRESH_TOKEN_KEY] = _encrypt(refresh_token)
        credentials[MCP_EXPIRES_AT_KEY] = int(expires_at or 0)
        if scope:
            credentials[MCP_SCOPE_KEY] = _encrypt(scope)
        if account:
            credentials[MCP_ACCOUNT_KEY] = _encrypt(account)

        service[MCP_CREDENTIALS_KEY] = credentials
        service[MCP_AUTH_MODE_KEY] = MCP_AUTH_MODE_OAUTH
        return UserMCPService._set_service(prefs, provider_id, service_id, service)

    @staticmethod
    def clear_service_oauth_credentials(
        preferences: str | dict[str, Any] | None,
        provider_id: str,
        service_id: str,
    ) -> dict[str, Any]:
        """Drop stored OAuth credentials while keeping the service configured."""
        prefs = UserMCPService.load_preferences(preferences)
        service = UserMCPService._get_service(prefs, provider_id, service_id)
        UserMCPService._clear_oauth_credentials(service)

        return UserMCPService._set_service(prefs, provider_id, service_id, service)

    @staticmethod
    def _clear_oauth_credentials(service: dict[str, Any]) -> None:
        """Remove OAuth token entries from a service's credentials."""
        credentials = dict(service.get(MCP_CREDENTIALS_KEY) or {})
        for key in (
            MCP_ACCESS_TOKEN_KEY,
            MCP_REFRESH_TOKEN_KEY,
            MCP_EXPIRES_AT_KEY,
            MCP_SCOPE_KEY,
            MCP_ACCOUNT_KEY,
        ):
            credentials.pop(key, None)
        if credentials:
            service[MCP_CREDENTIALS_KEY] = credentials
        else:
            service.pop(MCP_CREDENTIALS_KEY, None)

    @staticmethod
    def _get_service(
        prefs: dict[str, Any],
        provider_id: str,
        service_id: str,
    ) -> dict[str, Any]:
        provider = (prefs.get(MCP_ROOT_KEY) or {}).get(provider_id) or {}
        services = provider.get(MCP_SERVICES_KEY) or {}
        service = services.get(service_id)
        return dict(service) if isinstance(service, dict) else {}

    @staticmethod
    def _set_service(
        prefs: dict[str, Any],
        provider_id: str,
        service_id: str,
        service: dict[str, Any],
    ) -> dict[str, Any]:
        mcps = dict(prefs.get(MCP_ROOT_KEY) or {})
        provider = dict(mcps.get(provider_id) or {})
        services = dict(provider.get(MCP_SERVICES_KEY) or {})
        services[service_id] = service
        provider[MCP_SERVICES_KEY] = services
        mcps[provider_id] = provider
        prefs[MCP_ROOT_KEY] = mcps
        return prefs

    @staticmethod
    def list_mcp_servers(
        preferences: str | dict[str, Any] | None,
        provider_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Build MCP server configs for enabled services across providers."""
        servers = []
        provider_ids = (
            [provider_id]
            if provider_id
            else UserMCPService._configured_provider_ids(preferences)
        )
        for current_provider_id in provider_ids:
            if not UserMCPService.has_provider_services(
                preferences,
                current_provider_id,
            ):
                continue

            for service in UserMCPService.list_provider_service_configs(
                preferences, current_provider_id
            ):
                server = UserMCPService.get_enabled_mcp_server(
                    preferences,
                    current_provider_id,
                    service["service_id"],
                )
                if server:
                    servers.append(server)

        return servers

    @staticmethod
    def _configured_provider_ids(
        preferences: str | dict[str, Any] | None,
    ) -> list[str]:
        provider_ids = [
            provider["provider_id"]
            for provider in list_mcp_providers()
            if provider["configuration_mode"] == "user"
        ]
        return list(dict.fromkeys(provider_ids))


user_mcp_service = UserMCPService()
