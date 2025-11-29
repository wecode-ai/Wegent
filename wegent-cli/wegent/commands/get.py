"""Get command - retrieve and display resources."""

from typing import Optional

import click

from ..client import VALID_KINDS, WegentClient, APIError
from ..config import get_namespace
from ..output import (
    format_resource_json,
    format_resource_list,
    format_resource_yaml,
)


@click.command("get")
@click.argument("kind")
@click.argument("name", required=False)
@click.option("-n", "--namespace", default=None, help="Namespace (default: from config)")
@click.option("-o", "--output", type=click.Choice(["wide", "yaml", "json"]), help="Output format")
@click.option("-A", "--all-namespaces", is_flag=True, help="List from all namespaces")
@click.option("--filter", "name_filter", help="Filter by name (partial match)")
@click.pass_context
def get_cmd(
    ctx: click.Context,
    kind: str,
    name: Optional[str],
    namespace: Optional[str],
    output: Optional[str],
    all_namespaces: bool,
    name_filter: Optional[str],
):
    """Get resources.

    \b
    Examples:
      wegent get ghosts              # List all ghosts
      wegent get ghost my-ghost      # Get specific ghost
      wegent get bots -n production  # List bots in namespace
      wegent get teams -o yaml       # Output as YAML
      wegent get tasks --filter test # Filter by name

    \b
    Resource types (with aliases):
      ghost (gh), model (mo), shell (sh), bot (bo),
      team (te), workspace (ws), task (ta), skill (sk)
    """
    client: WegentClient = ctx.obj["client"]
    ns = namespace or get_namespace()

    try:
        if name:
            # Get specific resource
            resource = client.get_resource(kind, ns, name)
            if output == "yaml":
                click.echo(format_resource_yaml(resource))
            elif output == "json":
                click.echo(format_resource_json(resource))
            else:
                click.echo(format_resource_yaml(resource))
        else:
            # List resources
            resources = client.list_resources(kind, ns, name_filter)
            if output == "yaml":
                click.echo(format_resource_yaml({"items": resources}))
            elif output == "json":
                click.echo(format_resource_json({"items": resources}))
            else:
                normalized_kind = client.normalize_kind(kind)
                click.echo(format_resource_list(resources, normalized_kind))

    except ValueError as e:
        click.echo(f"Error: {e}", err=True)
        raise SystemExit(1)
    except APIError as e:
        click.echo(f"Error: {e.message}", err=True)
        raise SystemExit(1)
