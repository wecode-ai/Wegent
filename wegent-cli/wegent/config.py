"""Configuration management for wegent CLI."""

import os
from pathlib import Path
from typing import Optional

import yaml

CONFIG_DIR = Path.home() / ".wegent"
CONFIG_FILE = CONFIG_DIR / "config.yaml"

DEFAULT_CONFIG = {
    "server": "http://localhost:8000",
    "namespace": "default",
    "token": None,
}


def ensure_config_dir() -> None:
    """Ensure config directory exists."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)


def load_config() -> dict:
    """Load configuration from file or environment variables."""
    config = DEFAULT_CONFIG.copy()

    # Load from file if exists
    if CONFIG_FILE.exists():
        with open(CONFIG_FILE, "r") as f:
            file_config = yaml.safe_load(f) or {}
            config.update(file_config)

    # Environment variables override file config
    if os.environ.get("WEGENT_SERVER"):
        config["server"] = os.environ["WEGENT_SERVER"]
    if os.environ.get("WEGENT_NAMESPACE"):
        config["namespace"] = os.environ["WEGENT_NAMESPACE"]
    if os.environ.get("WEGENT_TOKEN"):
        config["token"] = os.environ["WEGENT_TOKEN"]

    return config


def save_config(config: dict) -> None:
    """Save configuration to file."""
    ensure_config_dir()
    with open(CONFIG_FILE, "w") as f:
        yaml.dump(config, f, default_flow_style=False)


def get_server() -> str:
    """Get API server URL."""
    return load_config()["server"]


def get_namespace() -> str:
    """Get default namespace."""
    return load_config()["namespace"]


def get_token() -> Optional[str]:
    """Get authentication token."""
    return load_config().get("token")
