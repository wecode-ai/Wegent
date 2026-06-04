"""Kind command group for CRD resource operations."""

import json
from typing import Any, cast

import click
import yaml

from ..client import WegentClient
from ..config import get_namespace
from ..errors import EXIT_API_ERROR, CliError
from ..io import read_input_text
from ..output import dumps_json, dumps_yaml, error_envelope, success_envelope

# Mirrors backend BatchService.supported_kinds for batch apply/delete validation.
SUPPORTED_RESOURCE_KINDS = {
    "Ghost",
    "Model",
    "Shell",
    "Bot",
    "Team",
    "Workspace",
    "Task",
}


def _as_resource_list(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return _validate_resource_list(data)
    if isinstance(data, dict):
        items = data.get("items")
        if isinstance(items, list):
            return _validate_resource_list(items)
        return _validate_resource_list([data])
    raise CliError(
        "invalid_input",
        "Kind input must be an object, an items object, or a list",
    )


def _validate_resource_list(resources: list[Any]) -> list[dict[str, Any]]:
    if not resources:
        raise CliError(
            "invalid_input",
            "Kind input must include at least one resource object",
        )
    if any(not isinstance(resource, dict) for resource in resources):
        raise CliError(
            "invalid_input",
            "Kind resource entries must be objects",
        )

    validated = cast(list[dict[str, Any]], resources)
    for resource in validated:
        _validate_resource_shape(resource)
    return validated


def _validate_resource_shape(resource: dict[str, Any]) -> None:
    kind = resource.get("kind")
    if not isinstance(kind, str) or not kind.strip():
        raise CliError("invalid_input", "Kind resource kind must be a non-empty string")
    if kind not in SUPPORTED_RESOURCE_KINDS:
        raise CliError(
            "invalid_input",
            f"Unsupported kind resource kind: {kind}",
            {"kind": kind, "supported_kinds": sorted(SUPPORTED_RESOURCE_KINDS)},
        )

    metadata = resource.get("metadata")
    if not isinstance(metadata, dict):
        raise CliError("invalid_input", "Kind resource metadata must be an object")

    name = metadata.get("name")
    if not isinstance(name, str) or not name.strip():
        raise CliError(
            "invalid_input",
            "Kind resource metadata.name must be a non-empty string",
        )


def _checked_batch_result(result: Any) -> Any:
    if isinstance(result, dict) and result.get("success") is False:
        message = result.get("message")
        raise CliError(
            "batch_operation_failed",
            message if isinstance(message, str) else "Kind batch operation failed",
            {"results": result.get("results"), "response": result},
            EXIT_API_ERROR,
        )
    return result


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


def _usage_error(message: str, json_output: bool) -> None:
    if json_output:
        _emit_error(CliError("invalid_arguments", message), json_output)
    raise click.UsageError(message)


def _load_resource_input(source: str) -> list[dict[str, Any]]:
    text = read_input_text(
        source,
        empty_error_code="invalid_input",
        empty_message="Kind input must include at least one resource object",
    )
    try:
        return _as_resource_list(json.loads(text))
    except json.JSONDecodeError:
        pass

    try:
        documents = [doc for doc in yaml.safe_load_all(text) if doc is not None]
    except yaml.YAMLError as exc:
        raise CliError(
            "invalid_input",
            f"Failed to parse structured input from {source}",
            {"source": source, "error": str(exc)},
        ) from exc

    if len(documents) == 1:
        return _as_resource_list(documents[0])

    resources: list[dict[str, Any]] = []
    for document in documents:
        resources.extend(_as_resource_list(document))
    return _validate_resource_list(resources)


def _client(ctx: click.Context) -> WegentClient:
    return ctx.obj["client"]


def _namespace(namespace: str | None) -> str:
    return namespace or get_namespace()


@click.group("kind")
def kind_cmd() -> None:
    """Manage Wegent CRD resources."""


@kind_cmd.command("get")
@click.argument("kind", required=False)
@click.argument("name", required=False)
@click.option("-n", "--namespace", default=None, help="Namespace")
@click.option("--json", "json_output", is_flag=True, help="Output JSON envelope")
@click.pass_context
def get_cmd(
    ctx: click.Context,
    kind: str | None,
    name: str | None,
    namespace: str | None,
    json_output: bool,
) -> None:
    """Get CRD resources."""
    if not kind:
        _usage_error("Provide <kind>", json_output)

    client = _client(ctx)
    ns = _namespace(namespace)
    try:
        data = client.get_kind(kind, ns, name) if name else client.list_kind(kind, ns)
        _emit(data, json_output)
    except CliError as exc:
        _emit_error(exc, json_output)


@kind_cmd.command("describe")
@click.argument("kind", required=False)
@click.argument("name", required=False)
@click.option("-n", "--namespace", default=None, help="Namespace")
@click.option("--json", "json_output", is_flag=True, help="Output JSON envelope")
@click.pass_context
def describe_cmd(
    ctx: click.Context,
    kind: str | None,
    name: str | None,
    namespace: str | None,
    json_output: bool,
) -> None:
    """Describe a named CRD resource."""
    if not kind or not name:
        _usage_error("Provide <kind> <name>", json_output)

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
        _usage_error("Provide --file or --input", json_output)
    if file_path and input_path:
        _usage_error("Provide only one of --file or --input", json_output)

    client = _client(ctx)
    ns = _namespace(namespace)
    source = file_path or input_path
    try:
        resources = _load_resource_input(source)
        _emit(_checked_batch_result(client.apply_kinds(ns, resources)), json_output)
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
        if input_path and (kind or name):
            raise CliError(
                "invalid_arguments",
                "Provide either <kind> <name> or --input, not both",
            )

        if input_path:
            resources = _load_resource_input(input_path)
            _emit(_checked_batch_result(client.delete_kinds(ns, resources)), json_output)
            return

        if not kind or not name:
            raise CliError("invalid_arguments", "Provide <kind> <name> or --input")

        _emit(client.delete_kind(kind, ns, name), json_output)
    except CliError as exc:
        _emit_error(exc, json_output)
