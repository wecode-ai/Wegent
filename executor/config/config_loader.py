# SPDX-License-Identifier: Apache-2.0
import importlib
import json
import os
from typing import Any, Dict

from shared.logger import setup_logger

logger = setup_logger(__name__)


def dynamic_import(path: str):
    """
    Import "a.b.c.Class" and return the Class object.
    """
    parts = path.split(".")
    if len(parts) < 2:
        raise ValueError(f"Invalid import path: {path}")

    module_path = ".".join(parts[:-1])
    class_name = parts[-1]

    module = importlib.import_module(module_path)
    return getattr(module, class_name)


def load_custom_config(
    env_name: str = "CUSTOM_CONFIG",
    defaults: Dict[str, Any] = None,
) -> Dict[str, Any]:
    """
    Load custom config with dynamic module import support.
    Example:
        export CUSTOM_CONFIG='{"my_config": "executor.config.config"}'
    """

    if defaults is None:
        defaults = {}

    config_str = os.environ.get(env_name, "")
    if not config_str:
        logger.info("No custom config, using defaults")
        return defaults

    try:
        cfg_json = json.loads(config_str)
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON for {env_name}: {e}")

    result = defaults.copy()

    for key, value in cfg_json.items():
        if isinstance(value, str) and "." in value:
            # treat it as a class import path
            try:
                cls = dynamic_import(value)
                inst = cls()  # run __init__ (for env defaults)

                # allow optional method get_config()
                if hasattr(inst, "get_config"):
                    result[key] = inst.get_config()
                else:
                    result[key] = inst

                # allow optional setup_env()
                if hasattr(inst, "setup_env"):
                    inst.setup_env()

                logger.info(f"Loaded config class for '{key}'")

            except Exception as e:
                logger.error(f"Failed to import {value}: {e}")
        else:
            # static config
            result[key] = value
            logger.info(f"Loaded static config '{key}'")

    return result
