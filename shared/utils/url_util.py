# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
URL utility functions for handling domain and protocol
"""


def normalize_domain(domain: str) -> str:
    """
    Normalize domain by removing protocol and trailing slashes.

    Args:
        domain: Domain name, may include protocol (e.g., "example.com" or "http://example.com")

    Returns:
        Normalized domain without protocol and trailing slashes
    """
    if not domain:
        return ""

    domain = domain.strip()

    # Remove protocol if present
    if domain.startswith("http://"):
        domain = domain[7:]
    elif domain.startswith("https://"):
        domain = domain[8:]

    # Remove trailing slashes
    domain = domain.rstrip("/")

    return domain


def domains_match(domain1: str, domain2: str) -> bool:
    """
    Check if two domains match, handling different formats (with/without protocol).

    Args:
        domain1: First domain name (e.g., "github.com" or "http://github.com")
        domain2: Second domain name (e.g., "github.com" or "https://github.com/")

    Returns:
        True if domains match after normalization

    Examples:
        >>> domains_match("github.com", "github.com")
        True
        >>> domains_match("http://github.com", "https://github.com")
        True
        >>> domains_match("https://gitlab.weibo.cn/", "gitlab.weibo.cn")
        True
        >>> domains_match("github.com", "gitlab.com")
        False
    """
    return normalize_domain(domain1) == normalize_domain(domain2)


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
