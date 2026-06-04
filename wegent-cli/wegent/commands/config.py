"""Config command - manage Wegent CLI configuration."""

from typing import Any

import click

from ..config import CONFIG_FILE, load_config, save_config
from ..output import dumps_json, success_envelope

CONFIG_KEYS = ["server", "namespace", "token", "api_key", "mode"]
SECRET_KEYS = {"token", "api_key"}


def _mask_secret(key: str, value: Any) -> Any:
    """Mask configured secret values for display."""
    if key in SECRET_KEYS and value:
        return "****"
    return value


def _display_config(config: dict[str, Any]) -> dict[str, Any]:
    """Return config values that are safe to print."""
    return {key: _mask_secret(key, config.get(key)) for key in CONFIG_KEYS}


@click.group("config")
def config_cmd():
    """Manage Wegent CLI configuration."""


@config_cmd.command("view")
@click.option("--json", "as_json", is_flag=True, help="Output JSON.")
def config_view(as_json: bool):
    """View current configuration."""
    config = _display_config(load_config(config_file=CONFIG_FILE))

    if as_json:
        click.echo(dumps_json(success_envelope(config)))
        return

    click.echo(f"Configuration file: {CONFIG_FILE}")
    click.echo("")
    for key in CONFIG_KEYS:
        value = config.get(key)
        click.echo(f"{key}: {value if value is not None else 'not set'}")


@config_cmd.command("set")
@click.argument("key", type=click.Choice(CONFIG_KEYS))
@click.argument("value")
def config_set(key: str, value: str):
    """Set a configuration value."""
    config = load_config(config_file=CONFIG_FILE)
    config[key] = value
    save_config(config, config_file=CONFIG_FILE)

    click.echo(f"Set {key} = {_mask_secret(key, value)}")


@config_cmd.command("unset")
@click.argument("key", type=click.Choice(CONFIG_KEYS))
@click.option("--json", "as_json", is_flag=True, help="Output JSON.")
def config_unset(key: str, as_json: bool):
    """Unset a configuration value."""
    config = load_config(config_file=CONFIG_FILE)
    existed = key in config
    if existed:
        del config[key]
        save_config(config, config_file=CONFIG_FILE)

    result = {"key": key, "removed": existed}
    if as_json:
        click.echo(dumps_json(success_envelope(result)))
        return

    if existed:
        click.echo(f"Unset {key}")
    else:
        click.echo(f"{key} is not set")
