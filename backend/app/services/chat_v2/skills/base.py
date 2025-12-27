# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Base classes for skill tool dynamic loading.

This module provides the core abstractions for the skill-tool binding system:
- SkillToolContext: Context object with dependencies for tool creation
- SkillToolProvider: Abstract base class for tool providers
- SkillToolRegistry: Singleton registry for tool providers

The registry supports dynamic loading of providers from skill ckages
stored in the database, allowing skills to bundle their own provider implementations.
"""

import importlib.util
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Optional

from langchain_core.tools import BaseTool

logger = logging.getLogger(__name__)


@dataclass
class SkillToolContext:
    """Context for creating skill-specific tools.

    This context provides all the dependencies that a tool provider
    might need to create tool instances. It follows the dependency
    injection pattern to avoid tight coupling.

    Attributes:
        task_id: Current task ID for WebSocket room targeting
        subtask_id: Current subtask ID for correlation
        user_id: User ID for access control and personalization
        db_session: Database session for data access
        ws_emitter: WebSocket emitter for real-time communication
        skill_config: Skill-specific configuration from SKILL.md
    """

    task_id: int
    subtask_id: int
    user_id: int
    db_session: Any  # SQLAlchemy Session
    ws_emitter: Any  # WebSocket emitter
    skill_config: dict[str, Any] = field(default_factory=dict)

    def get_config(self, key: str, default: Any = None) -> Any:
        """Get a configuration value from skill config.

        Args:
            key: Configuration key to retrieve
            default: Default value if key not found

        Returns:
            Configuration value or default
        """
        return self.skill_config.get(key, default)


class SkillToolProvider(ABC):
    """Abstract base class for skill tool providers.

    A tool provider is responsible for creating tool instances
    for a specific skill. Each provider is registered with a
    unique provider name and can create one or more tools.

    Example:
        class MySkillToolProvider(SkillToolProvider):
            @property
            def provider_name(self) -> str:
                return "my-skill"

            @property
            def supported_tools(self) -> list[str]:
                return ["my_tool"]

            def create_tool(
                self,
                tool_name: str,
                context: SkillToolContext,
                tool_config: dict[str, Any]
            ) -> BaseTool:
                if tool_name == "my_tool":
                    return MyTool(
                        task_id=context.task_id,
                        subtask_id=context.subtask_id,
                        ws_emitter=context.ws_emitter,
                    )
                raise ValueError(f"Unknown tool: {tool_name}")
    """

    @property
    @abstractmethod
    def provider_name(self) -> str:
        """Unique identifier for this provider.

        This name is used in SKILL.md to reference the provider:

        tools:
          - name: my_tool
            provider: my-skill  # <-- provider_name

        Returns:
            Provider name string
        """
        pass

    @property
    @abstractmethod
    def supported_tools(self) -> list[str]:
        """List of tool names this provider can create.

        Returns:
            List of supported tool names
        """
        pass

    @abstractmethod
    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        """Create a tool instance.

        Args:
            tool_name: Name of the tool to create
            context: Context with dependencies
            tool_config: Optional tool-specific configuration

        Returns:
            Configured tool instance

        Raises:
            ValueError: If tool_name is not supported
        """
        pass

    def validate_config(self, tool_config: dict[str, Any]) -> bool:
        """Validate tool configuration.

        Override this method to add custom validation logic.

        Args:
            tool_config: Configuration to validate

        Returns:
            True if valid, False otherwise
        """
        return True


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
        The registry is designed to be thread-safe for reads after
        initial registration. Providers should be registered during
        application startup.
    """

    _instance: Optional["SkillToolRegistry"] = None
    _providers: dict[str, SkillToolProvider]

    def __init__(self) -> None:
        """Initialize the registry.

        Note: Use get_instance() to get the singleton instance.
        Direct instantiation is allowed for testing purposes.
        """
        self._providers = {}

    @classmethod
    def get_instance(cls) -> "SkillToolRegistry":
        """Get the singleton instance of the registry.

        Returns:
            The global SkillToolRegistry instance
        """
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """Reset the singleton instance (for testing only).

        This method clears the singleton instance, allowing a fresh
        registry to be created on the next get_instance() call.
        """
        cls._instance = None

    def register(self, provider: SkillToolProvider) -> None:
        """Register a tool provider.

        Args:
            provider: Provider instance to register

        Raises:
            ValueError: If provider name is already registered
        """
        name = provider.provider_name
        if name in self._providers:
            raise ValueError(f"Provider '{name}' is already registered")

        self._providers[name] = provider
        logger.info(
            f"[SkillToolRegistry] Registered provider '{name}' "
            f"with tools: {provider.supported_tools}"
        )

    def unregister(self, provider_name: str) -> bool:
        """Unregister a tool provider.

        Args:
            provider_name: Name of provider to unregister

        Returns:
            True if provider was unregistered, False if not found
        """
        if provider_name in self._providers:
            del self._providers[provider_name]
            logger.info(f"[SkillToolRegistry] Unregistered provider '{provider_name}'")
            return True
        return False

    def get_provider(self, provider_name: str) -> Optional[SkillToolProvider]:
        """Get a provider by name.

        Args:
            provider_name: Name of provider to retrieve

        Returns:
            Provider instance or None if not found
        """
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

        Example skill_config:
            {
                "tools": [
                    {
                        "name": "my_tool",
                        "provider": "my-skill",
                        "config": {"timeout": 30}
                    }
                ]
            }
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
                logger.info(
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

        Returns:
            List of provider names
        """
        return list(self._providers.keys())

    def clear(self) -> None:
        """Clear all registered providers (for testing)."""
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
                Expected format: {"module": "provider", "class": "MySkillToolProvider"}
            skill_name: Skill name for logging and module naming

        Returns:
            Instantiated provider or None if loading fails

        Example:
            registry = SkillToolRegistry.get_instance()
            provider = registry.load_provider_from_zip(
                zip_content=skill_binary.binary_data,
                provider_config={"module": "provider", "class": "MySkillToolProvider"},
                skill_name="my-skill"
            )
            if provider:
                registry.register(provider)
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
                            # Extract module name (without .py)
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

                    # Skip if already loaded
                    if full_module_name in sys.modules:
                        continue

                    # Read the module content
                    module_code = zip_file.read(file_path).decode("utf-8")

                    # Create a new module
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

                    # Execute the module code
                    try:
                        exec(module_code, module.__dict__)
                    except Exception as e:
                        logger.error(
                            f"[SkillToolRegistry] Failed to execute module "
                            f"'{full_module_name}': {e}"
                        )
                        # Remove the failed module from sys.modules
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
                logger.info(
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
    ) -> bool:
        """Ensure a skill's provider is loaded and registered.

        This method checks if the provider is already registered,
        and if not, attempts to load it from the ZIP package.

        Args:
            skill_name: Skill name
            provider_config: Provider configuration from skill spec
            zip_content: ZIP file binary content (optional, loaded from DB if needed)

        Returns:
            True if provider is available (already registered or newly loaded),
            False if provider could not be loaded
        """
        if not provider_config:
            # No provider defined for this skill
            return True

        class_name = provider_config.get("class")
        if not class_name:
            return True

        # Check if provider is already registered by checking tools
        # We need to load the provider to know its provider_name
        # For now, try to load it and see if it's already registered
        if zip_content:
            provider = self.load_provider_from_zip(
                zip_content, provider_config, skill_name
            )
            if provider:
                if provider.provider_name not in self._providers:
                    try:
                        self.register(provider)
                        return True
                    except ValueError:
                        # Already registered (race condition)
                        return True
                else:
                    # Already registered
                    return True

        return False
