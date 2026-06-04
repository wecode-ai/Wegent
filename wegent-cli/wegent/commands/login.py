# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Login command - authenticate with Wegent API."""

import time
import uuid
import webbrowser
from typing import Any

import click
import requests

from ..config import CONFIG_FILE, get_server, load_config, save_config

POLL_INTERVAL_SECONDS = 2
POLL_MAX_ATTEMPTS = 150


def _get_user_auth_type(api_server: str, username: str) -> dict[str, Any]:
    """Query user authentication type from server."""
    url = f"{api_server}/api/auth/oidc/user-auth-type"
    try:
        response = requests.get(url, params={"username": username}, timeout=30)
    except requests.exceptions.RequestException:
        return {"exists": False, "auth_source": None}

    if response.status_code == 200:
        return response.json()
    return {"exists": False, "auth_source": None}


def _do_password_login(api_server: str, username: str, password: str):
    """Perform password authentication."""
    return requests.post(
        f"{api_server}/api/auth/login",
        json={"user_name": username, "password": password},
        headers={"Content-Type": "application/json"},
        timeout=30,
    )


def _do_oidc_login(api_server: str) -> dict[str, Any]:
    """Perform OIDC authentication flow."""
    session_id = str(uuid.uuid4())

    try:
        response = requests.post(
            f"{api_server}/api/auth/oidc/cli-login",
            json={"session_id": session_id},
            headers={"Content-Type": "application/json"},
            timeout=30,
        )
    except requests.exceptions.ConnectionError:
        return {"success": False, "error": f"Failed to connect to server: {api_server}"}
    except requests.exceptions.Timeout:
        return {"success": False, "error": "Request timeout"}
    except requests.exceptions.RequestException as exc:
        return {"success": False, "error": f"Request failed: {exc}"}

    if response.status_code != 200:
        return {
            "success": False,
            "error": f"Failed to initialize OIDC login: {response.text}",
        }

    data = response.json()
    auth_url = data.get("auth_url")
    if not auth_url:
        return {"success": False, "error": "No auth URL returned from server"}

    click.echo("\nOpening browser for authentication...")
    click.echo(f"If browser doesn't open, visit: {auth_url}\n")
    try:
        webbrowser.open(auth_url)
    except Exception:
        click.echo("Could not open browser automatically.")

    click.echo("Waiting for authentication to complete...")
    poll_url = f"{api_server}/api/auth/oidc/cli-poll"

    for attempt in range(POLL_MAX_ATTEMPTS):
        time.sleep(POLL_INTERVAL_SECONDS)
        try:
            poll_response = requests.get(
                poll_url,
                params={"session_id": session_id},
                timeout=10,
            )
        except requests.exceptions.RequestException:
            continue

        if poll_response.status_code == 200:
            poll_data = poll_response.json()
            status = poll_data.get("status")
            if status == "success":
                return {
                    "success": True,
                    "token": poll_data.get("access_token"),
                    "username": poll_data.get("username"),
                }
            if status == "failed":
                return {
                    "success": False,
                    "error": poll_data.get("error", "Authentication failed"),
                }

        if (attempt + 1) % 15 == 0:
            remaining = (POLL_MAX_ATTEMPTS - attempt - 1) * POLL_INTERVAL_SECONDS
            click.echo(f"  Still waiting... ({remaining}s remaining)")

    return {"success": False, "error": "Authentication timeout (5 minutes)"}


def _save_login_config(
    server: str | None,
    api_server: str,
    token: str,
    auth_method: str,
    username: str | None,
) -> None:
    """Save login configuration to file."""
    config = load_config(config_file=CONFIG_FILE)
    config["token"] = token
    config["auth_method"] = auth_method
    config["username"] = username
    if server:
        config["server"] = api_server
    save_config(config, config_file=CONFIG_FILE)


def _extract_error_detail(response) -> str:
    """Extract error detail from a failed login response."""
    try:
        payload = response.json()
    except ValueError:
        return response.text or response.reason

    if isinstance(payload, dict):
        return str(payload.get("detail") or response.text or response.reason)
    return response.text or response.reason


@click.command("login")
@click.option("-u", "--username", default=None, help="Username for authentication")
@click.option(
    "-p",
    "--password",
    default=None,
    help="Password for authentication",
)
@click.option("-s", "--server", default=None, help="API server URL")
@click.option(
    "--method",
    type=click.Choice(["auto", "password", "oidc"]),
    default="auto",
    help="Authentication method",
)
def login_cmd(
    username: str | None,
    password: str | None,
    server: str | None,
    method: str,
):
    """Login to Wegent API and save token."""
    api_server = (server or get_server()).rstrip("/")
    auth_method = method

    if auth_method != "oidc" and not username:
        username = click.prompt("Username")

    if auth_method == "auto":
        click.echo(f"Checking authentication method for user '{username}'...")
        auth_info = _get_user_auth_type(api_server, str(username))
        if auth_info.get("exists"):
            auth_source = auth_info.get("auth_source")
            if auth_source == "password":
                auth_method = "password"
                click.echo("  Using password authentication")
            elif auth_source == "oidc":
                auth_method = "oidc"
                click.echo("  Using OIDC authentication")
            else:
                auth_method = "oidc"
                click.echo("  Auth method unknown, using OIDC authentication")
        else:
            click.echo(f"  User '{username}' not found.")
            auth_method = click.prompt(
                "Choose authentication method",
                type=click.Choice(["password", "oidc"]),
                default="oidc",
            )

    if auth_method == "password":
        if not username:
            username = click.prompt("Username")
        if not password:
            password = click.prompt("Password", hide_input=True)
        _password_login(api_server, username, password, server)
        return

    _oidc_login(api_server, username, server)


def _password_login(
    api_server: str, username: str, password: str, server: str | None
) -> None:
    """Handle password login and config persistence."""
    try:
        response = _do_password_login(api_server, username, password)
    except requests.exceptions.ConnectionError:
        click.echo(
            click.style(f"Error: Failed to connect to server: {api_server}", fg="red"),
            err=True,
        )
        raise SystemExit(1)
    except requests.exceptions.Timeout:
        click.echo(click.style("Error: Request timeout", fg="red"), err=True)
        raise SystemExit(1)

    if response.status_code != 200:
        detail = _extract_error_detail(response)
        if response.status_code == 400:
            click.echo(click.style(f"Error: {detail}", fg="red"), err=True)
        else:
            click.echo(
                click.style(f"Error: {response.status_code} - {detail}", fg="red"),
                err=True,
            )
        raise SystemExit(1)

    token = response.json().get("access_token")
    if not token:
        click.echo(click.style("Error: No token in response", fg="red"), err=True)
        raise SystemExit(1)

    _save_login_config(server, api_server, token, "password", username)
    click.echo(click.style("\nLogin successful!", fg="green"))
    click.echo(f"  Server: {api_server}")
    click.echo(f"  User: {username}")
    click.echo("  Auth method: password")
    click.echo("  Token saved to config.")


def _oidc_login(api_server: str, username: str | None, server: str | None) -> None:
    """Handle OIDC login and config persistence."""
    result = _do_oidc_login(api_server)
    if not result.get("success"):
        error = result.get("error", "Unknown error")
        click.echo(click.style(f"\nError: {error}", fg="red"), err=True)
        raise SystemExit(1)

    token = result.get("token")
    if not token:
        click.echo(click.style("Error: No token in response", fg="red"), err=True)
        raise SystemExit(1)

    actual_username = result.get("username") or username
    _save_login_config(server, api_server, token, "oidc", actual_username)
    click.echo(click.style("\nLogin successful!", fg="green"))
    click.echo(f"  Server: {api_server}")
    click.echo(f"  User: {actual_username or 'unknown'}")
    click.echo("  Auth method: OIDC")
    click.echo("  Token saved to config.")


@click.command("logout")
def logout_cmd():
    """Logout and remove saved token."""
    config = load_config(config_file=CONFIG_FILE)
    had_token = bool(config.get("token"))
    for key in ("token", "auth_method", "username"):
        config.pop(key, None)
    save_config(config, config_file=CONFIG_FILE)

    if had_token:
        click.echo(click.style("Logged out successfully.", fg="green"))
    else:
        click.echo("No token found. Already logged out.")
