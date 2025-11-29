"""Config command - manage wegent configuration."""

import click

from ..config import CONFIG_FILE, load_config, save_config


@click.group("config")
def config_cmd():
    """Manage wegent configuration.

    \b
    Examples:
      wegent config view              # View current config
      wegent config set server URL    # Set API server
      wegent config set namespace NS  # Set default namespace
      wegent config set token TOKEN   # Set auth token
    """
    pass


@config_cmd.command("view")
def config_view():
    """View current configuration."""
    config = load_config()
    click.echo(f"Configuration file: {CONFIG_FILE}")
    click.echo("")
    click.echo(f"server:    {config.get('server', 'not set')}")
    click.echo(f"namespace: {config.get('namespace', 'not set')}")
    click.echo(f"token:     {'****' if config.get('token') else 'not set'}")


@config_cmd.command("set")
@click.argument("key", type=click.Choice(["server", "namespace", "token"]))
@click.argument("value")
def config_set(key: str, value: str):
    """Set a configuration value."""
    config = load_config()
    config[key] = value
    save_config(config)
    display_value = "****" if key == "token" else value
    click.echo(f"Set {key} = {display_value}")


@config_cmd.command("unset")
@click.argument("key", type=click.Choice(["server", "namespace", "token"]))
def config_unset(key: str):
    """Unset a configuration value."""
    config = load_config()
    if key in config:
        del config[key]
        save_config(config)
        click.echo(f"Unset {key}")
    else:
        click.echo(f"{key} is not set")
