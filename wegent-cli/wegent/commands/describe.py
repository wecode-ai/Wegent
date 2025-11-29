"""Describe command - show detailed resource information."""

from typing import Optional

import click

from ..client import WegentClient, APIError
from ..config import get_namespace
from ..output import format_describe


@click.command("describe")
@click.argument("kind")
@click.argument("name")
@click.option("-n", "--namespace", default=None, help="Namespace")
@click.pass_context
def describe_cmd(
    ctx: click.Context,
    kind: str,
    name: str,
    namespace: Optional[str],
):
    """Show detailed information about a resource.

    \b
    Examples:
      wegent describe ghost my-ghost
      wegent describe bot my-bot -n production
      wegent describe task task-001
    """
    client: WegentClient = ctx.obj["client"]
    ns = namespace or get_namespace()

    try:
        resource = client.get_resource(kind, ns, name)
        click.echo(format_describe(resource))
    except ValueError as e:
        click.echo(f"Error: {e}", err=True)
        raise SystemExit(1)
    except APIError as e:
        click.echo(f"Error: {e.message}", err=True)
        raise SystemExit(1)
