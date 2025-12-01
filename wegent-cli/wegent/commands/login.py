# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Login command - authenticate with Wegent API."""

import sys
import time
import uuid
import webbrowser

import click
import requests

from ..config import get_server, load_config, save_config

# Constants for OIDC polling
POLL_INTERVAL_SECONDS = 2
POLL_MAX_ATTEMPTS = 150  # 5 minutes total


def _get_user_auth_type(api_server: str, username: str) -> dict:
    """Query user authentication type from server."""
    url = f"{api_server}/api/auth/oidc/user-auth-type"
    try:
        response = requests.get(url, params={"username": username}, timeout=30)
        if response.status_code == 200:
            return response.json()
        return {"exists": False, "auth_source": None}
    except requests.exceptions.RequestException:
        return {"exists": False, "auth_source": None}


def _do_password_login(api_server: str, username: str, password: str) -> dict:
    """Perform password authentication."""
    login_url = f"{api_server}/api/auth/login"
    response = requests.post(
        login_url,
        json={"user_name": username, "password": password},
        headers={"Content-Type": "application/json"},
        timeout=30,
    )
    return response


def _do_oidc_login(api_server: str, username: str) -> dict:
    """Perform OIDC authentication flow."""
    # Generate session ID
    session_id = str(uuid.uuid4())

    # Initialize OIDC login
    init_url = f"{api_server}/api/auth/oidc/cli-login"
    try:
        response = requests.post(
            init_url,
            json={"session_id": session_id},
            headers={"Content-Type": "application/json"},
            timeout=30,
        )
        if response.status_code != 200:
            return {"success": False, "error": f"Failed to initialize OIDC login: {response.text}"}

        data = response.json()
        auth_url = data.get("auth_url")

        if not auth_url:
            return {"success": False, "error": "No auth URL returned from server"}

        # Open browser
        click.echo(f"\nOpening browser for authentication...")
        click.echo(f"If browser doesn't open, visit: {auth_url}\n")

        try:
            webbrowser.open(auth_url)
        except Exception:
            click.echo("Could not open browser automatically.")

        # Poll for token
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

                if poll_response.status_code == 200:
                    poll_data = poll_response.json()
                    status = poll_data.get("status")

                    if status == "success":
                        return {
                            "success": True,
                            "token": poll_data.get("access_token"),
                            "username": poll_data.get("username"),
                        }
                    elif status == "failed":
                        return {
                            "success": False,
                            "error": poll_data.get("error", "Authentication failed"),
                        }
                    # status == "pending", continue polling

                # Show progress indicator
                if (attempt + 1) % 15 == 0:
                    remaining = (POLL_MAX_ATTEMPTS - attempt - 1) * POLL_INTERVAL_SECONDS
                    click.echo(f"  Still waiting... ({remaining}s remaining)")

            except requests.exceptions.RequestException:
                pass  # Continue polling on transient errors

        return {"success": False, "error": "Authentication timeout (5 minutes)"}

    except requests.exceptions.ConnectionError:
        return {"success": False, "error": f"Failed to connect to server: {api_server}"}
    except requests.exceptions.Timeout:
        return {"success": False, "error": "Request timeout"}


@click.command("login")
@click.option("-u", "--username", default=None, help="Username for authentication")
@click.option(
    "-p",
    "--password",
    default=None,
    help="Password for authentication (only for password auth)",
)
@click.option("-s", "--server", default=None, help="API server URL (optional)")
@click.option(
    "--method",
    type=click.Choice(["auto", "password", "oidc"]),
    default="auto",
    help="Authentication method (default: auto-detect)",
)
def login_cmd(username: str, password: str, server: str, method: str):
    """Login to Wegent API and save token.

    \b
    Examples:
      wegent login                           # Interactive login (auto-detect auth method)
      wegent login -u admin                  # Interactive login for specific user
      wegent login -u admin -p mypassword    # Password login
      wegent login --method oidc             # Force OIDC login
      wegent login -s http://api.example.com # Login to specific server

    \b
    After successful login, the token is saved to ~/.wegent/config.yaml
    and will be used for subsequent commands.
    """
    # Get server URL
    api_server = server or get_server()
    api_server = api_server.rstrip("/")

    # Prompt for username if not provided
    if not username:
        username = click.prompt("Username")

    # Determine authentication method
    auth_method = method

    if auth_method == "auto":
        # Query user auth type from server
        click.echo(f"Checking authentication method for user '{username}'...")
        auth_info = _get_user_auth_type(api_server, username)

        if auth_info.get("exists"):
            auth_source = auth_info.get("auth_source")
            if auth_source == "password":
                auth_method = "password"
                click.echo(f"  Using password authentication")
            elif auth_source == "oidc":
                auth_method = "oidc"
                click.echo(f"  Using OIDC authentication")
            else:
                # auth_source == "unknown", default to OIDC
                auth_method = "oidc"
                click.echo(f"  Auth method unknown, using OIDC authentication")
        else:
            # User doesn't exist, let them choose
            click.echo(f"  User '{username}' not found.")
            choice = click.prompt(
                "Choose authentication method",
                type=click.Choice(["password", "oidc"]),
                default="oidc",
            )
            auth_method = choice

    # Perform authentication
    if auth_method == "password":
        # Password authentication
        if not password:
            password = click.prompt("Password", hide_input=True)

        try:
            response = _do_password_login(api_server, username, password)

            if response.status_code == 200:
                data = response.json()
                token = data.get("access_token")

                if token:
                    _save_login_config(server, api_server, token, "password", username)
                    click.echo(click.style("\n✓ Login successful!", fg="green"))
                    click.echo(f"  Server: {api_server}")
                    click.echo(f"  User: {username}")
                    click.echo(f"  Auth method: password")
                    click.echo("  Token saved to config.")
                else:
                    click.echo(
                        click.style("Error: No token in response", fg="red"), err=True
                    )
                    raise SystemExit(1)
            elif response.status_code == 400:
                error = response.json()
                detail = error.get("detail", "Invalid username or password")
                click.echo(click.style(f"Error: {detail}", fg="red"), err=True)
                raise SystemExit(1)
            else:
                try:
                    error = response.json()
                    detail = error.get("detail", response.text)
                except Exception:
                    detail = response.text or response.reason
                click.echo(
                    click.style(f"Error: {response.status_code} - {detail}", fg="red"),
                    err=True,
                )
                raise SystemExit(1)

        except requests.exceptions.ConnectionError:
            click.echo(
                click.style(f"Error: Failed to connect to server: {api_server}", fg="red"),
                err=True,
            )
            raise SystemExit(1)
        except requests.exceptions.Timeout:
            click.echo(click.style("Error: Request timeout", fg="red"), err=True)
            raise SystemExit(1)

    else:
        # OIDC authentication
        result = _do_oidc_login(api_server, username)

        if result.get("success"):
            token = result.get("token")
            actual_username = result.get("username", username)

            _save_login_config(server, api_server, token, "oidc", actual_username)
            click.echo(click.style("\n✓ Login successful!", fg="green"))
            click.echo(f"  Server: {api_server}")
            click.echo(f"  User: {actual_username}")
            click.echo(f"  Auth method: OIDC")
            click.echo("  Token saved to config.")
        else:
            error = result.get("error", "Unknown error")
            click.echo(click.style(f"\nError: {error}", fg="red"), err=True)
            raise SystemExit(1)


def _save_login_config(server: str, api_server: str, token: str, auth_method: str, username: str):
    """Save login configuration to file."""
    config = load_config()
    config["token"] = token
    config["auth_method"] = auth_method
    config["username"] = username
    if server:
        config["server"] = server
    save_config(config)


@click.command("logout")
def logout_cmd():
    """Logout and remove saved token.

    \b
    Example:
      wegent logout    # Remove saved token
    """
    config = load_config()
    if config.get("token"):
        del config["token"]
        # Also clear auth_method and username
        if "auth_method" in config:
            del config["auth_method"]
        if "username" in config:
            del config["username"]
        save_config(config)
        click.echo(click.style("✓ Logged out successfully.", fg="green"))
    else:
        click.echo("No token found. Already logged out.")
