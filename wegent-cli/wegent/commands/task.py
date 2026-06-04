"""Task command group."""

from typing import Any

import click

from ..client import WegentClient
from ..errors import CliError
from ..io import load_structured_input
from ..output import dumps_json, dumps_yaml, error_envelope, success_envelope

ASSISTANT_OUTPUT_FIELDS = ("content", "response", "text", "output")


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


def _task_create_payload(input_path: str) -> dict[str, Any]:
    loaded = load_structured_input(input_path)
    if not isinstance(loaded, dict):
        raise CliError(
            "invalid_input",
            "Task create input must be a JSON object",
        )
    return loaded


def _first_output_value(data: dict[str, Any]) -> str | None:
    for field in ASSISTANT_OUTPUT_FIELDS:
        value = data.get(field)
        if isinstance(value, str) and value.strip():
            return value
    return None


def _assistant_message(subtask: Any) -> str | None:
    if not isinstance(subtask, dict) or subtask.get("role") != "assistant":
        return None

    result = subtask.get("result")
    if isinstance(result, dict):
        message = _first_output_value(result)
        if message is not None:
            return message

    return _first_output_value(subtask)


def _assistant_messages(task: Any) -> list[str]:
    if not isinstance(task, dict):
        return []

    subtasks = task.get("subtasks")
    if not isinstance(subtasks, list):
        return []

    messages: list[str] = []
    for subtask in subtasks:
        message = _assistant_message(subtask)
        if message is not None:
            messages.append(message)
    return messages


def _task_result_payload(task: Any) -> dict[str, Any]:
    return {
        "task_id": task.get("id") if isinstance(task, dict) else None,
        "status": task.get("status") if isinstance(task, dict) else None,
        "messages": _assistant_messages(task),
        "task": task,
    }


@click.group("task")
def task_cmd() -> None:
    """Manage tasks."""


@task_cmd.command("create")
@click.option(
    "--input", "input_path", required=True, help="Input path or '-' for stdin"
)
@click.option("--json", "json_output", is_flag=True, help="Output JSON envelope")
@click.pass_context
def create_cmd(ctx: click.Context, input_path: str, json_output: bool) -> None:
    """Create a task."""
    try:
        payload = _task_create_payload(input_path)
        _emit(_client(ctx).create_task(payload), json_output)
    except CliError as exc:
        _emit_error(exc, json_output)


@task_cmd.command("status")
@click.argument("task_id", type=int)
@click.option("--runtime", is_flag=True, help="Fetch runtime status")
@click.option("--json", "json_output", is_flag=True, help="Output JSON envelope")
@click.pass_context
def status_cmd(
    ctx: click.Context,
    task_id: int,
    runtime: bool,
    json_output: bool,
) -> None:
    """Get task status."""
    try:
        client = _client(ctx)
        data = client.get_task_runtime(task_id) if runtime else client.get_task(task_id)
        _emit(data, json_output)
    except CliError as exc:
        _emit_error(exc, json_output)


@task_cmd.command("result")
@click.argument("task_id", type=int)
@click.option("--json", "json_output", is_flag=True, help="Output JSON envelope")
@click.pass_context
def result_cmd(ctx: click.Context, task_id: int, json_output: bool) -> None:
    """Get task result."""
    try:
        task = _client(ctx).get_task(task_id)
        _emit(_task_result_payload(task), json_output)
    except CliError as exc:
        _emit_error(exc, json_output)


@task_cmd.command("cancel")
@click.argument("task_id", type=int)
@click.option("--json", "json_output", is_flag=True, help="Output JSON envelope")
@click.pass_context
def cancel_cmd(ctx: click.Context, task_id: int, json_output: bool) -> None:
    """Cancel a task."""
    try:
        _emit(_client(ctx).cancel_task(task_id), json_output)
    except CliError as exc:
        _emit_error(exc, json_output)
