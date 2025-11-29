"""Main CLI entry point."""

import click

from . import __version__
from .client import VALID_KINDS, WegentClient
from .config import get_server, get_token
from .commands.get import get_cmd
from .commands.apply import apply_cmd
from .commands.delete import delete_cmd
from .commands.describe import describe_cmd
from .commands.config import config_cmd
from .commands.create import create_cmd
from .commands.login import login_cmd, logout_cmd


CONTEXT_SETTINGS = dict(help_option_names=["-h", "--help"])


@click.group(context_settings=CONTEXT_SETTINGS)
@click.version_option(version=__version__, prog_name="wegent")
@click.option("-s", "--server", envvar="WEGENT_SERVER", help="API server URL")
@click.option("-t", "--token", envvar="WEGENT_TOKEN", help="Auth token")
@click.pass_context
def cli(ctx: click.Context, server: str, token: str):
    """wegent - Wegent command line tool.

    \b
    A kubectl-style CLI for managing Wegent resources.

    \b
    Resource types:
      ghost (gh)     - AI agent persona/prompt
      model (mo)     - LLM model configuration
      shell (sh)     - Runtime environment
      bot (bo)       - Combination of ghost + shell + model
      team (te)      - Group of bots
      workspace (ws) - Git repository configuration
      task (ta)      - Execution task
      skill (sk)     - Reusable AI skill

    \b
    Quick start:
      wegent config set server http://localhost:8000
      wegent get ghosts
      wegent apply -f my-resources.yaml
      wegent describe ghost my-ghost
      wegent delete ghost my-ghost

    \b
    Environment variables:
      WEGENT_SERVER    - API server URL
      WEGENT_NAMESPACE - Default namespace
      WEGENT_TOKEN     - Auth token
    """
    ctx.ensure_object(dict)
    ctx.obj["client"] = WegentClient(
        server=server or get_server(),
        token=token or get_token(),
    )


# Register commands
cli.add_command(get_cmd)
cli.add_command(apply_cmd)
cli.add_command(delete_cmd)
cli.add_command(describe_cmd)
cli.add_command(config_cmd)
cli.add_command(create_cmd)
cli.add_command(login_cmd)
cli.add_command(logout_cmd)


@cli.command("api-resources")
def api_resources():
    """List available resource types."""
    click.echo("NAME        SHORTNAMES  KIND")
    resources = [
        ("ghosts", "gh", "Ghost"),
        ("models", "mo", "Model"),
        ("shells", "sh", "Shell"),
        ("bots", "bo", "Bot"),
        ("teams", "te", "Team"),
        ("workspaces", "ws", "Workspace"),
        ("tasks", "ta", "Task"),
        ("skills", "sk", "Skill"),
    ]
    for name, short, kind in resources:
        click.echo(f"{name:12}{short:12}{kind}")


def main():
    """Main entry point."""
    cli()


if __name__ == "__main__":
    main()
