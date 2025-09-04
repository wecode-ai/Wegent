#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Common logging module, configures and provides logging functionality for the application
"""

import logging
import os

def setup_logger(name, level=logging.INFO,
                format='%(asctime)s - [in %(pathname)s:%(lineno)d] - %(levelname)s - %(message)s',
                datefmt='%Y-%m-%d %H:%M:%S'):
    """
    Configure and return a logger instance

    If environment variable LOG_LEVEL is set to DEBUG, force log level to DEBUG.
    
    Args:
        name: Logger name
        level: Logging level, default is INFO
        format: Log message format, default includes line number
        datefmt: Date format for timestamps
        
    Returns:
        logging.Logger: Configured logger instance
    """
    # Check environment variable for log level
    env_log_level = os.environ.get("LOG_LEVEL")
    if env_log_level and env_log_level.upper() == "DEBUG":
        level = logging.DEBUG

    # Configure logging
    logging.basicConfig(
        level=level,
        format=format,
        datefmt=datefmt
    )
    return logging.getLogger(name)