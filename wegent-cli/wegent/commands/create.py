"""Create command - create resources interactively."""

from typing import Optional

import click
import yaml

from ..client import VALID_KINDS, WegentClient, APIError
from ..config import get_namespace


# Resource templates
TEMPLATES = {
    "ghost": {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Ghost",
        "metadata": {"name": "", "namespace": "default"},
        "spec": {"systemPrompt": "", "mcpServers": {}, "skills": []},
    },
    "model": {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Model",
        "metadata": {"name": "", "namespace": "default"},
        "spec": {
            "modelConfig": {
                "model_id": "",
                "api_key": "",
                "base_url": "",
            },
            "protocol": "openai",
            "isCustomConfig": True,
        },
    },
    "shell": {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Shell",
        "metadata": {"name": "", "namespace": "default"},
        "spec": {"runtime": "ClaudeCode", "supportModel": []},
    },
    "bot": {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Bot",
        "metadata": {"name": "", "namespace": "default"},
        "spec": {
            "ghostRef": {"name": "", "namespace": "default"},
            "shellRef": {"name": "", "namespace": "default"},
        },
    },
    "team": {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Team",
        "metadata": {"name": "", "namespace": "default"},
        "spec": {"members": [], "collaborationModel": "pipeline"},
    },
    "workspace": {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Workspace",
        "metadata": {"name": "", "namespace": "default"},
        "spec": {
            "repository": {
                "gitUrl": "",
                "gitRepo": "",
                "branchName": "main",
            }
        },
    },
    "task": {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {"name": "", "namespace": "default"},
        "spec": {
            "title": "",
            "prompt": "",
            "teamRef": {"name": "", "namespace": "default"},
            "workspaceRef": {"name": "", "namespace": "default"},
        },
    },
}


@click.command("create")
@click.argument("kind")
@click.argument("name")
@click.option("-n", "--namespace", default=None, help="Namespace")
@click.option("--dry-run", is_flag=True, help="Print resource without creating")
@click.pass_context
def create_cmd(
    ctx: click.Context,
    kind: str,
    name: str,
    namespace: Optional[str],
    dry_run: bool,
):
    """Create a resource with default template.

    \b
    Examples:
      wegent create ghost my-ghost
      wegent create bot my-bot -n production
      wegent create team my-team --dry-run

    Use --dry-run to see the template without creating.
    """
    client: WegentClient = ctx.obj["client"]
    ns = namespace or get_namespace()

    try:
        normalized_kind = client.normalize_kind(kind)
    except ValueError as e:
        click.echo(f"Error: {e}", err=True)
        raise SystemExit(1)

    if normalized_kind not in TEMPLATES:
        click.echo(f"Error: No template for kind: {normalized_kind}", err=True)
        raise SystemExit(1)

    # Create resource from template
    import copy
    resource = copy.deepcopy(TEMPLATES[normalized_kind])
    resource["metadata"]["name"] = name
    resource["metadata"]["namespace"] = ns

    if dry_run:
        click.echo(yaml.dump(resource, default_flow_style=False))
        return

    try:
        result = client.create_resource(ns, resource)
        click.echo(f"{normalized_kind}/{name} created")
    except APIError as e:
        click.echo(f"Error: {e.message}", err=True)
        raise SystemExit(1)
