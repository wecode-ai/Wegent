"""
History command - Manage chat history.
"""

import asyncio
import sys

import click


@click.group()
def history():
    """Manage chat history.

    This command group provides tools for viewing, searching, and
    managing chat history stored in the configured storage backend.
    """
    pass


@history.command("list")
@click.option(
    "--storage",
    "-s",
    default="sqlite",
    type=click.Choice(["memory", "sqlite"]),
    help="Storage backend",
)
@click.option(
    "--limit",
    "-n",
    default=20,
    type=int,
    help="Maximum number of sessions to show",
)
def list_sessions(storage: str, limit: int):
    """List all chat sessions.

    Shows a list of all available chat sessions with their IDs,
    message counts, and last activity times.

    Examples:

        # List recent sessions
        chat-shell history list

        # List more sessions
        chat-shell history list --limit 50
    """
    asyncio.run(_list_sessions_async(storage, limit))


async def _list_sessions_async(storage: str, limit: int):
    """List sessions asynchronously."""
    try:
        from rich.console import Console
        from rich.table import Table

        HAS_RICH = True
    except ImportError:
        HAS_RICH = False

    from chat_shell.cli.utils.config_file import load_cli_config
    from chat_shell.storage import StorageType, create_storage_provider

    config = load_cli_config()
    console = Console() if HAS_RICH else None

    # Initialize storage
    storage_provider = create_storage_provider(
        StorageType(storage),
        db_path=config.get("storage", {})
        .get("sqlite", {})
        .get("path", "~/.chat_shell/history.db"),
    )
    await storage_provider.initialize()

    try:
        # list_sessions returns list of session IDs
        session_ids = await storage_provider.history.list_sessions(limit=limit)

        if not session_ids:
            if HAS_RICH:
                console.print("[dim]No chat sessions found.[/dim]")
            else:
                print("No chat sessions found.")
            return

        # Get message count and last activity for each session
        sessions = []
        for session_id in session_ids:
            history = await storage_provider.history.get_history(session_id, limit=1)
            message_count = len(await storage_provider.history.get_history(session_id))
            last_activity = history[0].created_at if history else "N/A"
            sessions.append(
                {
                    "session_id": session_id,
                    "message_count": message_count,
                    "last_activity": (
                        last_activity[:19]
                        if last_activity and last_activity != "N/A"
                        else last_activity
                    ),
                }
            )

        if HAS_RICH:
            table = Table(title="Chat Sessions")
            table.add_column("Session ID", style="cyan")
            table.add_column("Messages", justify="right")
            table.add_column("Last Activity", style="green")

            for session in sessions:
                table.add_row(
                    session["session_id"],
                    str(session["message_count"]),
                    session["last_activity"],
                )

            console.print(table)
        else:
            print(f"{'Session ID':<40} {'Messages':>10} {'Last Activity':>20}")
            print("-" * 72)
            for session in sessions:
                print(
                    f"{session['session_id']:<40} "
                    f"{session['message_count']:>10} "
                    f"{session['last_activity']:>20}"
                )
    finally:
        await storage_provider.close()


@history.command("show")
@click.argument("session_id")
@click.option(
    "--storage",
    "-s",
    default="sqlite",
    type=click.Choice(["memory", "sqlite"]),
    help="Storage backend",
)
@click.option(
    "--limit",
    "-n",
    default=50,
    type=int,
    help="Maximum number of messages to show",
)
@click.option(
    "--format",
    "output_format",
    default="pretty",
    type=click.Choice(["pretty", "json", "raw"]),
    help="Output format",
)
def show_session(session_id: str, storage: str, limit: int, output_format: str):
    """Show messages from a specific session.

    Displays the chat history for the given SESSION_ID.

    Examples:

        # Show session history
        chat-shell history show my-session

        # Show as JSON
        chat-shell history show my-session --format json

        # Show last 10 messages
        chat-shell history show my-session --limit 10
    """
    asyncio.run(_show_session_async(session_id, storage, limit, output_format))


async def _show_session_async(
    session_id: str,
    storage: str,
    limit: int,
    output_format: str,
):
    """Show session asynchronously."""
    import json

    try:
        from rich.console import Console
        from rich.markdown import Markdown
        from rich.panel import Panel

        HAS_RICH = True
    except ImportError:
        HAS_RICH = False

    from chat_shell.cli.utils.config_file import load_cli_config
    from chat_shell.storage import StorageType, create_storage_provider

    config = load_cli_config()
    console = Console() if HAS_RICH else None

    # Initialize storage
    storage_provider = create_storage_provider(
        StorageType(storage),
        db_path=config.get("storage", {})
        .get("sqlite", {})
        .get("path", "~/.chat_shell/history.db"),
    )
    await storage_provider.initialize()

    try:
        history = await storage_provider.history.get_history(session_id, limit=limit)

        if not history:
            if HAS_RICH:
                console.print(f"[dim]No messages found for session: {session_id}[/dim]")
            else:
                print(f"No messages found for session: {session_id}")
            return

        if output_format == "json":
            messages = [
                {
                    "role": msg.role,
                    "content": msg.content,
                    "id": msg.id,
                    "created_at": msg.created_at,
                }
                for msg in history
            ]
            print(json.dumps(messages, ensure_ascii=False, indent=2))

        elif output_format == "raw":
            for msg in history:
                print(f"[{msg.role}]")
                print(msg.content)
                print()

        else:  # pretty
            if HAS_RICH:
                console.print(
                    Panel(f"[bold]Session: {session_id}[/bold]", border_style="blue")
                )
                for msg in history:
                    role_style = "bold blue" if msg.role == "user" else "bold green"
                    console.print(f"\n[{role_style}]{msg.role.upper()}:[/{role_style}]")
                    # Try to render as markdown if it looks like markdown
                    if any(c in str(msg.content) for c in ["#", "*", "`", "-"]):
                        try:
                            console.print(Markdown(str(msg.content)))
                        except Exception:
                            console.print(msg.content)
                    else:
                        console.print(msg.content)
            else:
                print(f"=== Session: {session_id} ===\n")
                for msg in history:
                    print(f"[{msg.role.upper()}]")
                    print(msg.content)
                    print()

    finally:
        await storage_provider.close()


@history.command("clear")
@click.argument("session_id", required=False)
@click.option(
    "--storage",
    "-s",
    default="sqlite",
    type=click.Choice(["memory", "sqlite"]),
    help="Storage backend",
)
@click.option(
    "--all",
    "clear_all",
    is_flag=True,
    help="Clear all sessions",
)
@click.option(
    "--yes",
    "-y",
    is_flag=True,
    help="Skip confirmation prompt",
)
def clear_history(session_id: str, storage: str, clear_all: bool, yes: bool):
    """Clear chat history.

    Clears the history for a specific SESSION_ID, or all sessions
    if --all is specified.

    Examples:

        # Clear specific session
        chat-shell history clear my-session

        # Clear all sessions (with confirmation)
        chat-shell history clear --all

        # Clear all without confirmation
        chat-shell history clear --all --yes
    """
    if not session_id and not clear_all:
        click.echo("Error: Specify a session ID or use --all", err=True)
        sys.exit(1)

    if clear_all and not yes:
        if not click.confirm("Are you sure you want to clear ALL chat history?"):
            click.echo("Aborted.")
            return

    asyncio.run(_clear_history_async(session_id, storage, clear_all))


async def _clear_history_async(session_id: str, storage: str, clear_all: bool):
    """Clear history asynchronously."""
    from chat_shell.cli.utils.config_file import load_cli_config
    from chat_shell.storage import StorageType, create_storage_provider

    config = load_cli_config()

    # Initialize storage
    storage_provider = create_storage_provider(
        StorageType(storage),
        db_path=config.get("storage", {})
        .get("sqlite", {})
        .get("path", "~/.chat_shell/history.db"),
    )
    await storage_provider.initialize()

    try:
        if clear_all:
            # Clear all sessions - list_sessions returns list of strings
            session_ids = await storage_provider.history.list_sessions(limit=1000)
            count = 0
            for sid in session_ids:
                await storage_provider.history.clear_history(sid)
                count += 1
            click.echo(f"Cleared {count} session(s).")
        else:
            await storage_provider.history.clear_history(session_id)
            click.echo(f"Cleared history for session: {session_id}")

    finally:
        await storage_provider.close()


@history.command("export")
@click.argument("session_id")
@click.option(
    "--storage",
    "-s",
    default="sqlite",
    type=click.Choice(["memory", "sqlite"]),
    help="Storage backend",
)
@click.option(
    "--output",
    "-o",
    default=None,
    help="Output file path (default: stdout)",
)
@click.option(
    "--format",
    "output_format",
    default="json",
    type=click.Choice(["json", "markdown", "text"]),
    help="Export format",
)
def export_history(session_id: str, storage: str, output: str, output_format: str):
    """Export chat history to a file.

    Exports the chat history for SESSION_ID to a file or stdout.

    Examples:

        # Export to JSON file
        chat-shell history export my-session -o chat.json

        # Export as markdown
        chat-shell history export my-session --format markdown

        # Export to stdout as text
        chat-shell history export my-session --format text
    """
    asyncio.run(_export_history_async(session_id, storage, output, output_format))


async def _export_history_async(
    session_id: str,
    storage: str,
    output: str,
    output_format: str,
):
    """Export history asynchronously."""
    import json
    from datetime import datetime

    from chat_shell.cli.utils.config_file import load_cli_config
    from chat_shell.storage import StorageType, create_storage_provider

    config = load_cli_config()

    # Initialize storage
    storage_provider = create_storage_provider(
        StorageType(storage),
        db_path=config.get("storage", {})
        .get("sqlite", {})
        .get("path", "~/.chat_shell/history.db"),
    )
    await storage_provider.initialize()

    try:
        history = await storage_provider.history.get_history(session_id)

        if not history:
            click.echo(f"No messages found for session: {session_id}", err=True)
            sys.exit(1)

        # Format output
        if output_format == "json":
            data = {
                "session_id": session_id,
                "exported_at": datetime.now().isoformat(),
                "messages": [
                    {
                        "role": msg.role,
                        "content": msg.content,
                        "id": msg.id,
                        "created_at": msg.created_at,
                    }
                    for msg in history
                ],
            }
            content = json.dumps(data, ensure_ascii=False, indent=2)

        elif output_format == "markdown":
            lines = [
                f"# Chat Session: {session_id}",
                f"",
                f"*Exported: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*",
                f"",
                "---",
                "",
            ]
            for msg in history:
                role_label = "**User**" if msg.role == "user" else "**Assistant**"
                lines.append(f"### {role_label}")
                lines.append("")
                lines.append(str(msg.content))
                lines.append("")
                lines.append("---")
                lines.append("")
            content = "\n".join(lines)

        else:  # text
            lines = [
                f"Session: {session_id}",
                f"Exported: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
                "=" * 60,
                "",
            ]
            for msg in history:
                lines.append(f"[{msg.role.upper()}]")
                lines.append(str(msg.content))
                lines.append("")
                lines.append("-" * 40)
                lines.append("")
            content = "\n".join(lines)

        # Output
        if output:
            with open(output, "w", encoding="utf-8") as f:
                f.write(content)
            click.echo(f"Exported to: {output}")
        else:
            print(content)

    finally:
        await storage_provider.close()
