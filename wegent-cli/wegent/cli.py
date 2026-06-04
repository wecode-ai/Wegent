"""Main CLI entry point."""

import click

from . import __version__
from .client import WegentClient
from .commands.ask import ask_cmd
from .commands.config import config_cmd
from .commands.kind import kind_cmd
from .commands.login import login_cmd, logout_cmd
from .commands.response import response_cmd
from .commands.task import task_cmd
from .config import get_api_key, get_server, get_token

CONTEXT_SETTINGS = {"help_option_names": ["-h", "--help"]}


@click.group(context_settings=CONTEXT_SETTINGS)
@click.version_option(version=__version__, prog_name="wegent")
@click.option("-s", "--server", envvar="WEGENT_SERVER", help="Backend server URL")
@click.option("-t", "--token", envvar="WEGENT_TOKEN", help="Bearer token")
@click.option("--api-key", envvar="WEGENT_API_KEY", help="API key")
@click.pass_context
def cli(
    ctx: click.Context,
    server: str | None,
    token: str | None,
    api_key: str | None,
):
    """Wegent command line interface."""
    ctx.ensure_object(dict)
    ctx.obj["client"] = WegentClient(
        server=server or get_server(),
        token=token if token is not None else get_token(),
        api_key=api_key if api_key is not None else get_api_key(),
    )


cli.add_command(config_cmd)
cli.add_command(login_cmd)
cli.add_command(logout_cmd)
cli.add_command(kind_cmd)
cli.add_command(task_cmd)
cli.add_command(response_cmd)
cli.add_command(ask_cmd)


def main():
    """Main entry point."""
    cli()


if __name__ == "__main__":
    main()
