"""Login command - authenticate with Wegent API."""

import click
import requests

from ..config import get_server, load_config, save_config


@click.command("login")
@click.option("-u", "--username", prompt="Username", help="Username for authentication")
@click.option(
    "-p",
    "--password",
    prompt="Password",
    hide_input=True,
    help="Password for authentication",
)
@click.option("-s", "--server", default=None, help="API server URL (optional)")
def login_cmd(username: str, password: str, server: str):
    """Login to Wegent API and save token.

    \b
    Examples:
      wegent login                           # Interactive login
      wegent login -u admin -p mypassword    # Login with credentials
      wegent login -s http://api.example.com # Login to specific server

    \b
    After successful login, the token is saved to ~/.wegent/config.yaml
    and will be used for subsequent commands.
    """
    # Get server URL
    api_server = server or get_server()
    api_server = api_server.rstrip("/")

    # Login endpoint
    login_url = f"{api_server}/api/auth/login"

    try:
        # Make login request
        response = requests.post(
            login_url,
            json={"user_name": username, "password": password},
            headers={"Content-Type": "application/json"},
            timeout=30,
        )

        if response.status_code == 200:
            data = response.json()
            token = data.get("access_token")

            if token:
                # Save token to config
                config = load_config()
                config["token"] = token
                if server:
                    config["server"] = server
                save_config(config)

                click.echo(click.style("✓ Login successful!", fg="green"))
                click.echo(f"  Server: {api_server}")
                click.echo(f"  User: {username}")
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
        save_config(config)
        click.echo(click.style("✓ Logged out successfully.", fg="green"))
    else:
        click.echo("No token found. Already logged out.")