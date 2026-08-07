from __future__ import annotations

from wecode.config.task_sharding_config import task_sharding_settings
from wecode.task_sharding.global_id_allocator import UserScopedGlobalIdAllocator
from wecode.task_sharding.store_registration import install_task_sharding_stores
from wecode.task_sharding.task_run_metric_hooks import sharded_task_run_metric_hooks
from wecode.task_sharding.uuid_factory import RedisIdFactory, UserScopedIdFactory

_global_id_allocator: UserScopedGlobalIdAllocator | None = globals().get(
    "_global_id_allocator"
)


def _build_global_id_allocator() -> UserScopedGlobalIdAllocator:
    redis_factory = RedisIdFactory(
        server=task_sharding_settings.WECODE_TASK_SEQ_REDIS_SERVER,
        key=task_sharding_settings.WECODE_TASK_SEQ_REDIS_KEY,
        initial_sequence=task_sharding_settings.WECODE_TASK_SEQ_INITIAL_SEQUENCE,
    )
    return UserScopedGlobalIdAllocator(UserScopedIdFactory(redis_factory))


def install_task_sharding_store_patch() -> None:
    global _global_id_allocator

    shutdown_task_sharding_store_patch()
    _global_id_allocator = _build_global_id_allocator()
    install_task_sharding_stores(
        global_id_allocator=_global_id_allocator,
    )
    sharded_task_run_metric_hooks.register()


def install_task_sharding_store_patch_if_enabled() -> None:
    if (
        task_sharding_settings.WECODE_INTERNAL_EXTENSIONS_ENABLED
        and task_sharding_settings.WECODE_TASK_SHARDING_ENABLED
    ):
        install_task_sharding_store_patch()


def shutdown_task_sharding_store_patch() -> None:
    global _global_id_allocator

    sharded_task_run_metric_hooks.unregister()
    if _global_id_allocator is not None:
        _global_id_allocator.close()
    _global_id_allocator = None
