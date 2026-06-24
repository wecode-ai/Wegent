import pytest
from pydantic import ValidationError
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource

from wecode.config.task_sharding_config import TaskShardingSettings

pytestmark = pytest.mark.unit


def build_settings(**kwargs) -> TaskShardingSettings:
    class InitOnlySettings(TaskShardingSettings):
        @classmethod
        def settings_customise_sources(
            cls,
            settings_cls: type[BaseSettings],
            init_settings: PydanticBaseSettingsSource,
            env_settings: PydanticBaseSettingsSource,
            dotenv_settings: PydanticBaseSettingsSource,
            file_secret_settings: PydanticBaseSettingsSource,
        ):
            return (init_settings,)

    return InitOnlySettings(**kwargs)


def test_task_sharding_defaults_match_internal_runtime() -> None:
    settings = build_settings()

    assert settings.WECODE_INTERNAL_EXTENSIONS_ENABLED is False
    assert settings.WECODE_TASK_SHARDING_ENABLED is False
    assert settings.WECODE_TASK_SHARD_COUNT == 16
    assert settings.WECODE_TASK_SEQ_REDIS_SERVER == "redis://127.0.0.1:6379/0"
    assert settings.WECODE_TASK_SEQ_REDIS_KEY == "wecode_task_global_seq"


@pytest.mark.parametrize("value", [1, 2, 16, 1024])
def test_task_shard_count_accepts_power_of_two_slot_range(value: int) -> None:
    settings = build_settings(WECODE_TASK_SHARD_COUNT=value)

    assert settings.WECODE_TASK_SHARD_COUNT == value


@pytest.mark.parametrize("value", [0, 3, 1025])
def test_task_shard_count_requires_power_of_two_slot_range(value: int) -> None:
    with pytest.raises(ValidationError):
        build_settings(WECODE_TASK_SHARD_COUNT=value)
