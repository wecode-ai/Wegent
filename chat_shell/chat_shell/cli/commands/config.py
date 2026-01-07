"""
Config command - Configuration management.
"""

import sys

import click


@click.group()
def config():
    """Manage Chat Shell configuration.

    This command group provides tools for viewing and modifying
    the Chat Shell configuration stored in ~/.chat_shell/config.yaml.
    """
    pass


@config.command("show")
@click.option(
    "--format",
    "output_format",
    default="yaml",
    type=click.Choice(["yaml", "json"]),
    help="Output format",
)
def show_config(output_format: str):
    """Show current configuration.

    Displays the current configuration from ~/.chat_shell/config.yaml.

    Examples:

        # Show config as YAML
        chat-shell config show

        # Show config as JSON
        chat-shell config show --format json
    """
    import json

    import yaml

    from chat_shell.cli.utils.config_file import get_config_path, load_cli_config

    config = load_cli_config()
    config_path = get_config_path()

    # Mask API keys for display
    display_config = _mask_sensitive(config)

    click.echo(f"# Configuration file: {config_path}\n")

    if output_format == "json":
        print(json.dumps(display_config, ensure_ascii=False, indent=2))
    else:
        print(yaml.dump(display_config, default_flow_style=False, allow_unicode=True))


@config.command("get")
@click.argument("key")
def get_config_value(key: str):
    """Get a specific configuration value.

    KEY is a dot-separated path to the configuration value.

    Examples:

        # Get default model
        chat-shell config get default_model

        # Get OpenAI base URL
        chat-shell config get base_urls.openai

        # Get storage type
        chat-shell config get storage.default
    """
    from chat_shell.cli.utils.config_file import load_cli_config

    config = load_cli_config()
    value = _get_nested(config, key)

    if value is None:
        click.echo(f"Key not found: {key}", err=True)
        sys.exit(1)

    # Mask sensitive values
    if "api_key" in key.lower() or "token" in key.lower():
        if value:
            value = _mask_value(value)

    if isinstance(value, (dict, list)):
        import json

        print(json.dumps(value, ensure_ascii=False, indent=2))
    else:
        print(value)


@config.command("set")
@click.argument("key")
@click.argument("value")
def set_config_value(key: str, value: str):
    """Set a configuration value.

    KEY is a dot-separated path to the configuration value.
    VALUE is the new value to set.

    Examples:

        # Set default model
        chat-shell config set default_model gpt-4

        # Set OpenAI API key
        chat-shell config set api_keys.openai sk-xxxxx

        # Set temperature
        chat-shell config set defaults.temperature 0.5
    """
    from chat_shell.cli.utils.config_file import load_cli_config, save_cli_config

    config = load_cli_config()

    # Try to parse value as appropriate type
    parsed_value = _parse_value(value)

    _set_nested(config, key, parsed_value)
    save_cli_config(config)

    # Mask sensitive values in output
    display_value = value
    if "api_key" in key.lower() or "token" in key.lower():
        display_value = _mask_value(value)

    click.echo(f"Set {key} = {display_value}")


@config.command("unset")
@click.argument("key")
def unset_config_value(key: str):
    """Unset (remove) a configuration value.

    KEY is a dot-separated path to the configuration value.

    Examples:

        # Remove custom base URL
        chat-shell config unset base_urls.openai

        # Remove API key
        chat-shell config unset api_keys.claude
    """
    from chat_shell.cli.utils.config_file import load_cli_config, save_cli_config

    config = load_cli_config()

    if not _unset_nested(config, key):
        click.echo(f"Key not found: {key}", err=True)
        sys.exit(1)

    save_cli_config(config)
    click.echo(f"Unset {key}")


@config.command("init")
@click.option(
    "--force",
    "-f",
    is_flag=True,
    help="Overwrite existing configuration",
)
def init_config(force: bool):
    """Initialize configuration file.

    Creates a new configuration file at ~/.chat_shell/config.yaml
    with default values.

    Examples:

        # Initialize config
        chat-shell config init

        # Force overwrite existing config
        chat-shell config init --force
    """
    from chat_shell.cli.utils.config_file import (
        DEFAULT_CONFIG,
        ensure_config_dir,
        get_config_path,
        save_cli_config,
    )

    config_path = get_config_path()

    if config_path.exists() and not force:
        click.echo(f"Configuration already exists: {config_path}", err=True)
        click.echo("Use --force to overwrite.", err=True)
        sys.exit(1)

    ensure_config_dir()
    save_cli_config(DEFAULT_CONFIG)

    click.echo(f"Created configuration file: {config_path}")
    click.echo("\nNext steps:")
    click.echo("  1. Set your API keys:")
    click.echo("     chat-shell config set api_keys.openai sk-xxxxx")
    click.echo("     chat-shell config set api_keys.claude sk-ant-xxxxx")
    click.echo("  2. Start chatting:")
    click.echo("     chat-shell chat")


@config.command("path")
def show_config_path():
    """Show configuration file path.

    Displays the path to the configuration file and directory.

    Examples:

        chat-shell config path
    """
    from chat_shell.cli.utils.config_file import get_config_dir, get_config_path

    config_dir = get_config_dir()
    config_path = get_config_path()

    click.echo(f"Config directory: {config_dir}")
    click.echo(f"Config file: {config_path}")
    click.echo(f"Exists: {config_path.exists()}")


@config.command("edit")
def edit_config():
    """Open configuration file in editor.

    Opens ~/.chat_shell/config.yaml in your default editor
    ($EDITOR or $VISUAL environment variable).

    Examples:

        chat-shell config edit
    """
    import os
    import subprocess

    from chat_shell.cli.utils.config_file import (
        DEFAULT_CONFIG,
        ensure_config_dir,
        get_config_path,
        save_cli_config,
    )

    config_path = get_config_path()

    # Create config if it doesn't exist
    if not config_path.exists():
        ensure_config_dir()
        save_cli_config(DEFAULT_CONFIG)

    # Get editor from environment
    editor = os.environ.get("VISUAL") or os.environ.get("EDITOR") or "vi"

    try:
        subprocess.run([editor, str(config_path)], check=True)
    except FileNotFoundError:
        click.echo(f"Editor not found: {editor}", err=True)
        click.echo("Set $EDITOR or $VISUAL environment variable.", err=True)
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        click.echo(f"Editor exited with error: {e}", err=True)
        sys.exit(1)


def _mask_sensitive(config: dict) -> dict:
    """Mask sensitive values in config for display."""
    import copy

    result = copy.deepcopy(config)

    # Mask API keys
    if "api_keys" in result:
        for key in result["api_keys"]:
            if result["api_keys"][key]:
                result["api_keys"][key] = _mask_value(result["api_keys"][key])

    # Mask tokens
    if "storage" in result and "remote" in result["storage"]:
        if result["storage"]["remote"].get("token"):
            result["storage"]["remote"]["token"] = _mask_value(
                result["storage"]["remote"]["token"]
            )

    return result


def _mask_value(value: str) -> str:
    """Mask a sensitive value, showing only first and last 4 chars."""
    if not value or len(value) < 12:
        return "****"
    return f"{value[:4]}...{value[-4:]}"


def _get_nested(data: dict, key: str):
    """Get a nested value using dot notation."""
    parts = key.split(".")
    current = data

    for part in parts:
        if isinstance(current, dict) and part in current:
            current = current[part]
        else:
            return None

    return current


def _set_nested(data: dict, key: str, value):
    """Set a nested value using dot notation."""
    parts = key.split(".")
    current = data

    for part in parts[:-1]:
        if part not in current:
            current[part] = {}
        current = current[part]

    current[parts[-1]] = value


def _unset_nested(data: dict, key: str) -> bool:
    """Unset a nested value using dot notation. Returns True if found."""
    parts = key.split(".")
    current = data

    for part in parts[:-1]:
        if isinstance(current, dict) and part in current:
            current = current[part]
        else:
            return False

    if parts[-1] in current:
        del current[parts[-1]]
        return True

    return False


def _parse_value(value: str):
    """Parse a string value to appropriate type."""
    # Boolean
    if value.lower() in ("true", "yes", "on"):
        return True
    if value.lower() in ("false", "no", "off"):
        return False

    # None/null
    if value.lower() in ("null", "none", ""):
        return None

    # Integer
    try:
        return int(value)
    except ValueError:
        pass

    # Float
    try:
        return float(value)
    except ValueError:
        pass

    # String
    return value
