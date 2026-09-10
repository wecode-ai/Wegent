"""Resolve GitHub/GitLab credentials from the local gh/glab CLI state.

The project event poller may run on a developer machine where the gh and glab
CLIs already carry the credentials used to push PR/MRs. This module reads those
local credentials so branch event collectors do not require a separately
configured connector credential.

gh stores its token in the macOS keychain by default (falling back to
``~/.config/gh/hosts.yml``), while glab keeps per-host tokens in its config
YAML. Path discovery covers macOS, Linux and Windows so polling stays usable
across developer machines.
"""

from __future__ import annotations

import logging
import os
import pathlib
import shutil
import subprocess
from typing import Any, Mapping
from urllib.parse import urlparse

import yaml

logger = logging.getLogger(__name__)


def _host_from_url(value: str | None) -> str:
    if not value:
        return ""
    candidate = value if "://" in value else f"https://{value}"
    parsed = urlparse(candidate)
    return (parsed.netloc or parsed.path).strip().lower()


def _glab_config_candidates() -> list[pathlib.Path]:
    candidates: list[pathlib.Path] = []
    override = os.environ.get("GLAB_CONFIG")
    if override:
        candidates.append(pathlib.Path(override))
    if os.name == "nt":
        app_data = os.environ.get("APPDATA")
        if app_data:
            candidates.append(pathlib.Path(app_data) / "glab-cli" / "config.yml")
    home = pathlib.Path.home()
    candidates.append(
        home / "Library" / "Application Support" / "glab-cli" / "config.yml"
    )
    xdg_home = os.environ.get("XDG_CONFIG_HOME")
    if xdg_home:
        candidates.append(pathlib.Path(xdg_home) / "glab-cli" / "config.yml")
    candidates.append(home / ".config" / "glab-cli" / "config.yml")
    return candidates


def _gh_hosts_candidates() -> list[pathlib.Path]:
    candidates: list[pathlib.Path] = []
    if os.name == "nt":
        app_data = os.environ.get("APPDATA")
        if app_data:
            candidates.append(pathlib.Path(app_data) / "GitHub CLI" / "hosts.yml")
    home = pathlib.Path.home()
    candidates.append(home / ".config" / "gh" / "hosts.yml")
    return candidates


def _load_yaml(path: pathlib.Path) -> Mapping[str, Any] | None:
    if not path.exists():
        return None
    try:
        value = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        logger.warning("[MachineCli] Unable to parse credential file %s", path)
        return None
    return value if isinstance(value, dict) else None


def _glab_token(host: str) -> str | None:
    for path in _glab_config_candidates():
        data = _load_yaml(path)
        if data is None:
            continue
        hosts = data.get("hosts")
        if not isinstance(hosts, dict):
            continue
        entry = hosts.get(host)
        if isinstance(entry, dict) and entry.get("token"):
            return str(entry["token"])
    return None


def _gh_token(host: str) -> str | None:
    gh = shutil.which("gh")
    if gh is not None:
        try:
            completed = subprocess.run(
                [gh, "auth", "token", "--hostname", host],
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            completed = None
        if completed is not None and completed.returncode == 0:
            token = completed.stdout.strip()
            if token:
                return token
    for path in _gh_hosts_candidates():
        data = _load_yaml(path)
        if data is None:
            continue
        entry = data.get(host)
        if isinstance(entry, dict) and entry.get("oauth_token"):
            return str(entry["oauth_token"])
    return None


def machine_cli_token(*, source_type: str, instance_url: str | None) -> str:
    """Return a machine-local token for one event source, or raise ValueError."""

    host = _host_from_url(instance_url) or (
        "gitlab.com" if source_type == "gitlab" else "github.com"
    )
    token: str | None = None
    if source_type == "gitlab":
        token = _glab_token(host)
    elif source_type == "github":
        token = _gh_token(host)
    else:
        raise ValueError(f"machine credentials are unavailable for {source_type}")
    if not token:
        cli = "glab" if source_type == "gitlab" else "gh"
        raise ValueError(
            f"Machine CLI credential unavailable: {cli} is not logged in to {host} "
            f"(run '{cli} auth login' and try again)"
        )
    return token
