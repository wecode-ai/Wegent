# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Thread-safe singleton metaclass for service classes."""

import threading
from typing import Any, Dict


class SingletonMeta(type):
    """Thread-safe singleton metaclass.

    This metaclass implements the double-checked locking pattern to ensure
    thread-safe singleton instantiation with minimal performance overhead.

    Uses RLock (reentrant lock) to support nested singleton instantiation,
    which occurs when a singleton's __init__ creates other singletons.

    Usage:
        class MyService(metaclass=SingletonMeta):
            def __init__(self):
                # initialization code
                pass

        # Get the singleton instance
        instance = MyService()  # Creates instance on first call
        same_instance = MyService()  # Returns same instance
    """

    _instances: Dict[type, Any] = {}
    _lock = threading.RLock()  # Use RLock to support nested singleton creation

    def __call__(cls, *args: Any, **kwargs: Any) -> Any:
        """Create or return the singleton instance.

        Uses double-checked locking for thread-safe lazy initialization.

        Returns:
            The singleton instance of the class
        """
        if cls not in cls._instances:
            with cls._lock:
                # Double-check after acquiring lock
                if cls not in cls._instances:
                    instance = super().__call__(*args, **kwargs)
                    cls._instances[cls] = instance
        return cls._instances[cls]

    @classmethod
    def reset_instance(mcs, cls: type) -> None:
        """Reset the singleton instance for a class.

        This is primarily useful for testing purposes.

        Args:
            cls: The class to reset the singleton for
        """
        with mcs._lock:
            if cls in mcs._instances:
                del mcs._instances[cls]

    @classmethod
    def reset_all_instances(mcs) -> None:
        """Reset all singleton instances.

        This is primarily useful for testing purposes.
        """
        with mcs._lock:
            mcs._instances.clear()
