# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal task sharding configuration."""

from pydantic import field_validator
from pydantic_settings import BaseSettings


class TaskShardingSettings(BaseSettings):
    """Configuration for internal UID-hash task sharding."""

    WECODE_INTERNAL_EXTENSIONS_ENABLED: bool = False
    WECODE_TASK_SHARDING_ENABLED: bool = False
    WECODE_TASK_SHARD_COUNT: int = 16
    WECODE_TASK_SEQ_REDIS_SERVER: str = "redis://127.0.0.1:6379/0"
    WECODE_TASK_SEQ_REDIS_KEY: str = "wecode_task_global_seq"
    WECODE_TASK_SEQ_INITIAL_SEQUENCE: int = 150_000

    @field_validator("WECODE_TASK_SHARD_COUNT")
    @classmethod
    def validate_wecode_task_shard_count(cls, v: int) -> int:
        if v < 1 or v > 1024 or v & (v - 1) != 0:
            raise ValueError(
                "WECODE_TASK_SHARD_COUNT must be a power of two between 1 and 1024"
            )
        return v

    @field_validator("WECODE_TASK_SEQ_INITIAL_SEQUENCE")
    @classmethod
    def validate_wecode_task_seq_initial_sequence(cls, v: int) -> int:
        if v < 0:
            raise ValueError("WECODE_TASK_SEQ_INITIAL_SEQUENCE must not be negative")
        return v

    class Config:
        env_file = ".env"
        extra = "ignore"


task_sharding_settings = TaskShardingSettings()
