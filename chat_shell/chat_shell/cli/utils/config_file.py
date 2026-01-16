"""
CLI configuration file utilities.

Handles loading and saving CLI configuration from ~/.chat_shell/config.yaml
"""

import os
from pathlib import Path
from typing import Any

import yaml

DEFAULT_CONFIG = {
    "api_keys": {
        "openai": "",
        "claude": "",
        "google": "",
    },
    "base_urls": {
        "openai": None,
        "claude": None,
        "google": None,
    },
    "default_model": "claude-3-5-sonnet-20241022",
    "default_system_prompt": None,
    "storage": {
        "default": "sqlite",
        "sqlite": {
            "path": "~/.chat_shell/history.db",
        },
        "remote": {
            "url": None,
            "token": None,
        },
    },
    "defaults": {
        "temperature": 0.7,
        "max_tokens": 4096,
    },
}


def get_config_dir() -> Path:
    """Get the configuration directory path.

    Returns:
        Path to ~/.chat_shell directory
    """
    return Path.home() / ".chat_shell"


def get_config_path() -> Path:
    """Get the configuration file path.

    Returns:
        Path to ~/.chat_shell/config.yaml
    """
    return get_config_dir() / "config.yaml"


def ensure_config_dir() -> Path:
    """Ensure the configuration directory exists.

    Returns:
        Path to the configuration directory
    """
    config_dir = get_config_dir()
    config_dir.mkdir(parents=True, exist_ok=True)
    return config_dir


def load_cli_config() -> dict[str, Any]:
    """Load CLI configuration from file.

    Loads configuration from ~/.chat_shell/config.yaml.
    If the file doesn't exist, returns default configuration.

    Returns:
        Configuration dictionary
    """
    config_path = get_config_path()

    if not config_path.exists():
        return DEFAULT_CONFIG.copy()

    try:
        with open(config_path, "r", encoding="utf-8") as f:
            user_config = yaml.safe_load(f) or {}

        # Merge with defaults
        config = _deep_merge(DEFAULT_CONFIG.copy(), user_config)
        return config
    except Exception as e:
        # If config is corrupted, return defaults
        print(f"Warning: Failed to load config from {config_path}: {e}")
        return DEFAULT_CONFIG.copy()


def save_cli_config(config: dict[str, Any]) -> None:
    """Save CLI configuration to file.

    Saves configuration to ~/.chat_shell/config.yaml.
    Creates the directory if it doesn't exist.

    Args:
        config: Configuration dictionary to save
    """
    ensure_config_dir()
    config_path = get_config_path()

    with open(config_path, "w", encoding="utf-8") as f:
        yaml.dump(config, f, default_flow_style=False, allow_unicode=True)


def get_api_key(model_type: str, config: dict[str, Any] = None) -> str:
    """Get API key for the specified model type.

    Tries to get the API key from:
    1. Configuration file
    2. Environment variables

    Args:
        model_type: Model type ("openai", "claude", "google")
        config: Optional config dict, loads from file if not provided

    Returns:
        API key string, or empty string if not found
    """
    if config is None:
        config = load_cli_config()

    # Try config file first
    api_key = config.get("api_keys", {}).get(model_type, "")

    if api_key:
        return api_key

    # Try environment variables
    env_keys = {
        "openai": "OPENAI_API_KEY",
        "claude": "ANTHROPIC_API_KEY",
        "google": "GOOGLE_API_KEY",
    }

    env_var = env_keys.get(model_type, "")
    if env_var:
        return os.environ.get(env_var, "")

    return ""


def set_api_key(model_type: str, api_key: str) -> None:
    """Set API key for the specified model type.

    Args:
        model_type: Model type ("openai", "claude", "google")
        api_key: API key to set
    """
    config = load_cli_config()

    if "api_keys" not in config:
        config["api_keys"] = {}

    config["api_keys"][model_type] = api_key
    save_cli_config(config)


def get_base_url(model_type: str, config: dict[str, Any] = None) -> str | None:
    """Get base URL for the specified model type.

    Args:
        model_type: Model type ("openai", "claude", "google")
        config: Optional config dict, loads from file if not provided

    Returns:
        Base URL string, or None if not configured
    """
    if config is None:
        config = load_cli_config()

    return config.get("base_urls", {}).get(model_type)


def _deep_merge(base: dict, override: dict) -> dict:
    """Deep merge two dictionaries.

    Args:
        base: Base dictionary
        override: Dictionary with override values

    Returns:
        Merged dictionary
    """
    result = base.copy()

    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value

    return result
