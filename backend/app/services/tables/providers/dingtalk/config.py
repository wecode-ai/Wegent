"""
DingTalk Provider configuration loading.
"""

import json
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class UserMappingConfig(BaseModel):
    """User mapping configuration."""

    model_config = ConfigDict(populate_by_name=True)

    base_id: str = Field(alias="baseId")
    sheet_id: str = Field(alias="sheetId")


class DingtalkConfig(BaseModel):
    """DingTalk configuration."""

    model_config = ConfigDict(populate_by_name=True)

    app_key: str = Field(alias="appKey")
    app_secret: str = Field(alias="appSecret")
    operator_id: str = Field(alias="operatorId")
    user_mapping: Optional[UserMappingConfig] = Field(default=None, alias="userMapping")


def get_dingtalk_config() -> DingtalkConfig:
    """
    Load DingTalk configuration from environment variables.

    Environment variable format:
    DATA_TABLE_CONFIG={
        "dingtalk": {
            "appKey": "...",
            "appSecret": "...",
            "operatorId": "...",
            "userMapping": {
                "baseId": "...",
                "sheetId": "..."
            }
        }
    }

    Returns:
        DingtalkConfig object

    Raises:
        ValueError: If configuration format is incorrect or required fields are missing
    """
    # Import here to avoid circular import
    from app.core.config import settings

    config_str = settings.DATA_TABLE_CONFIG or "{}"
    try:
        config_dict = json.loads(config_str)
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid DATA_TABLE_CONFIG format: {e}")

    dingtalk_config = config_dict.get("dingtalk", {})

    if not dingtalk_config:
        raise ValueError("Missing 'dingtalk' configuration in DATA_TABLE_CONFIG")

    # Use Pydantic to parse and validate the configuration
    # This will handle camelCase -> snake_case conversion via aliases
    return DingtalkConfig(**dingtalk_config)
