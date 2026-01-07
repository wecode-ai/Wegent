"""
Serve command - Start HTTP server.
"""

import os

import click


@click.command()
@click.option(
    "--host",
    "-h",
    default="0.0.0.0",
    help="Host to bind to",
)
@click.option(
    "--port",
    "-p",
    default=2001,
    type=int,
    help="Port to bind to",
)
@click.option(
    "--storage",
    "-s",
    default=None,
    type=click.Choice(["memory", "sqlite", "remote"]),
    help="Storage backend (default: remote for production, sqlite for dev)",
)
@click.option(
    "--db-path",
    default="~/.chat_shell/history.db",
    help="SQLite database path (for sqlite storage)",
)
@click.option(
    "--remote-url",
    default=None,
    help="Backend internal API URL (for remote storage)",
)
@click.option(
    "--remote-token",
    default=None,
    help="Internal service token (for remote storage)",
)
@click.option(
    "--reload",
    is_flag=True,
    help="Enable auto-reload for development",
)
@click.option(
    "--workers",
    "-w",
    default=1,
    type=int,
    help="Number of worker processes",
)
@click.option(
    "--dev",
    is_flag=True,
    help="Development mode (uses sqlite storage, enables reload)",
)
def serve(
    host: str,
    port: int,
    storage: str,
    db_path: str,
    remote_url: str,
    remote_token: str,
    reload: bool,
    workers: int,
    dev: bool,
):
    """Start the Chat Shell HTTP server.

    This starts a FastAPI server that exposes the /v1/response API
    for AI chat completions with SSE streaming support.

    Examples:

        # Start with default settings (remote storage for production)
        chat-shell serve

        # Development mode (sqlite storage, auto-reload)
        chat-shell serve --dev

        # Start on custom port with SQLite storage
        chat-shell serve --port 8080 --storage sqlite

        # Production with remote storage
        chat-shell serve --storage remote --remote-url http://backend:8000/internal
    """
    import uvicorn

    # Development mode overrides
    if dev:
        storage = storage or "sqlite"
        reload = True
        os.environ["CHAT_SHELL_ENVIRONMENT"] = "development"

    # Determine storage type
    final_storage = storage
    if not final_storage:
        # Check if remote URL is configured
        existing_remote_url = os.environ.get("CHAT_SHELL_REMOTE_STORAGE_URL", "")
        if existing_remote_url or remote_url:
            final_storage = "remote"
        else:
            # Default to sqlite for local dev
            final_storage = "sqlite"

    # Set environment variables (these will be read by settings when uvicorn reloads)
    os.environ["CHAT_SHELL_STORAGE_TYPE"] = final_storage
    os.environ["CHAT_SHELL_SQLITE_DB_PATH"] = db_path
    os.environ["CHAT_SHELL_HTTP_HOST"] = host
    os.environ["CHAT_SHELL_HTTP_PORT"] = str(port)

    if remote_url:
        os.environ["CHAT_SHELL_REMOTE_STORAGE_URL"] = remote_url
    if remote_token:
        os.environ["CHAT_SHELL_REMOTE_STORAGE_TOKEN"] = remote_token

    click.echo(f"Starting Chat Shell HTTP server...")
    click.echo(f"  Host: {host}")
    click.echo(f"  Port: {port}")
    click.echo(f"  Storage: {final_storage}")
    if final_storage == "remote":
        click.echo(
            f"  Remote URL: {os.environ.get('CHAT_SHELL_REMOTE_STORAGE_URL', 'not set')}"
        )
    click.echo(f"  API Docs: http://{host}:{port}/docs")
    click.echo()

    uvicorn.run(
        "chat_shell.main:app",
        host=host,
        port=port,
        reload=reload,
        workers=workers if not reload else 1,
    )
