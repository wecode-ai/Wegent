# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
URL utility functions for handling domain and protocol
"""

from urllib.parse import quote


def build_url(domain: str, path: str = "") -> str:
    """
    Build URL from domain and path, respecting protocol if present in domain

    Args:
        domain: Domain name, may include protocol (e.g., "example.com" or "http://example.com")
        path: Optional path to append (e.g., "/api/v1")

    Returns:
        Complete URL with protocol

    Examples:
        >>> build_url("example.com", "/api")
        'https://example.com/api'
        >>> build_url("http://example.com", "/api")
        'http://example.com/api'
        >>> build_url("https://example.com", "/api")
        'https://example.com/api'
    """
    if not domain:
        raise ValueError("Domain cannot be empty")

    # Check if domain already has a protocol
    if domain.startswith("http://") or domain.startswith("https://"):
        # Domain already has protocol, use it as-is
        base_url = domain.rstrip("/")
    else:
        # No protocol specified, default to https
        base_url = f"https://{domain}"

    # Append path if provided
    if path:
        path = path.lstrip("/")
        return f"{base_url}/{path}" if path else base_url

    return base_url


def build_task_notification_url(
    task_type: str,
    task_id: int,
    frontend_url: str,
    notification_url: str = None,
    jump_path: str = "/jump",
) -> str:
    """
    Build task notification URL with support for dual-network (internal/external) deployment.

    When notification_url is configured, generates a jump page URL that will redirect
    users to the appropriate URL based on their browser type:
    - DingTalk browser (mobile) -> notification_url (external access)
    - PC browser -> frontend_url (internal access)

    Args:
        task_type: Task type for URL path (e.g., "chat", "code")
        task_id: Task ID
        frontend_url: Internal frontend URL (e.g., "http://internal.example.com:3000")
        notification_url: External notification URL (e.g., "https://external.example.com").
                         If None, returns direct link to frontend_url.
        jump_path: Jump page path (default: "/jump")

    Returns:
        Task notification URL. If notification_url is configured, returns a jump page URL
        with encoded inner/outer parameters. Otherwise, returns direct link.

    Examples:
        >>> build_task_notification_url("chat", 123, "http://internal:3000")
        'http://internal:3000/chat?taskId=123'

        >>> build_task_notification_url(
        ...     "chat", 123,
        ...     "http://internal:3000",
        ...     "https://external.com",
        ...     "/jump"
        ... )
        'https://external.com/jump?target=chat&taskId=123&inner=http%3A%2F%2Finternal%3A3000&outer=https%3A%2F%2Fexternal.com'
    """
    if notification_url:
        # Build jump URL with both outer and inner targets
        # Format: {outer_url}{jump_path}?target={task_type}&taskId={task_id}&inner={inner_url}&outer={outer_url}
        return (
            f"{notification_url}{jump_path}?target={task_type}&taskId={task_id}"
            f"&inner={quote(frontend_url, safe='')}&outer={quote(notification_url, safe='')}"
        )
    else:
        # No external URL configured, use direct link
        return f"{frontend_url}/{task_type}?taskId={task_id}"
