"""
Scheduler backend factory for creating scheduler backend instances.

This module provides a registry-based factory for scheduler backends,
allowing external plugins to register custom scheduler implementations
without modifying the core codebase.

Usage:
    # Register a custom backend (e.g., in your plugin's __init__.py)
    from app.core.scheduler import register_scheduler_backend

    def my_scheduler_factory():
        return MySchedulerBackend()

    register_scheduler_backend("my_scheduler", my_scheduler_factory)

    # The backend will be automatically used when configured:
    # SCHEDULER_BACKEND=my_scheduler
"""

import logging
from typing import Callable, Dict, List, Optional

from app.core.scheduler.base import SchedulerBackend

logger = logging.getLogger(__name__)

# Type alias for scheduler backend factory function
SchedulerBackendFactory = Callable[[], SchedulerBackend]


class SchedulerBackendRegistry:
    """
    Registry for scheduler backend factories.

    This singleton class manages the registration and retrieval of
    scheduler backend factories. It allows external plugins to register
    custom scheduler backends without modifying the core codebase.

    Example:
        # Register a custom backend
        registry = SchedulerBackendRegistry()
        registry.register("xxljob", lambda: XXLJobBackend())

        # Get a backend instance
        backend = registry.get("xxljob")
    """

    _instance: Optional["SchedulerBackendRegistry"] = None
    _initialized: bool = False

    def __new__(cls) -> "SchedulerBackendRegistry":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        # Only initialize once (singleton pattern)
        if SchedulerBackendRegistry._initialized:
            return
        SchedulerBackendRegistry._initialized = True
        self._backends: Dict[str, SchedulerBackendFactory] = {}
        self._default_backend: str = "celery"
        self._active_instance: Optional[SchedulerBackend] = None

    def _register_default_backends(self) -> None:
        """Register the default Celery Beat backend."""
        from app.core.scheduler.celery_backend import CeleryBeatBackend

        self.register("celery", lambda: CeleryBeatBackend(), override=True)

    def register(
        self,
        backend_type: str,
        factory: SchedulerBackendFactory,
        override: bool = False,
    ) -> None:
        """
        Register a scheduler backend factory.

        Args:
            backend_type: The backend type identifier (e.g., "celery", "apscheduler")
            factory: A callable that returns a SchedulerBackend instance
            override: If True, allow overriding existing registrations

        Raises:
            ValueError: If backend_type is already registered and override is False
        """
        backend_type = backend_type.lower()

        if backend_type in self._backends and not override:
            raise ValueError(
                f"Scheduler backend '{backend_type}' is already registered. "
                f"Use override=True to replace it."
            )

        self._backends[backend_type] = factory
        logger.info(f"Registered scheduler backend: {backend_type}")

    def unregister(self, backend_type: str) -> bool:
        """
        Unregister a scheduler backend factory.

        Args:
            backend_type: The backend type identifier to unregister

        Returns:
            True if the backend was unregistered, False if it wasn't registered
        """
        backend_type = backend_type.lower()

        if backend_type == self._default_backend:
            logger.warning(
                f"Cannot unregister the default backend '{self._default_backend}'"
            )
            return False

        if backend_type in self._backends:
            del self._backends[backend_type]
            logger.info(f"Unregistered scheduler backend: {backend_type}")
            return True

        return False

    def get(self, backend_type: Optional[str] = None) -> SchedulerBackend:
        """
        Get a scheduler backend instance.

        Args:
            backend_type: The backend type identifier. If None, uses configured default.

        Returns:
            SchedulerBackend instance
        """
        if backend_type is None:
            from app.core.config import settings

            backend_type = getattr(settings, "SCHEDULER_BACKEND", self._default_backend)

        backend_type = backend_type.lower()

        if backend_type not in self._backends:
            logger.warning(
                f"Scheduler backend '{backend_type}' is not registered. "
                f"Falling back to default backend '{self._default_backend}'."
            )
            backend_type = self._default_backend

        factory = self._backends[backend_type]
        return factory()

    def get_active(self) -> Optional[SchedulerBackend]:
        """Get the currently active scheduler instance."""
        return self._active_instance

    def set_active(self, backend: SchedulerBackend) -> None:
        """Set the currently active scheduler instance."""
        self._active_instance = backend

    def clear_active(self) -> None:
        """Clear the currently active scheduler instance."""
        self._active_instance = None

    def is_registered(self, backend_type: str) -> bool:
        """
        Check if a backend type is registered.

        Args:
            backend_type: The backend type identifier

        Returns:
            True if registered, False otherwise
        """
        return backend_type.lower() in self._backends

    def list_backends(self) -> List[str]:
        """
        List all registered backend types.

        Returns:
            List of registered backend type identifiers
        """
        return list(self._backends.keys())

    def set_default(self, backend_type: str) -> None:
        """
        Set the default backend type.

        Args:
            backend_type: The backend type to use as default

        Raises:
            ValueError: If backend_type is not registered
        """
        backend_type = backend_type.lower()

        if backend_type not in self._backends:
            raise ValueError(
                f"Cannot set default to unregistered backend '{backend_type}'"
            )

        self._default_backend = backend_type
        logger.info(f"Set default scheduler backend to: {backend_type}")

    @property
    def default_backend(self) -> str:
        """Get the default backend type."""
        return self._default_backend


# Global registry instance
_registry = SchedulerBackendRegistry()


# ============ Convenience Functions ============


def register_scheduler_backend(
    backend_type: str,
    factory: SchedulerBackendFactory,
    override: bool = False,
) -> None:
    """
    Register a scheduler backend factory.

    This is the main entry point for external plugins to register
    custom scheduler backends.

    Args:
        backend_type: The backend type identifier (e.g., "celery", "apscheduler")
        factory: A callable that returns a SchedulerBackend instance
        override: If True, allow overriding existing registrations

    Example:
        from app.core.scheduler import register_scheduler_backend

        def create_xxljob_backend():
            return XXLJobBackend(
                admin_addresses=["http://xxl-job-admin:8080"],
                app_name="wegent-executor",
            )

        register_scheduler_backend("xxljob", create_xxljob_backend)
    """
    _registry.register(backend_type, factory, override)


def unregister_scheduler_backend(backend_type: str) -> bool:
    """
    Unregister a scheduler backend factory.

    Args:
        backend_type: The backend type identifier to unregister

    Returns:
        True if the backend was unregistered, False if it wasn't registered
    """
    return _registry.unregister(backend_type)


def list_scheduler_backends() -> List[str]:
    """
    List all registered scheduler backend types.

    Returns:
        List of registered backend type identifiers
    """
    return _registry.list_backends()


def is_scheduler_backend_registered(backend_type: str) -> bool:
    """
    Check if a scheduler backend type is registered.

    Args:
        backend_type: The backend type identifier

    Returns:
        True if registered, False otherwise
    """
    return _registry.is_registered(backend_type)


def get_scheduler_backend(backend_type: Optional[str] = None) -> SchedulerBackend:
    """
    Get a scheduler backend instance.

    Creates and returns the appropriate scheduler backend based on
    the SCHEDULER_BACKEND configuration setting or the specified type.

    Args:
        backend_type: Optional backend type. If None, uses configuration.

    Returns:
        SchedulerBackend instance
    """
    return _registry.get(backend_type)


def get_active_scheduler() -> Optional[SchedulerBackend]:
    """
    Get the currently active scheduler instance.

    Returns:
        The active SchedulerBackend instance, or None if not started
    """
    return _registry.get_active()


def set_active_scheduler(backend: SchedulerBackend) -> None:
    """
    Set the currently active scheduler instance.

    Args:
        backend: The SchedulerBackend instance to set as active
    """
    _registry.set_active(backend)


def clear_active_scheduler() -> None:
    """Clear the currently active scheduler instance."""
    _registry.clear_active()
