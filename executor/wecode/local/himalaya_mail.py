# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Himalaya mail configuration support for the local executor.
"""

import os
import platform
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Any

from shared.logger import setup_logger

if TYPE_CHECKING:
    from executor.modes.local.runner import LocalRunner

logger = setup_logger("wecode_himalaya_mail")

MAIL_KEYCHAIN_SERVICE = "wegent.mail.sina"
MAIL_HOST = "mail.staff.sina.com.cn"
DOWNLOADS_DIR = "~/Downloads"
SENT_FOLDER_ALIAS = "已发送邮件"
DRAFTS_FOLDER_ALIAS = "草稿"
TRASH_FOLDER_ALIAS = "已删除邮件"
JUNK_FOLDER_ALIAS = "垃圾邮件"
SUPPORTED_EMAIL_DOMAINS = {"@staff.sina.com.cn", "@staff.weibo.com"}


def _toml_string(value: str) -> str:
    """Serialize a string as a TOML basic string."""

    escaped = (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\t", "\\t")
    )
    return f'"{escaped}"'


def _toml_literal_string(value: str) -> str:
    """Serialize a string as a TOML literal string."""

    escaped = value.replace("'", "''")
    return f"'{escaped}'"


def _get_mail_runtime_dir() -> Path:
    """Return the runtime directory used by Wegent mail helpers."""

    return Path.home() / ".wegent-executor" / "mail"


def _get_himalaya_config_path() -> Path:
    """Return the official Himalaya config path."""

    return Path.home() / ".config" / "himalaya" / "config.toml"


def _build_identity(account_prefix: str, email_domain: str) -> tuple[str, str, str]:
    """Build the Himalaya account name, email, and login."""

    normalized_prefix = account_prefix.strip()
    normalized_domain = email_domain.strip()

    if not normalized_prefix:
        raise ValueError("account_prefix is required")
    if normalized_domain not in SUPPORTED_EMAIL_DOMAINS:
        raise ValueError("Unsupported email domain")

    account_name = f"{normalized_prefix}-sina"
    email = f"{normalized_prefix}{normalized_domain}"
    login = f"{normalized_prefix}@staff.sina.com.cn"
    return account_name, email, login


def _write_password_file(account_name: str, password: str) -> str:
    """Persist password to a local file and return the auth command."""

    runtime_dir = _get_mail_runtime_dir()
    runtime_dir.mkdir(parents=True, exist_ok=True)

    password_path = runtime_dir / f"{account_name}.password"
    password_path.write_text(password, encoding="utf-8")
    os.chmod(password_path, 0o600)
    return f"cat {password_path}"


def _store_password(account_prefix: str, account_name: str, password: str) -> str:
    """Store password in macOS Keychain when possible, else use a local file."""

    if platform.system() == "Darwin":
        result = subprocess.run(
            [
                "security",
                "add-generic-password",
                "-U",
                "-s",
                MAIL_KEYCHAIN_SERVICE,
                "-a",
                account_prefix,
                "-w",
                password,
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            return (
                f"security find-generic-password -s '{MAIL_KEYCHAIN_SERVICE}' "
                f"-a '{account_prefix}' -w"
            )

    return _write_password_file(account_name, password)


def _render_config(
    account_prefix: str,
    account_name: str,
    email: str,
    login: str,
    auth_command: str,
) -> str:
    """Render the Himalaya config.toml content."""

    lines = [
        f"[accounts.{account_name}]",
        "default = true",
        f"email = {_toml_string(email)}",
        f"display-name = {_toml_string(account_prefix)}",
        f"downloads-dir = {_toml_string(DOWNLOADS_DIR)}",
        'backend.type = "imap"',
        f"backend.host = {_toml_string(MAIL_HOST)}",
        "backend.port = 993",
        f"backend.login = {_toml_string(login)}",
        'backend.encryption.type = "tls"',
        'backend.auth.type = "password"',
        f"backend.auth.command = {_toml_literal_string(auth_command)}",
        'message.send.backend.type = "smtp"',
        f"message.send.backend.host = {_toml_string(MAIL_HOST)}",
        "message.send.backend.port = 587",
        f"message.send.backend.login = {_toml_string(login)}",
        'message.send.backend.encryption.type = "start-tls"',
        'message.send.backend.auth.type = "password"',
        f"message.send.backend.auth.command = {_toml_literal_string(auth_command)}",
        "message.send.save-copy = true",
        f"folder.aliases.sent = {_toml_string(SENT_FOLDER_ALIAS)}",
        f"folder.aliases.drafts = {_toml_string(DRAFTS_FOLDER_ALIAS)}",
        f"folder.aliases.trash = {_toml_string(TRASH_FOLDER_ALIAS)}",
        f"folder.aliases.junk = {_toml_string(JUNK_FOLDER_ALIAS)}",
        "",
    ]
    return "\n".join(lines)


def configure_himalaya_mail(
    account_prefix: str, email_domain: str, password: str
) -> dict[str, Any]:
    """Create or update the local Himalaya config for the given mail account."""

    if not password:
        raise ValueError("password is required")

    account_name, email, login = _build_identity(account_prefix, email_domain)
    auth_command = _store_password(account_prefix.strip(), account_name, password)

    config_path = _get_himalaya_config_path()
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        _render_config(
            account_prefix.strip(), account_name, email, login, auth_command
        ),
        encoding="utf-8",
    )
    os.chmod(config_path, 0o600)

    return {
        "success": True,
        "message": "Himalaya mail config created",
        "account_name": account_name,
        "config_path": str(config_path),
    }


async def _handle_configure_himalaya_mail(data: dict[str, Any]) -> dict[str, Any]:
    """Handle the device config command from the backend."""

    try:
        return configure_himalaya_mail(
            account_prefix=str(data.get("account_prefix") or "").strip(),
            email_domain=str(data.get("email_domain") or "").strip(),
            password=str(data.get("password") or ""),
        )
    except Exception as exc:
        logger.exception("Failed to configure Himalaya mail")
        return {
            "success": False,
            "message": str(exc),
        }


def register_himalaya_mail_handlers(runner: "LocalRunner") -> None:
    """Register Himalaya mail handlers on the local runner."""

    runner.websocket_client.on(
        "device:configure_himalaya_mail",
        _handle_configure_himalaya_mail,
    )
