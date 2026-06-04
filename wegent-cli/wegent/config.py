"""Configuration management for the Wegent CLI."""

import os
from pathlib import Path
from typing import Any, Optional

import yaml

CONFIG_DIR = Path.home() / ".wegent"
CONFIG_FILE = CONFIG_DIR / "config.yaml"

DEFAULT_CONFIG: dict[str, Any] = {
    "server": "http://localhost:8000",
    "namespace": "default",
    "token": None,
    "api_key": None,
    "mode": "chat",
}

ENV_TO_KEY = {
    "WEGENT_SERVER": "server",
    "WEGENT_NAMESPACE": "namespace",
    "WEGENT_TOKEN": "token",
    "WEGENT_API_KEY": "api_key",
    "WEGENT_MODE": "mode",
}


def ensure_config_dir(config_file: Path = CONFIG_FILE) -> None:
    """Ensure the configuration directory exists."""
    config_file.parent.mkdir(parents=True, exist_ok=True)


def load_config(config_file: Path = CONFIG_FILE) -> dict[str, Any]:
    """Load configuration from defaults, file, and environment variables."""
    config = DEFAULT_CONFIG.copy()

    if config_file.exists():
        with config_file.open("r", encoding="utf-8") as file_obj:
            try:
                file_config = yaml.safe_load(file_obj) or {}
            except yaml.YAMLError:
                file_config = {}
            if not isinstance(file_config, dict):
                file_config = {}
            config.update(file_config)

    for env_name, key in ENV_TO_KEY.items():
        value = os.environ.get(env_name)
        if value is not None and value != "":
            config[key] = value

    return config


def save_config(config: dict[str, Any], config_file: Path = CONFIG_FILE) -> None:
    """Save configuration to disk."""
    ensure_config_dir(config_file)
    with config_file.open("w", encoding="utf-8") as file_obj:
        yaml.safe_dump(config, file_obj, default_flow_style=False, sort_keys=True)


def get_server(config_file: Path = CONFIG_FILE) -> str:
    """Get Backend server URL."""
    return str(load_config(config_file=config_file)["server"])


def get_namespace(config_file: Path = CONFIG_FILE) -> str:
    """Get default namespace."""
    return str(load_config(config_file=config_file)["namespace"])


def get_token(config_file: Path = CONFIG_FILE) -> Optional[str]:
    """Get Bearer token."""
    return load_config(config_file=config_file).get("token")


def get_api_key(config_file: Path = CONFIG_FILE) -> Optional[str]:
    """Get API key."""
    return load_config(config_file=config_file).get("api_key")


def get_mode(config_file: Path = CONFIG_FILE) -> str:
    """Get default ask mode."""
    return str(load_config(config_file=config_file).get("mode") or "chat")
