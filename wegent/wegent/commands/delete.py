"""Delete command - delete resources."""

from pathlib import Path
from typing import List, Optional

import click
import yaml

from ..client import WegentClient, APIError
from ..config import get_namespace
from .apply import load_resources_from_file


@click.command("delete")
@click.argument("kind", required=False)
@click.argument("name", required=False)
@click.option("-f", "--filename", multiple=True, help="File(s) containing resources to delete")
@click.option("-n", "--namespace", default=None, help="Namespace")
@click.option("--all", "delete_all", is_flag=True, help="Delete all resources of this kind")
@click.option("-y", "--yes", is_flag=True, help="Skip confirmation")
@click.pass_context
def delete_cmd(
    ctx: click.Context,
    kind: Optional[str],
    name: Optional[str],
    filename: tuple,
    namespace: Optional[str],
    delete_all: bool,
    yes: bool,
):
    """Delete resources.

    \b
    Examples:
      wegent delete ghost my-ghost         # Delete specific ghost
      wegent delete -f ghost.yaml          # Delete resources from file
      wegent delete bots --all -y          # Delete all bots (skip confirm)
    """
    client: WegentClient = ctx.obj["client"]
    ns = namespace or get_namespace()

    try:
        if filename:
            # Delete from files
            all_resources = []
            for f in filename:
                path = Path(f)
                if path.exists():
                    all_resources.extend(load_resources_from_file(str(path)))
                else:
                    click.echo(f"Error: File not found: {f}", err=True)
                    raise SystemExit(1)

            if not all_resources:
                click.echo("No resources found in files.", err=True)
                raise SystemExit(1)

            if not yes:
                click.echo(f"About to delete {len(all_resources)} resource(s):")
                for res in all_resources[:5]:
                    k = res.get("kind", "Unknown")
                    n = res.get("metadata", {}).get("name", "unknown")
                    click.echo(f"  - {k}/{n}")
                if len(all_resources) > 5:
                    click.echo(f"  ... and {len(all_resources) - 5} more")
                if not click.confirm("Continue?"):
                    raise SystemExit(0)

            result = client.delete_resources(ns, all_resources)
            deleted = result.get("deleted", [])
            for item in deleted:
                k = item.get("kind", "Resource")
                n = item.get("metadata", {}).get("name", "unknown")
                click.echo(f"{k.lower()}/{n} deleted")

        elif kind and name:
            # Delete specific resource
            if not yes:
                if not click.confirm(f"Delete {kind}/{name}?"):
                    raise SystemExit(0)
            client.delete_resource(kind, ns, name)
            click.echo(f"{kind}/{name} deleted")

        elif kind and delete_all:
            # Delete all of a kind
            resources = client.list_resources(kind, ns)
            if not resources:
                click.echo(f"No {kind}s found in namespace {ns}.")
                return

            if not yes:
                click.echo(f"About to delete {len(resources)} {kind}(s):")
                for res in resources[:5]:
                    n = res.get("metadata", {}).get("name", "unknown")
                    click.echo(f"  - {n}")
                if len(resources) > 5:
                    click.echo(f"  ... and {len(resources) - 5} more")
                if not click.confirm("Continue?"):
                    raise SystemExit(0)

            for res in resources:
                n = res.get("metadata", {}).get("name")
                if n:
                    client.delete_resource(kind, ns, n)
                    click.echo(f"{kind}/{n} deleted")

        else:
            click.echo(
                "Error: Specify resource to delete:\n"
                "  wegent delete <kind> <name>\n"
                "  wegent delete -f <file>\n"
                "  wegent delete <kind> --all",
                err=True,
            )
            raise SystemExit(1)

    except ValueError as e:
        click.echo(f"Error: {e}", err=True)
        raise SystemExit(1)
    except APIError as e:
        click.echo(f"Error: {e.message}", err=True)
        raise SystemExit(1)
