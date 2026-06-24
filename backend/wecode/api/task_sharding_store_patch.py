from wecode.task_sharding import store_patch as _store_patch

_build_global_id_allocator = _store_patch._build_global_id_allocator
install_task_sharding_store_patch = _store_patch.install_task_sharding_store_patch
install_task_sharding_store_patch_if_enabled = (
    _store_patch.install_task_sharding_store_patch_if_enabled
)
shutdown_task_sharding_store_patch = _store_patch.shutdown_task_sharding_store_patch


def __getattr__(name: str):
    if name == "_global_id_allocator":
        return _store_patch._global_id_allocator
    raise AttributeError(name)
