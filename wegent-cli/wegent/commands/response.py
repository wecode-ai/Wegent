"""Response command group."""

from typing import Any

import click

from ..client import WegentClient
from ..errors import CliError
from ..io import load_structured_input
from ..output import dumps_json, dumps_yaml, error_envelope, success_envelope


def _client(ctx: click.Context) -> WegentClient:
    return ctx.obj["client"]


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


def _response_payload(input_path: str, model: str | None) -> dict[str, Any]:
    loaded = load_structured_input(input_path)
    payload = loaded if isinstance(loaded, dict) else {"input": loaded}
    if model is not None:
        payload["model"] = model
    if not payload.get("model"):
        raise CliError(
            "missing_model",
            "Response payload must include a model or --model must be provided",
        )
    return payload


@click.group("response")
def response_cmd() -> None:
    """Use the Responses API."""


@response_cmd.command("create")
@click.option(
    "--input", "input_path", required=True, help="Input path or '-' for stdin"
)
@click.option("--model", default=None, help="Response model identifier")
@click.option("--json", "json_output", is_flag=True, help="Output JSON envelope")
@click.pass_context
def create_cmd(
    ctx: click.Context,
    input_path: str,
    model: str | None,
    json_output: bool,
) -> None:
    """Create a response."""
    try:
        payload = _response_payload(input_path, model)
        _emit(_client(ctx).create_response(payload), json_output)
    except CliError as exc:
        _emit_error(exc, json_output)


@response_cmd.command("get")
@click.argument("response_id")
@click.option("--json", "json_output", is_flag=True, help="Output JSON envelope")
@click.pass_context
def get_cmd(ctx: click.Context, response_id: str, json_output: bool) -> None:
    """Get a response."""
    try:
        _emit(_client(ctx).get_response(response_id), json_output)
    except CliError as exc:
        _emit_error(exc, json_output)


@response_cmd.command("cancel")
@click.argument("response_id")
@click.option("--json", "json_output", is_flag=True, help="Output JSON envelope")
@click.pass_context
def cancel_cmd(ctx: click.Context, response_id: str, json_output: bool) -> None:
    """Cancel a response."""
    try:
        _emit(_client(ctx).cancel_response(response_id), json_output)
    except CliError as exc:
        _emit_error(exc, json_output)


@response_cmd.command("delete")
@click.argument("response_id")
@click.option("--json", "json_output", is_flag=True, help="Output JSON envelope")
@click.pass_context
def delete_cmd(ctx: click.Context, response_id: str, json_output: bool) -> None:
    """Delete a response."""
    try:
        _emit(_client(ctx).delete_response(response_id), json_output)
    except CliError as exc:
        _emit_error(exc, json_output)
