# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Shared SSRF protection for video cards and the web scraper.
"""

import ipaddress
import logging
import socket
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# Private/internal IP ranges that should be blocked for SSRF protection
BLOCKED_IP_NETWORKS = [
    # IPv4 private ranges (RFC1918)
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    # IPv4 loopback
    ipaddress.ip_network("127.0.0.0/8"),
    # IPv4 link-local
    ipaddress.ip_network("169.254.0.0/16"),
    # IPv4 shared address space (RFC6598)
    ipaddress.ip_network("100.64.0.0/10"),
    # IPv4 unspecified addresses. These should never be valid remote
    # metadata fetch targets and may route to local services depending
    # on the runtime environment.
    ipaddress.ip_network("0.0.0.0/8"),
    # IPv6 loopback
    ipaddress.ip_network("::1/128"),
    # IPv6 link-local
    ipaddress.ip_network("fe80::/10"),
    # IPv6 unique local (RFC4193)
    ipaddress.ip_network("fc00::/7"),
    # IPv4-mapped IPv6
    ipaddress.ip_network("::ffff:0:0/96"),
    # IPv6 unspecified address.
    ipaddress.ip_network("::/128"),
]

# Cloud metadata endpoints that should be blocked
BLOCKED_HOSTS = [
    "169.254.169.254",  # AWS/GCP/Azure metadata
    "metadata.google.internal",  # GCP metadata
    "metadata.gcp.internal",  # GCP metadata
]


def _is_ip_blocked(ip_str: str) -> bool:
    """Check if an IP address is in a blocked range."""
    try:
        ip = ipaddress.ip_address(ip_str)
        for network in BLOCKED_IP_NETWORKS:
            if ip in network:
                return True
        return False
    except ValueError:
        # Invalid IP address format
        return True


def _is_host_blocked(hostname: str) -> bool:
    """
    Check if a hostname resolves to a blocked IP address.
    Performs DNS resolution and validates all resolved IPs.
    """
    # Check against blocked hostnames
    hostname_lower = hostname.lower()
    for blocked_host in BLOCKED_HOSTS:
        if hostname_lower == blocked_host or hostname_lower.endswith(
            "." + blocked_host
        ):
            logger.warning(f"Blocked request to known internal hostname: {hostname}")
            return True

    # Try to resolve the hostname
    try:
        # Get all IP addresses for the hostname
        addr_info = socket.getaddrinfo(
            hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM
        )

        for family, type_, proto, canonname, sockaddr in addr_info:
            ip_str = sockaddr[0]
            if _is_ip_blocked(ip_str):
                logger.warning(
                    f"Blocked request to internal IP: {hostname} -> {ip_str}"
                )
                return True

        return False
    except socket.gaierror as e:
        # DNS resolution failed
        logger.warning(f"DNS resolution failed for {hostname}: {e}")
        return True
    except Exception as e:
        logger.warning(f"Error checking host {hostname}: {e}")
        return True


def _validate_url_for_ssrf(url: str) -> bool:
    """
    Validate a URL for SSRF protection.
    Returns True if the URL is safe to fetch, False otherwise.
    """
    try:
        parsed = urlparse(url)

        # Only allow http and https schemes
        if parsed.scheme not in ("http", "https"):
            logger.warning(f"Blocked URL with invalid scheme: {url}")
            return False

        # Get hostname
        hostname = parsed.hostname
        if not hostname:
            logger.warning(f"Blocked URL with no hostname: {url}")
            return False

        # Check if hostname is an IP address
        try:
            ip = ipaddress.ip_address(hostname)
            if _is_ip_blocked(str(ip)):
                logger.warning(f"Blocked URL with internal IP: {url}")
                return False
        except ValueError:
            # Not an IP address, it's a hostname - resolve it
            if _is_host_blocked(hostname):
                return False

        return True
    except Exception as e:
        logger.warning(f"Error validating URL {url}: {e}")
        return False
