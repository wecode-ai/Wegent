"""Ask command."""

from typing import Any

import click

from ..client import WegentClient
from ..config import get_mode
from ..errors import CliError
from ..output import (
    dumps_json,
    error_envelope,
    extract_response_text,
    success_envelope,
)

DEFAULT_TOOLS = [{"type": "wegent_chat_bot"}]


def _client(ctx: click.Context) -> WegentClient:
    return ctx.obj["client"]


def _emit_error(error: CliError, json_output: bool) -> None:
    if json_output:
        click.echo(dumps_json(error_envelope(error)), err=True)
    else:
        click.echo(f"Error: {error.message}", err=True)
    raise SystemExit(error.exit_code)


def _default_team_model(default_teams: Any, mode: str) -> str:
    team = default_teams.get(mode) if isinstance(default_teams, dict) else None
    name = team.get("name") if isinstance(team, dict) else None
    if not name:
        raise CliError(
            "default_team_not_configured",
            f"No default team configured for mode: {mode}",
            {"mode": mode},
        )

    namespace = team.get("namespace") or "default"
    return f"{namespace}#{name}"


def _build_payload(
    client: WegentClient,
    prompt: str,
    model: str | None,
    mode: str | None,
    include_tools: bool,
) -> dict[str, Any]:
    resolved_model = model
    if resolved_model is None:
        selected_mode = mode or get_mode()
        resolved_model = _default_team_model(client.get_default_teams(), selected_mode)

    payload: dict[str, Any] = {"model": resolved_model, "input": prompt}
    if include_tools:
        payload["tools"] = DEFAULT_TOOLS
    return payload


def _emit_response(response: Any, json_output: bool) -> None:
    if json_output:
        click.echo(dumps_json(success_envelope(response)))
        return

    text = extract_response_text(response) if isinstance(response, dict) else ""
    click.echo(text if text else dumps_json(response))


@click.command("ask")
@click.argument("prompt")
@click.option("--model", default=None, help="Response model identifier")
@click.option("--mode", default=None, help="Default team mode")
@click.option("--no-tools", is_flag=True, help="Omit default Wegent chat tools")
@click.option("--json", "json_output", is_flag=True, help="Output JSON envelope")
@click.pass_context
def ask_cmd(
    ctx: click.Context,
    prompt: str,
    model: str | None,
    mode: str | None,
    no_tools: bool,
    json_output: bool,
) -> None:
    """Ask the default Wegent agent."""
    try:
        client = _client(ctx)
        payload = _build_payload(client, prompt, model, mode, not no_tools)
        _emit_response(client.create_response(payload), json_output)
    except CliError as exc:
        _emit_error(exc, json_output)
