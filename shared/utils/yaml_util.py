# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
import os

import yaml

logger = logging.getLogger(__name__)


class YamlUtil:
    @staticmethod
    def read_custom_modes():
        """
        Read customModes configuration from /wecode-agent/config/wecoder/config.yml file

        Returns:
            dict: customModes configuration content, returns empty dict if file or config doesn't exist
        """
        config_path = "/wecode-agent/config/wecoder/config.yml/customModes"
        if not os.path.exists(config_path):
            logger.error(f"Configuration file does not exist: {config_path}")
            return []

        try:
            with open(config_path, "r", encoding="utf-8") as f:
                return yaml.safe_load(f)
        except Exception as e:
            logger.error(f"Failed to read configuration file: {e}")
            return []
