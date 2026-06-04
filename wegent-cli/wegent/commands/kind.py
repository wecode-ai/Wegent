"""Kind command group for CRD resource operations."""

from typing import Any

import click

from ..client import WegentClient
from ..config import get_namespace
from ..errors import CliError
from ..io import load_structured_input
from ..output import dumps_json, dumps_yaml, error_envelope, success_envelope


def _as_resource_list(data: Any) -> list[Any]:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        items = data.get("items")
        if isinstance(items, list):
            return items
        return [data]
    raise CliError(
        "invalid_input",
        "Kind input must be an object, an items object, or a list",
    )


def _emit(data: Any, json_output: bool) -> None:
    if json_output:
        click.echo(dumps_json(success_envelope(data)))
        return
    click.echo(dumps_yaml(data))


def _emit_error(error: CliError, json_output: bool) -> None:
    if json_output:
        click.echo(dumps_json(error_envelope(error)), err=True)
    else:
        click.echo(f"Error: {error.message}", err=True)
    raise SystemExit(error.exit_code)


def _client(ctx: click.Context) -> WegentClient:
    return ctx.obj["client"]


def _namespace(namespace: str | None) -> str:
    return namespace or get_namespace()


@click.group("kind")
def kind_cmd() -> None:
    """Manage Wegent CRD resources."""


@kind_cmd.command("get")
@click.argument("kind")
@click.argument("name", required=False)
@click.option("-n", "--namespace", default=None, help="Namespace")
@click.option("--json", "json_output", is_flag=True, help="Output JSON envelope")
@click.pass_context
def get_cmd(
    ctx: click.Context,
    kind: str,
    name: str | None,
    namespace: str | None,
    json_output: bool,
) -> None:
    """Get CRD resources."""
    client = _client(ctx)
    ns = _namespace(namespace)
    try:
        data = client.get_kind(kind, ns, name) if name else client.list_kind(kind, ns)
        _emit(data, json_output)
    except CliError as exc:
        _emit_error(exc, json_output)


@kind_cmd.command("describe")
@click.argument("kind")
@click.argument("name")
@click.option("-n", "--namespace", default=None, help="Namespace")
@click.option("--json", "json_output", is_flag=True, help="Output JSON envelope")
@click.pass_context
def describe_cmd(
    ctx: click.Context,
    kind: str,
    name: str,
    namespace: str | None,
    json_output: bool,
) -> None:
    """Describe a named CRD resource."""
    client = _client(ctx)
    ns = _namespace(namespace)
    try:
        _emit(client.get_kind(kind, ns, name), json_output)
    except CliError as exc:
        _emit_error(exc, json_output)


@kind_cmd.command("apply")
@click.option("--file", "file_path", default=None, help="Path to JSON or YAML input")
@click.option("--input", "input_path", default=None, help="Input path or '-' for stdin")
@click.option("-n", "--namespace", default=None, help="Namespace")
@click.option("--json", "json_output", is_flag=True, help="Output JSON envelope")
@click.pass_context
def apply_cmd(
    ctx: click.Context,
    file_path: str | None,
    input_path: str | None,
    namespace: str | None,
    json_output: bool,
) -> None:
    """Apply CRD resources from structured input."""
    if not file_path and not input_path:
        raise click.UsageError("Provide --file or --input")

    client = _client(ctx)
    ns = _namespace(namespace)
    source = file_path or input_path
    try:
        resources = _as_resource_list(load_structured_input(source))
        _emit(client.apply_kinds(ns, resources), json_output)
    except CliError as exc:
        _emit_error(exc, json_output)


@kind_cmd.command("delete")
@click.argument("kind", required=False)
@click.argument("name", required=False)
@click.option("--input", "input_path", default=None, help="Input path or '-' for stdin")
@click.option("-n", "--namespace", default=None, help="Namespace")
@click.option("--json", "json_output", is_flag=True, help="Output JSON envelope")
@click.pass_context
def delete_cmd(
    ctx: click.Context,
    kind: str | None,
    name: str | None,
    input_path: str | None,
    namespace: str | None,
    json_output: bool,
) -> None:
    """Delete CRD resources."""
    client = _client(ctx)
    ns = _namespace(namespace)
    try:
        if input_path:
            resources = _as_resource_list(load_structured_input(input_path))
            _emit(client.delete_kinds(ns, resources), json_output)
            return

        if not kind or not name:
            raise CliError("invalid_arguments", "Provide <kind> <name> or --input")

        _emit(client.delete_kind(kind, ns, name), json_output)
    except CliError as exc:
        _emit_error(exc, json_output)
