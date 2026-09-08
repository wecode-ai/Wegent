# SPDX-License-Identifier: Apache-2.0
"""Delegate cloud business commands to the local native credential broker."""

from __future__ import annotations

import contextlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from contextvars import ContextVar
from pathlib import Path
from typing import Optional, Sequence

from .transport import AuthError

MAX_RESPONSE_BYTES = 8 * 1024 * 1024
_NATIVE_EXECUTION: ContextVar[bool] = ContextVar(
    "wegent_native_execution", default=False
)


@contextlib.contextmanager
def native_execution_scope():
    token = _NATIVE_EXECUTION.set(True)
    try:
        yield
    finally:
        _NATIVE_EXECUTION.reset(token)


PUBLIC_ERRORS = frozenset(
    {
        "plugin_auth_device_not_granted",
        "plugin_auth_refresh_in_progress",
        "plugin_auth_reconnect_required",
        "plugin_auth_account_selection_required",
        "plugin_auth_backend_unavailable",
        "plugin_auth_revision_conflict",
        "plugin_auth_package_sync_required",
        "plugin_auth_broker_busy",
        "plugin_auth_invalid_command",
        "plugin_auth_exchange_rejected",
    }
)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise AuthError("plugin_auth_broker_unavailable")


def _installed_id(plugin_root: Path) -> int:
    home = os.environ.get("WEGENT_EXECUTOR_HOME", "")
    if not home:
        raise AuthError("plugin_auth_package_sync_required")
    capabilities = Path(home) / "capabilities"
    manifest = capabilities / "manifest.json"
    if manifest.is_symlink() or manifest.stat().st_size > 8 * 1024 * 1024:
        raise AuthError("plugin_auth_package_sync_required")
    entries = json.loads(manifest.read_text(encoding="utf-8"))["plugins"]
    root = plugin_root.resolve(strict=True)
    matches = []
    for entry in entries.values():
        if entry.get("managed") is not True or entry.get("enabled") is not True:
            continue
        path = Path(entry["store_path"])
        path = path if path.is_absolute() else capabilities / path
        if path.resolve() == root:
            matches.append(entry["installed_plugin_id"])
    if len(matches) != 1 or type(matches[0]) is not int or matches[0] <= 0:
        raise AuthError("plugin_auth_package_sync_required")
    return matches[0]


def run_account_command(
    plugin_root: Path,
    connector_slug: str,
    arguments: Sequence[str],
    *,
    account_id: Optional[str] = None,
) -> str:
    """Return business stdout, never credentials or native provider errors."""
    try:
        url = os.environ.get("WEGENT_PLUGIN_AUTH_BROKER", "")
        token = os.environ.get("WEGENT_PLUGIN_AUTH_BROKER_TOKEN", "")
        parsed = urllib.parse.urlsplit(url)
        if (
            parsed.scheme != "http"
            or parsed.hostname != "127.0.0.1"
            or not parsed.port
            or parsed.username
            or parsed.password
            or parsed.path != "/v1/run"
            or parsed.query
            or parsed.fragment
            or len(token) != 64
            or any(c not in "0123456789abcdef" for c in token)
        ):
            raise AuthError("plugin_auth_broker_unavailable")
        payload = json.dumps(
            {
                "installed_plugin_id": _installed_id(Path(plugin_root)),
                "connector_slug": connector_slug,
                "account_id": account_id,
                "args": list(arguments),
                "working_directory": str(Path.cwd()),
            }
        ).encode("utf-8")
        if len(payload) > 65_536:
            raise AuthError("plugin_auth_invalid_command")
        request = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Authorization": "Bearer " + token,
                "Content-Type": "application/json",
            },
            method="POST",
        )
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), _NoRedirect()
        )
        try:
            response = opener.open(request, timeout=200)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            data = response.read(MAX_RESPONSE_BYTES + 1)
            if len(data) > MAX_RESPONSE_BYTES:
                raise AuthError("plugin_auth_invalid_output")
            result = json.loads(data)
            if not isinstance(result, dict):
                raise AuthError("plugin_auth_invalid_output")
            if response.status != 200:
                code = result.get("error")
                raise AuthError(
                    code if code in PUBLIC_ERRORS else "plugin_auth_execution_failed"
                )
            if set(result) != {"stdout"} or not isinstance(result["stdout"], str):
                raise AuthError("plugin_auth_invalid_output")
            return result["stdout"]
    except AuthError:
        raise
    except Exception:
        raise AuthError("plugin_auth_broker_unavailable") from None


def delegate_cloud_command(
    plugin_root: Path,
    connector_slug: str,
    arguments: Sequence[str],
    *,
    account_id: Optional[str] = None,
) -> Optional[int]:
    """Call before local auth access. None means this is an ordinary local run."""
    if _NATIVE_EXECUTION.get():
        return None
    if os.environ.get("WEGENT_PLUGIN_AUTH_MODE") != "cloud" and account_id is None:
        return None
    try:
        sys.stdout.write(
            run_account_command(
                plugin_root, connector_slug, arguments, account_id=account_id
            )
        )
        return 0
    except AuthError as error:
        print(json.dumps({"error": str(error)}))
        return 1
