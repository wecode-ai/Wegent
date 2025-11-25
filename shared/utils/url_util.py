# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
URL utility functions for handling domain and protocol
"""


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