# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import re
import socket

from shared.logger import setup_logger

logger = setup_logger(__name__)


def is_ip_address(host: str) -> bool:
    """
    Check if a host string is an IPv4 address.

    Args:
        host (str): Host string to check

    Returns:
        bool: True if the host is an IPv4 address, False otherwise
    """
    # Simple IPv4 address detection
    return re.match(r"^\d{1,3}(\.\d{1,3}){3}$", host) is not None


def get_host_ip() -> str:
    """
    Get the host IP address that is accessible from Docker containers.

    Returns:
        str: Host IP address or fallback to localhost
    """
    try:
        # Create a socket to determine the outgoing IP
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # Doesn't need to be reachable, just used to determine interface
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception as e:
        logger.warning(f"Failed to get host IP: {e}, falling back to localhost")
        return "localhost"
