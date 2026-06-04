"""Main CLI entry point."""

import sys
from typing import Sequence

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
from .errors import CliError
from .output import dumps_json, error_envelope

CONTEXT_SETTINGS = {"help_option_names": ["-h", "--help"]}


class JsonAwareGroup(click.Group):
    """Render Click parser errors as JSON when requested by argv."""

    def main(
        self,
        args: Sequence[str] | None = None,
        prog_name: str | None = None,
        complete_var: str | None = None,
        standalone_mode: bool = True,
        windows_expand_args: bool = True,
        **extra,
    ):
        raw_args = list(sys.argv[1:] if args is None else args)
        try:
            return super().main(
                args=args,
                prog_name=prog_name,
                complete_var=complete_var,
                standalone_mode=False,
                windows_expand_args=windows_expand_args,
                **extra,
            )
        except click.ClickException as exc:
            if "--json" not in raw_args:
                if not standalone_mode:
                    raise
                exc.show()
                raise SystemExit(exc.exit_code) from exc

            error = CliError(
                "invalid_arguments",
                exc.format_message() or exc.message,
                {"click_error": exc.__class__.__name__},
                exc.exit_code,
            )
            click.echo(dumps_json(error_envelope(error)), err=True)
            if not standalone_mode:
                raise error from exc
            raise SystemExit(exc.exit_code) from exc


@click.group(cls=JsonAwareGroup, context_settings=CONTEXT_SETTINGS)
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
