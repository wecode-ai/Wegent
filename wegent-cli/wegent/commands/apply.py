"""Apply command - create or update resources from files."""

from pathlib import Path
from typing import List, Optional

import click
import yaml

from ..client import WegentClient, APIError
from ..config import get_namespace


def load_resources_from_file(filepath: str) -> List[dict]:
    """Load resources from YAML file (supports multi-document)."""
    resources = []
    with open(filepath, "r") as f:
        for doc in yaml.safe_load_all(f):
            if doc:
                if isinstance(doc, list):
                    resources.extend(doc)
                else:
                    resources.append(doc)
    return resources


@click.command("apply")
@click.option("-f", "--filename", multiple=True, required=True, help="File(s) containing resources")
@click.option("-n", "--namespace", default=None, help="Override namespace for resources")
@click.pass_context
def apply_cmd(
    ctx: click.Context,
    filename: tuple,
    namespace: Optional[str],
):
    """Apply resources from file(s).

    \b
    Examples:
      wegent apply -f ghost.yaml
      wegent apply -f bot.yaml -f team.yaml
      wegent apply -f ./resources/ -n production

    Supports YAML files with single or multiple documents (separated by ---).
    """
    client: WegentClient = ctx.obj["client"]
    ns = namespace or get_namespace()
    all_resources = []

    # Collect resources from all files
    for f in filename:
        path = Path(f)
        if path.is_dir():
            # Load all YAML files from directory
            for yaml_file in path.glob("*.yaml"):
                try:
                    all_resources.extend(load_resources_from_file(str(yaml_file)))
                    click.echo(f"Loaded: {yaml_file}")
                except Exception as e:
                    click.echo(f"Error loading {yaml_file}: {e}", err=True)
            for yaml_file in path.glob("*.yml"):
                try:
                    all_resources.extend(load_resources_from_file(str(yaml_file)))
                    click.echo(f"Loaded: {yaml_file}")
                except Exception as e:
                    click.echo(f"Error loading {yaml_file}: {e}", err=True)
        elif path.exists():
            try:
                all_resources.extend(load_resources_from_file(str(path)))
                click.echo(f"Loaded: {path}")
            except Exception as e:
                click.echo(f"Error loading {path}: {e}", err=True)
                raise SystemExit(1)
        else:
            click.echo(f"Error: File not found: {f}", err=True)
            raise SystemExit(1)

    if not all_resources:
        click.echo("No resources found in files.", err=True)
        raise SystemExit(1)

    # Override namespace if specified
    if namespace:
        for res in all_resources:
            if "metadata" in res:
                res["metadata"]["namespace"] = namespace

    # Apply resources
    try:
        result = client.apply_resources(ns, all_resources)

        # Report results
        created = result.get("created", [])
        updated = result.get("updated", [])
        errors = result.get("errors", [])

        for item in created:
            kind = item.get("kind", "Resource")
            name = item.get("metadata", {}).get("name", "unknown")
            click.echo(f"{kind.lower()}/{name} created")

        for item in updated:
            kind = item.get("kind", "Resource")
            name = item.get("metadata", {}).get("name", "unknown")
            click.echo(f"{kind.lower()}/{name} configured")

        for error in errors:
            click.echo(f"Error: {error}", err=True)

        if not created and not updated and not errors:
            click.echo(f"Applied {len(all_resources)} resource(s)")

    except APIError as e:
        click.echo(f"Error: {e.message}", err=True)
        raise SystemExit(1)
