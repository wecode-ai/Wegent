# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Skill tool registry for managing tool providers.

This module provides the SkillToolRegistry singleton that manages
registration and lookup of tool providers, as well as dynamic
loading of providers from skill packages.
"""

import importlib.util
import logging
import threading
from typing import Any, Optional

from langchain_core.tools import BaseTool

from .context import SkillToolContext
from .provider import SkillToolProvider

logger = logging.getLogger(__name__)


class SkillToolRegistry:
    """Central registry for skill tool providers.

    This registry implements the Service Locator pattern, allowing
    tool providers to be registered and retrieved by name.

    Usage:
        # Get singleton instance
        registry = SkillToolRegistry.get_instance()

        # Register a provider
        registry.register(MySkillToolProvider())

        # Create tools for a skill
        tools = registry.create_tools_for_skill(
            skill_config=skill_config,
            context=context
        )

    Thread Safety:
        The registry uses threading.Lock to ensure thread-safe access
        to the singleton instance and provider dictionary. All read and
        write operations are protected by the lock.
    """

    _instance: Optional["SkillToolRegistry"] = None
    _instance_lock: threading.Lock = threading.Lock()
    _providers: dict[str, SkillToolProvider]
    _providers_lock: threading.Lock

    def __init__(self) -> None:
        """Initialize the registry.

        Note: Use get_instance() to get the singleton instance.
        Direct instantiation is allowed for testing purposes.
        """
        self._providers = {}
        self._providers_lock = threading.Lock()

    @classmethod
    def get_instance(cls) -> "SkillToolRegistry":
        """Get the singleton instance of the registry.

        Uses double-checked locking pattern for thread-safe lazy initialization.

        Returns:
            The global SkillToolRegistry instance
        """
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """Reset the singleton instance (for testing only)."""
        with cls._instance_lock:
            cls._instance = None

    def register(self, provider: SkillToolProvider) -> None:
        """Register a tool provider.

        Thread-safe: Uses lock to ensure atomic check-and-register.

        Args:
            provider: Provider instance to register

        Raises:
            ValueError: If provider name is already registered
        """
        name = provider.provider_name
        with self._providers_lock:
            if name in self._providers:
                raise ValueError(f"Provider '{name}' is already registered")
            self._providers[name] = provider

        logger.debug(
            f"[SkillToolRegistry] Registered provider '{name}' "
            f"with tools: {provider.supported_tools}"
        )

    def unregister(self, provider_name: str) -> bool:
        """Unregister a tool provider.

        Thread-safe: Uses lock to ensure atomic check-and-delete.

        Args:
            provider_name: Name of provider to unregister

        Returns:
            True if provider was unregistered, False if not found
        """
        with self._providers_lock:
            if provider_name in self._providers:
                del self._providers[provider_name]
                logger.info(
                    f"[SkillToolRegistry] Unregistered provider '{provider_name}'"
                )
                return True
            return False

    def get_provider(self, provider_name: str) -> Optional[SkillToolProvider]:
        """Get a provider by name.

        Thread-safe: Uses lock for consistent read.

        Args:
            provider_name: Name of provider to retrieve

        Returns:
            Provider instance or None if not found
        """
        with self._providers_lock:
            return self._providers.get(provider_name)

    def create_tools_for_skill(
        self,
        skill_config: dict[str, Any],
        context: SkillToolContext,
    ) -> list[BaseTool]:
        """Create all tools declared in a skill configuration.

        This method reads the 'tools' section from skill_config
        and creates tool instances using the appropriate providers.

        Args:
            skill_config: Skill configuration from SKILL.md
            context: Context with dependencies

        Returns:
            List of created tool instances
        """
        tools: list[BaseTool] = []
        tool_declarations = skill_config.get("tools", [])

        for tool_decl in tool_declarations:
            tool_name = tool_decl.get("name")
            provider_name = tool_decl.get("provider")
            tool_config = tool_decl.get("config", {})

            if not tool_name or not provider_name:
                logger.warning(
                    f"[SkillToolRegistry] Invalid tool declaration: {tool_decl}"
                )
                continue

            provider = self.get_provider(provider_name)
            if not provider:
                logger.warning(
                    f"[SkillToolRegistry] Provider '{provider_name}' not found "
                    f"for tool '{tool_name}'"
                )
                continue

            if tool_name not in provider.supported_tools:
                logger.warning(
                    f"[SkillToolRegistry] Tool '{tool_name}' not supported "
                    f"by provider '{provider_name}'"
                )
                continue

            try:
                tool = provider.create_tool(tool_name, context, tool_config)
                tools.append(tool)
                logger.debug(
                    f"[SkillToolRegistry] Created tool '{tool_name}' "
                    f"from provider '{provider_name}'"
                )
            except Exception as e:
                logger.error(
                    f"[SkillToolRegistry] Failed to create tool '{tool_name}': {e}"
                )

        return tools

    def list_providers(self) -> list[str]:
        """List all registered provider names.

        Thread-safe: Uses lock for consistent read.

        Returns:
            List of provider names
        """
        with self._providers_lock:
            return list(self._providers.keys())

    def clear(self) -> None:
        """Clear all registered providers (for testing).

        Thread-safe: Uses lock for atomic clear operation.
        """
        with self._providers_lock:
            self._providers.clear()

    def load_provider_from_zip(
        self,
        zip_content: bytes,
        provider_config: dict[str, Any],
        skill_name: str,
    ) -> Optional[SkillToolProvider]:
        """Dynamically load a provider from a skill package.

        This method extracts all Python modules from the ZIP package
        and dynamically loads them as a package, then instantiates the provider class.

        Args:
            zip_content: ZIP file binary content from database
            provider_config: Provider configuration from skill spec
            skill_name: Skill name for logging and module naming

        Returns:
            Instantiated provider or None if loading fails
        """
        import io
        import sys
        import types
        import zipfile

        module_name = provider_config.get("module", "provider")
        class_name = provider_config.get("class")

        if not class_name:
            logger.warning(
                f"[SkillToolRegistry] No provider class specified for skill '{skill_name}'"
            )
            return None

        # Create a unique package name for this skill
        package_name = f"skill_pkg_{skill_name.replace('-', '_')}"

        try:
            with zipfile.ZipFile(io.BytesIO(zip_content), "r") as zip_file:
                # Find the skill folder name in the ZIP
                skill_folder = None
                python_files: dict[str, str] = {}

                for file_info in zip_file.filelist:
                    if file_info.filename.endswith(".py"):
                        parts = file_info.filename.split("/")
                        if len(parts) == 2:
                            if skill_folder is None:
                                skill_folder = parts[0]
                            py_module_name = parts[1][:-3]
                            python_files[py_module_name] = file_info.filename

                if not python_files:
                    logger.warning(
                        f"[SkillToolRegistry] No Python files found in ZIP for skill '{skill_name}'"
                    )
                    return None

                if module_name not in python_files:
                    logger.warning(
                        f"[SkillToolRegistry] Provider module '{module_name}.py' "
                        f"not found in ZIP for skill '{skill_name}'"
                    )
                    return None

                # Create the package module if it doesn't exist
                if package_name not in sys.modules:
                    package_module = types.ModuleType(package_name)
                    package_module.__path__ = []
                    package_module.__package__ = package_name
                    sys.modules[package_name] = package_module

                # Load all Python modules in the skill package
                for py_mod_name, file_path in python_files.items():
                    full_module_name = f"{package_name}.{py_mod_name}"

                    if full_module_name in sys.modules:
                        continue

                    module_code = zip_file.read(file_path).decode("utf-8")

                    spec = importlib.util.spec_from_loader(
                        full_module_name,
                        loader=None,
                        origin=f"skill://{skill_name}/{py_mod_name}.py",
                    )
                    if spec is None:
                        logger.error(
                            f"[SkillToolRegistry] Failed to create module spec for "
                            f"'{full_module_name}' in skill '{skill_name}'"
                        )
                        continue

                    module = importlib.util.module_from_spec(spec)
                    module.__package__ = package_name
                    sys.modules[full_module_name] = module

                    try:
                        exec(module_code, module.__dict__)
                    except Exception as e:
                        logger.error(
                            f"[SkillToolRegistry] Failed to execute module "
                            f"'{full_module_name}': {e}"
                        )
                        sys.modules.pop(full_module_name, None)
                        continue

                # Get the provider module
                provider_full_name = f"{package_name}.{module_name}"
                provider_module = sys.modules.get(provider_full_name)

                if provider_module is None:
                    logger.error(
                        f"[SkillToolRegistry] Provider module '{provider_full_name}' "
                        f"not loaded for skill '{skill_name}'"
                    )
                    return None

                # Get the provider class and instantiate it
                provider_class = getattr(provider_module, class_name, None)
                if provider_class is None:
                    logger.error(
                        f"[SkillToolRegistry] Class '{class_name}' not found "
                        f"in provider module for skill '{skill_name}'"
                    )
                    return None

                if not issubclass(provider_class, SkillToolProvider):
                    logger.error(
                        f"[SkillToolRegistry] Class '{class_name}' is not a "
                        f"SkillToolProvider for skill '{skill_name}'"
                    )
                    return None

                provider = provider_class()
                logger.debug(
                    f"[SkillToolRegistry] Loaded provider '{provider.provider_name}' "
                    f"from skill '{skill_name}'"
                )
                return provider

        except zipfile.BadZipFile:
            logger.error(
                f"[SkillToolRegistry] Invalid ZIP file for skill '{skill_name}'"
            )
            return None
        except Exception as e:
            logger.error(
                f"[SkillToolRegistry] Failed to load provider from ZIP "
                f"for skill '{skill_name}': {e}"
            )
            return None

    def ensure_provider_loaded(
        self,
        skill_name: str,
        provider_config: Optional[dict[str, Any]],
        zip_content: Optional[bytes],
        is_public: bool = False,
    ) -> bool:
        """Ensure a skill's provider is loaded and registered.

        Thread-safe: Uses lock to ensure atomic check-and-register.

        SECURITY: Only public skills (user_id=0) are allowed to load code.
        This prevents arbitrary code execution from user-uploaded skills.

        Args:
            skill_name: Skill name
            provider_config: Provider configuration from skill spec
            zip_content: ZIP file binary content (optional)
            is_public: Whether this is a public skill (user_id=0)

        Returns:
            True if provider is available, False if not
        """
        if not provider_config:
            return True

        class_name = provider_config.get("class")
        if not class_name:
            return True

        # SECURITY CHECK: Only allow code loading for public skills
        if not is_public:
            logger.warning(
                f"[SkillToolRegistry] SECURITY: Blocked code loading for non-public "
                f"skill '{skill_name}'. Only public skills (user_id=0) can load code."
            )
            return False

        if not zip_content:
            return False

        provider = self.load_provider_from_zip(zip_content, provider_config, skill_name)
        if not provider:
            return False

        with self._providers_lock:
            if provider.provider_name in self._providers:
                return True
            self._providers[provider.provider_name] = provider

        logger.debug(
            f"[SkillToolRegistry] Registered provider '{provider.provider_name}' "
            f"with tools: {provider.supported_tools}"
        )
        return True
