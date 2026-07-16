# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""User-scoped runtime configuration storage and device sync."""

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Iterable, Optional
from urllib.parse import urlsplit

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.services.device.command_service import (
    DEFAULT_COMMAND_TIMEOUT_SECONDS,
    DeviceCommandError,
    execute_configured_device_command,
)
from app.services.device_service import device_service
from shared.utils.crypto import decrypt_sensitive_data, encrypt_sensitive_data

USER_RUNTIME_CONFIG_KIND = "UserRuntimeConfig"
USER_PROXY_CONFIG_KIND = "UserProxyConfig"
USER_RUNTIME_CONFIG_API_VERSION = "agent.wecode.io/v1"
USER_RUNTIME_CONFIG_NAMESPACE = "default"
USER_PROXY_CONFIG_NAME = "default"
USER_RUNTIME_CONFIG_PREFERENCE_KEY = "runtime_configs"
MAX_AUTH_JSON_BYTES = 512 * 1024
MAX_PROXY_URL_BYTES = 2048


class UserRuntimeConfigError(ValueError):
    """Raised when a user runtime config request is invalid."""


class UserRuntimeConfigSyncError(RuntimeError):
    """Raised when a runtime config cannot be synced."""


RUNTIME_AUTH_FILES: dict[str, dict[str, str]] = {
    "codex": {
        "target_path": "~/.codex/auth.json",
        "display_name": "Codex",
    },
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_runtime(runtime: str) -> str:
    normalized = runtime.strip().lower()
    if normalized not in RUNTIME_AUTH_FILES:
        raise UserRuntimeConfigError(f"Unsupported runtime: {runtime}")
    return normalized


def _validate_auth_json(auth_json: str) -> tuple[dict[str, Any], str]:
    encoded = auth_json.encode("utf-8")
    if len(encoded) > MAX_AUTH_JSON_BYTES:
        raise UserRuntimeConfigError("auth_json is too large")

    try:
        parsed = json.loads(auth_json)
    except json.JSONDecodeError as exc:
        raise UserRuntimeConfigError("auth_json must be valid JSON") from exc

    if not isinstance(parsed, dict):
        raise UserRuntimeConfigError("auth_json must be a JSON object")

    normalized = json.dumps(parsed, ensure_ascii=False, indent=2, sort_keys=True)
    return parsed, normalized


def _validate_proxy_url(proxy_url: str) -> str:
    normalized = proxy_url.strip()
    if not normalized:
        return ""

    if len(normalized.encode("utf-8")) > MAX_PROXY_URL_BYTES:
        raise UserRuntimeConfigError("proxy_url is too large")
    if any(char.isspace() for char in normalized):
        raise UserRuntimeConfigError("proxy_url must not contain whitespace")

    parsed = urlsplit(normalized)
    if parsed.scheme.lower() not in {"http", "https", "socks5"}:
        raise UserRuntimeConfigError("proxy_url scheme must be http, https, or socks5")
    try:
        port = parsed.port
    except ValueError as exc:
        raise UserRuntimeConfigError("proxy_url port is invalid") from exc
    if not parsed.hostname or not port:
        raise UserRuntimeConfigError("proxy_url must include host and port")

    return normalized


def _mask_proxy_url(proxy_url: str) -> str:
    if not proxy_url:
        return ""

    parsed = urlsplit(proxy_url)
    if not parsed.username and not parsed.password:
        return proxy_url

    host = parsed.hostname or ""
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    port = f":{parsed.port}" if parsed.port else ""
    return parsed._replace(netloc=f"***:***@{host}{port}").geturl()


def _parse_command_stdout(stdout: Any) -> Any:
    if not isinstance(stdout, str):
        return stdout
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        return stdout


def _command_error_detail(result: dict[str, Any], fallback: str) -> str:
    stdout = _parse_command_stdout(result.get("stdout"))
    if isinstance(stdout, dict) and stdout.get("error"):
        return str(stdout["error"])
    return str(result.get("error") or result.get("stderr") or fallback)


def load_runtime_preferences(preferences: Any) -> dict[str, Any]:
    """Parse user preferences into a mutable dictionary."""
    if not preferences:
        return {}
    if isinstance(preferences, dict):
        return dict(preferences)
    if hasattr(preferences, "model_dump"):
        dumped = preferences.model_dump()
        return dumped if isinstance(dumped, dict) else {}
    if isinstance(preferences, str):
        try:
            parsed = json.loads(preferences)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def is_runtime_user_config_enabled(preferences: Any, runtime: str) -> bool:
    """Return whether the user preference enables a runtime config."""
    normalized_runtime = _normalize_runtime(runtime)
    parsed = load_runtime_preferences(preferences)
    runtime_configs = parsed.get(USER_RUNTIME_CONFIG_PREFERENCE_KEY) or {}
    if not isinstance(runtime_configs, dict):
        return False
    config = runtime_configs.get(normalized_runtime) or {}
    if not isinstance(config, dict):
        return False
    return bool(config.get("use_user_config"))


def is_runtime_proxy_enabled(preferences: Any, runtime: str) -> bool:
    """Return whether the user preference enables proxy for a runtime."""
    normalized_runtime = _normalize_runtime(runtime)
    parsed = load_runtime_preferences(preferences)
    runtime_configs = parsed.get(USER_RUNTIME_CONFIG_PREFERENCE_KEY) or {}
    if not isinstance(runtime_configs, dict):
        return False
    config = runtime_configs.get(normalized_runtime) or {}
    if not isinstance(config, dict):
        return False
    return bool(config.get("use_proxy"))


def set_runtime_user_config_enabled(
    preferences: Any,
    runtime: str,
    enabled: bool,
    use_proxy: Optional[bool] = None,
) -> dict[str, Any]:
    """Return preferences with the runtime config enablement updated."""
    normalized_runtime = _normalize_runtime(runtime)
    parsed = load_runtime_preferences(preferences)
    runtime_configs = parsed.get(USER_RUNTIME_CONFIG_PREFERENCE_KEY) or {}
    if not isinstance(runtime_configs, dict):
        runtime_configs = {}
    runtime_config = dict(runtime_configs.get(normalized_runtime) or {})
    runtime_config["use_user_config"] = bool(enabled)
    if use_proxy is not None:
        runtime_config["use_proxy"] = bool(use_proxy)
    runtime_configs[normalized_runtime] = runtime_config
    parsed[USER_RUNTIME_CONFIG_PREFERENCE_KEY] = runtime_configs
    return parsed


def clear_runtime_proxy_preferences(preferences: Any) -> dict[str, Any]:
    """Return preferences with all runtime proxy enablement disabled."""
    parsed = load_runtime_preferences(preferences)
    runtime_configs = parsed.get(USER_RUNTIME_CONFIG_PREFERENCE_KEY) or {}
    if not isinstance(runtime_configs, dict):
        return parsed

    next_runtime_configs = {}
    for runtime, config in runtime_configs.items():
        if not isinstance(config, dict):
            next_runtime_configs[runtime] = config
            continue
        next_config = dict(config)
        next_config["use_proxy"] = False
        next_runtime_configs[runtime] = next_config

    parsed[USER_RUNTIME_CONFIG_PREFERENCE_KEY] = next_runtime_configs
    return parsed


class UserRuntimeConfigService:
    """Manage runtime configuration stored as user-owned Kind resources."""

    def get_config(
        self,
        db: Session,
        *,
        user_id: int,
        runtime: str,
        preferences: Any = None,
    ) -> dict[str, Any]:
        """Return the public status for a user runtime config."""
        normalized_runtime = _normalize_runtime(runtime)
        kind = self._get_kind(db, user_id=user_id, runtime=normalized_runtime)
        proxy_kind = self._get_proxy_kind(db, user_id=user_id)
        return self._build_response(
            normalized_runtime,
            kind,
            preferences,
            proxy_kind=proxy_kind,
        )

    def get_proxy_config(
        self,
        db: Session,
        *,
        user_id: int,
    ) -> dict[str, Any]:
        """Return the public status for the user's proxy configuration."""
        kind = self._get_proxy_kind(db, user_id=user_id)
        return self._build_proxy_response(kind)

    def set_use_user_config(
        self,
        db: Session,
        *,
        user: User,
        runtime: str,
        use_user_config: bool,
        use_proxy: Optional[bool] = None,
    ) -> dict[str, Any]:
        """Update whether the runtime should use this user's saved config."""
        normalized_runtime = _normalize_runtime(runtime)
        preferences = set_runtime_user_config_enabled(
            user.preferences,
            normalized_runtime,
            use_user_config,
            use_proxy,
        )
        proxy_kind = self._get_proxy_kind(db, user_id=user.id)
        if use_proxy is True and not self._get_proxy_url(proxy_kind):
            raise UserRuntimeConfigError("proxy is not configured")

        user.preferences = json.dumps(preferences)
        db.add(user)
        db.commit()
        db.refresh(user)
        kind = self._get_kind(db, user_id=user.id, runtime=normalized_runtime)
        proxy_kind = self._get_proxy_kind(db, user_id=user.id)
        return self._build_response(
            normalized_runtime,
            kind,
            user.preferences,
            proxy_kind=proxy_kind,
        )

    def save_proxy_url(
        self,
        db: Session,
        *,
        user: User,
        proxy_url: str,
    ) -> dict[str, Any]:
        """Validate and store encrypted user-level proxy URL."""
        normalized_proxy_url = _validate_proxy_url(proxy_url)

        kind = self._get_or_create_proxy_kind(db, user_id=user.id)
        data = dict(kind.json or {})
        spec = dict(data.get("spec") or {})
        now = _now_iso()
        if normalized_proxy_url:
            digest = hashlib.sha256(normalized_proxy_url.encode("utf-8")).hexdigest()
            spec["proxy"] = {
                "encryptedUrl": encrypt_sensitive_data(normalized_proxy_url),
                "sha256": digest,
                "updatedAt": now,
            }
        else:
            spec.pop("proxy", None)
            user.preferences = json.dumps(
                clear_runtime_proxy_preferences(user.preferences)
            )
            db.add(user)
        spec["updatedAt"] = now
        data["spec"] = spec
        kind.json = data

        db.add(kind)
        db.commit()
        db.refresh(kind)
        return self._build_proxy_response(kind)

    def get_execution_config(
        self,
        db: Session,
        *,
        user_id: int,
        runtime: str,
        preferences: Any = None,
    ) -> dict[str, Any]:
        """Return runtime config for execution, including decrypted proxy URL."""
        normalized_runtime = _normalize_runtime(runtime)
        kind = self._get_kind(db, user_id=user_id, runtime=normalized_runtime)
        proxy_kind = self._get_proxy_kind(db, user_id=user_id)
        response = self._build_response(
            normalized_runtime,
            kind,
            preferences,
            proxy_kind=proxy_kind,
        )
        proxy_url = self._get_proxy_url(proxy_kind)
        if response["use_proxy"] and proxy_url:
            response["proxy_url"] = proxy_url
        return response

    def save_auth_json(
        self,
        db: Session,
        *,
        user_id: int,
        runtime: str,
        auth_json: str,
        preferences: Any = None,
    ) -> dict[str, Any]:
        """Validate and store encrypted auth JSON for a runtime."""
        normalized_runtime = _normalize_runtime(runtime)
        _, normalized_auth_json = _validate_auth_json(auth_json)
        digest = hashlib.sha256(normalized_auth_json.encode("utf-8")).hexdigest()
        encrypted_auth_json = encrypt_sensitive_data(normalized_auth_json)

        kind = self._get_or_create_kind(db, user_id=user_id, runtime=normalized_runtime)
        data = dict(kind.json or {})
        spec = dict(data.get("spec") or {})
        now = _now_iso()
        spec["auth"] = {
            "format": "json",
            "targetPath": RUNTIME_AUTH_FILES[normalized_runtime]["target_path"],
            "encryptedValue": encrypted_auth_json,
            "sha256": digest,
            "updatedAt": now,
        }
        spec["updatedAt"] = now
        data["spec"] = spec
        kind.json = data

        db.add(kind)
        db.commit()
        db.refresh(kind)
        proxy_kind = self._get_proxy_kind(db, user_id=user_id)
        return self._build_response(
            normalized_runtime,
            kind,
            preferences,
            proxy_kind=proxy_kind,
        )

    async def import_auth_json_from_device(
        self,
        db: Session,
        *,
        user_id: int,
        runtime: str,
        device_id: str,
        preferences: Any = None,
    ) -> dict[str, Any]:
        """Read auth JSON from an online device and store it encrypted."""
        normalized_runtime = _normalize_runtime(runtime)
        target_path = RUNTIME_AUTH_FILES[normalized_runtime]["target_path"]
        try:
            result = await execute_configured_device_command(
                db=db,
                user_id=user_id,
                device_id=device_id,
                command_key="read_runtime_auth_file",
                env={
                    "WEGENT_RUNTIME_CONFIG_RUNTIME": normalized_runtime,
                    "WEGENT_RUNTIME_CONFIG_TARGET_PATH": target_path,
                },
                timeout_seconds=DEFAULT_COMMAND_TIMEOUT_SECONDS,
            )
        except DeviceCommandError as exc:
            raise UserRuntimeConfigSyncError(str(exc)) from exc

        if not result.get("success"):
            raise UserRuntimeConfigSyncError(
                _command_error_detail(result, "read failed")
            )

        stdout = _parse_command_stdout(result.get("stdout"))
        if not isinstance(stdout, dict) or not isinstance(stdout.get("content"), str):
            raise UserRuntimeConfigSyncError("device returned an invalid auth file")

        return self.save_auth_json(
            db,
            user_id=user_id,
            runtime=normalized_runtime,
            auth_json=stdout["content"],
            preferences=preferences,
        )

    async def sync_auth_to_devices(
        self,
        db: Session,
        *,
        user_id: int,
        runtime: str,
        preferences: Any = None,
        device_ids: Optional[Iterable[str]] = None,
    ) -> dict[str, Any]:
        """Sync a saved auth file to online devices without overwriting files."""
        normalized_runtime = _normalize_runtime(runtime)
        kind = self._get_kind(db, user_id=user_id, runtime=normalized_runtime)
        spec = self._get_spec(kind)
        if not is_runtime_user_config_enabled(preferences, normalized_runtime):
            raise UserRuntimeConfigSyncError("user runtime config is disabled")

        auth = dict(spec.get("auth") or {})
        encrypted_value = auth.get("encryptedValue")
        if not encrypted_value:
            raise UserRuntimeConfigSyncError("auth_json is not configured")

        auth_json = decrypt_sensitive_data(encrypted_value)
        if not auth_json or auth_json == encrypted_value:
            raise UserRuntimeConfigSyncError("auth_json could not be decrypted")

        target_path = (
            auth.get("targetPath")
            or RUNTIME_AUTH_FILES[normalized_runtime]["target_path"]
        )
        selected_device_ids = {device_id for device_id in device_ids or [] if device_id}
        online_devices = await device_service.get_online_devices(db, user_id)
        if selected_device_ids:
            online_devices = [
                device
                for device in online_devices
                if device.get("device_id") in selected_device_ids
            ]

        results = []
        for device in online_devices:
            device_id = str(device.get("device_id") or "")
            if not device_id:
                continue
            result = await self._sync_auth_to_device(
                db=db,
                user_id=user_id,
                device_id=device_id,
                runtime=normalized_runtime,
                target_path=target_path,
                auth_json=auth_json,
            )
            results.append(result)

        return {
            "runtime": normalized_runtime,
            "target_path": target_path,
            "total": len(results),
            "items": results,
        }

    async def _sync_auth_to_device(
        self,
        *,
        db: Session,
        user_id: int,
        device_id: str,
        runtime: str,
        target_path: str,
        auth_json: str,
    ) -> dict[str, Any]:
        try:
            result = await execute_configured_device_command(
                db=db,
                user_id=user_id,
                device_id=device_id,
                command_key="sync_runtime_auth_file",
                env={
                    "WEGENT_RUNTIME_CONFIG_RUNTIME": runtime,
                    "WEGENT_RUNTIME_CONFIG_TARGET_PATH": target_path,
                    "WEGENT_RUNTIME_CONFIG_CONTENT": auth_json,
                },
                timeout_seconds=DEFAULT_COMMAND_TIMEOUT_SECONDS,
            )
        except DeviceCommandError as exc:
            return {
                "device_id": device_id,
                "success": False,
                "status": "failed",
                "error": str(exc),
            }

        stdout = _parse_command_stdout(result.get("stdout"))
        status = "failed"
        if isinstance(stdout, dict):
            status = str(stdout.get("status") or status)
        elif result.get("success"):
            status = "synced"

        return {
            "device_id": device_id,
            "success": bool(result.get("success")),
            "status": status,
            "error": (
                None
                if result.get("success")
                else _command_error_detail(result, "sync failed")
            ),
            "stdout": stdout,
        }

    def _get_kind(
        self,
        db: Session,
        *,
        user_id: int,
        runtime: str,
    ) -> Optional[Kind]:
        return (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == USER_RUNTIME_CONFIG_KIND,
                Kind.namespace == USER_RUNTIME_CONFIG_NAMESPACE,
                Kind.name == runtime,
                Kind.is_active.is_(True),
            )
            .first()
        )

    def _get_proxy_kind(
        self,
        db: Session,
        *,
        user_id: int,
    ) -> Optional[Kind]:
        return (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == USER_PROXY_CONFIG_KIND,
                Kind.namespace == USER_RUNTIME_CONFIG_NAMESPACE,
                Kind.name == USER_PROXY_CONFIG_NAME,
                Kind.is_active.is_(True),
            )
            .first()
        )

    def _get_or_create_kind(
        self,
        db: Session,
        *,
        user_id: int,
        runtime: str,
    ) -> Kind:
        kind = self._get_kind(db, user_id=user_id, runtime=runtime)
        if kind:
            return kind

        kind = Kind(
            user_id=user_id,
            kind=USER_RUNTIME_CONFIG_KIND,
            namespace=USER_RUNTIME_CONFIG_NAMESPACE,
            name=runtime,
            json={
                "apiVersion": USER_RUNTIME_CONFIG_API_VERSION,
                "kind": USER_RUNTIME_CONFIG_KIND,
                "metadata": {
                    "name": runtime,
                    "namespace": USER_RUNTIME_CONFIG_NAMESPACE,
                },
                "spec": {
                    "runtime": runtime,
                    "updatedAt": _now_iso(),
                },
            },
            is_active=True,
        )
        db.add(kind)
        db.flush()
        return kind

    def _get_or_create_proxy_kind(
        self,
        db: Session,
        *,
        user_id: int,
    ) -> Kind:
        kind = self._get_proxy_kind(db, user_id=user_id)
        if kind:
            return kind

        kind = Kind(
            user_id=user_id,
            kind=USER_PROXY_CONFIG_KIND,
            namespace=USER_RUNTIME_CONFIG_NAMESPACE,
            name=USER_PROXY_CONFIG_NAME,
            json={
                "apiVersion": USER_RUNTIME_CONFIG_API_VERSION,
                "kind": USER_PROXY_CONFIG_KIND,
                "metadata": {
                    "name": USER_PROXY_CONFIG_NAME,
                    "namespace": USER_RUNTIME_CONFIG_NAMESPACE,
                },
                "spec": {
                    "updatedAt": _now_iso(),
                },
            },
            is_active=True,
        )
        db.add(kind)
        db.flush()
        return kind

    def _build_response(
        self,
        runtime: str,
        kind: Optional[Kind],
        preferences: Any = None,
        *,
        proxy_kind: Optional[Kind] = None,
    ) -> dict[str, Any]:
        spec = self._get_spec(kind)
        auth = dict(spec.get("auth") or {})
        proxy_spec = self._get_spec(proxy_kind)
        proxy_url = self._get_proxy_url(proxy_kind)
        return {
            "runtime": runtime,
            "display_name": RUNTIME_AUTH_FILES[runtime]["display_name"],
            "use_user_config": is_runtime_user_config_enabled(preferences, runtime),
            "use_proxy": is_runtime_proxy_enabled(preferences, runtime),
            "configured": bool(auth.get("encryptedValue")),
            "target_path": auth.get("targetPath")
            or RUNTIME_AUTH_FILES[runtime]["target_path"],
            "auth_json_sha256": auth.get("sha256"),
            "auth_json_updated_at": auth.get("updatedAt"),
            "proxy_configured": bool(proxy_url),
            "proxy_url_masked": _mask_proxy_url(proxy_url),
            "proxy_updated_at": dict(proxy_spec.get("proxy") or {}).get("updatedAt"),
            "updated_at": spec.get("updatedAt"),
        }

    def _build_proxy_response(self, kind: Optional[Kind]) -> dict[str, Any]:
        spec = self._get_spec(kind)
        proxy = dict(spec.get("proxy") or {})
        proxy_url = self._get_proxy_url(kind)
        return {
            "configured": bool(proxy_url),
            "proxy_url_masked": _mask_proxy_url(proxy_url),
            "proxy_updated_at": proxy.get("updatedAt"),
            "updated_at": spec.get("updatedAt"),
        }

    def _get_spec(self, kind: Optional[Kind]) -> dict[str, Any]:
        if not kind or not isinstance(kind.json, dict):
            return {}
        spec = kind.json.get("spec")
        return spec if isinstance(spec, dict) else {}

    def _get_proxy_url(self, kind: Optional[Kind]) -> str:
        spec = self._get_spec(kind)
        proxy = dict(spec.get("proxy") or {})
        encrypted_url = proxy.get("encryptedUrl")
        if not encrypted_url:
            return ""
        proxy_url = decrypt_sensitive_data(encrypted_url)
        if not proxy_url or proxy_url == encrypted_url:
            return ""
        return proxy_url


user_runtime_config_service = UserRuntimeConfigService()
