# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for skill dynamic loading security restrictions.

This module tests the security mechanism that only allows public skills
(user_id=0) to load executable code from ZIP packages.
"""

import io
import sys
import zipfile
from unittest.mock import MagicMock, patch

import pytest

# Import directly from the skills submodule to avoid triggering
# chat_shell/__init__.py which has heavy dependencies (opentelemetry, etc.)
# This is a unit test that only needs the registry module.
sys.path.insert(0, ".")
from chat_shell.skills.registry import SkillToolRegistry


@pytest.fixture
def registry():
    """Create a fresh registry instance for each test."""
    reg = SkillToolRegistry()
    yield reg
    reg.clear()


@pytest.fixture
def valid_zip_content():
    """Create a valid ZIP file with a provider module."""
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        # Create a simple provider module
        provider_code = """
from chat_shell.skills.provider import SkillToolProvider
from chat_shell.skills.context import SkillToolContext
from langchain_core.tools import BaseTool
from typing import Any, Optional

class TestProvider(SkillToolProvider):
    @property
    def provider_name(self) -> str:
        return "test-provider"

    @property
    def supported_tools(self) -> list[str]:
        return ["test_tool"]

    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        raise NotImplementedError("Test provider")
"""
        zf.writestr("test-skill/provider.py", provider_code)
        zf.writestr("test-skill/SKILL.md", "---\ndescription: Test skill\n---\n")

    return zip_buffer.getvalue()


@pytest.fixture
def provider_config():
    """Standard provider configuration."""
    return {
        "module": "provider",
        "class": "TestProvider",
    }


@pytest.mark.unit
class TestSkillSecurityRestrictions:
    """Test security restrictions for skill code loading."""

    def test_ensure_provider_loaded_blocks_non_public_skill(
        self, registry, valid_zip_content, provider_config
    ):
        """Test that non-public skills (is_public=False) are blocked from loading code."""
        # Attempt to load provider for a non-public skill
        result = registry.ensure_provider_loaded(
            skill_name="user-skill",
            provider_config=provider_config,
            zip_content=valid_zip_content,
            is_public=False,  # Non-public skill
        )

        # Should return False (blocked)
        assert result is False

        # Provider should NOT be registered
        assert registry.get_provider("test-provider") is None

    def test_ensure_provider_loaded_allows_public_skill(
        self, registry, valid_zip_content, provider_config
    ):
        """Test that public skills (is_public=True) can load code."""
        # Attempt to load provider for a public skill
        result = registry.ensure_provider_loaded(
            skill_name="public-skill",
            provider_config=provider_config,
            zip_content=valid_zip_content,
            is_public=True,  # Public skill
        )

        # Should return True (allowed)
        assert result is True

        # Provider should be registered
        provider = registry.get_provider("test-provider")
        assert provider is not None
        assert provider.provider_name == "test-provider"

    def test_ensure_provider_loaded_default_is_not_public(
        self, registry, valid_zip_content, provider_config
    ):
        """Test that the default value for is_public is False (secure by default)."""
        # Call without is_public parameter (should default to False)
        result = registry.ensure_provider_loaded(
            skill_name="default-skill",
            provider_config=provider_config,
            zip_content=valid_zip_content,
            # is_public not specified, should default to False
        )

        # Should return False (blocked by default)
        assert result is False

        # Provider should NOT be registered
        assert registry.get_provider("test-provider") is None

    def test_ensure_provider_loaded_no_provider_config_returns_true(self, registry):
        """Test that skills without provider config return True (no code to load)."""
        result = registry.ensure_provider_loaded(
            skill_name="no-provider-skill",
            provider_config=None,  # No provider config
            zip_content=None,
            is_public=False,
        )

        # Should return True (nothing to load)
        assert result is True

    def test_ensure_provider_loaded_no_class_returns_true(self, registry):
        """Test that provider config without class returns True."""
        result = registry.ensure_provider_loaded(
            skill_name="no-class-skill",
            provider_config={"module": "provider"},  # No class specified
            zip_content=None,
            is_public=False,
        )

        # Should return True (nothing to load)
        assert result is True

    def test_security_logging_for_blocked_skill(
        self, registry, valid_zip_content, provider_config, caplog
    ):
        """Test that security warnings are logged when blocking non-public skills."""
        import logging

        with caplog.at_level(logging.WARNING):
            registry.ensure_provider_loaded(
                skill_name="blocked-skill",
                provider_config=provider_config,
                zip_content=valid_zip_content,
                is_public=False,
            )

        # Check that security warning was logged
        assert any(
            "SECURITY" in record.message and "blocked-skill" in record.message
            for record in caplog.records
        )


@pytest.mark.unit
class TestLoadProviderFromZipSecurity:
    """Test load_provider_from_zip method security aspects."""

    def test_load_provider_from_zip_executes_code(self, registry, valid_zip_content):
        """Test that load_provider_from_zip actually executes code from ZIP.

        This test verifies that the security restriction in ensure_provider_loaded
        is necessary because load_provider_from_zip does execute arbitrary code.
        """
        provider_config = {
            "module": "provider",
            "class": "TestProvider",
        }

        # This method directly loads and executes code - no security check here
        # The security check is in ensure_provider_loaded
        provider = registry.load_provider_from_zip(
            zip_content=valid_zip_content,
            provider_config=provider_config,
            skill_name="test-skill",
        )

        # Provider should be loaded (this method has no security check)
        assert provider is not None
        assert provider.provider_name == "test-provider"

    def test_malicious_code_would_execute_without_security_check(self, registry):
        """Test that demonstrates why security check is needed.

        This test creates a ZIP with code that sets a flag when executed,
        proving that arbitrary code execution is possible.
        """
        # Create a ZIP with code that sets a global flag
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            # Code that sets a flag when executed
            malicious_code = """
# This code would execute when loaded
import sys
sys.modules["__malicious_flag__"] = True

from chat_shell.skills.provider import SkillToolProvider
from chat_shell.skills.context import SkillToolContext
from langchain_core.tools import BaseTool
from typing import Any, Optional

class MaliciousProvider(SkillToolProvider):
    @property
    def provider_name(self) -> str:
        return "malicious-provider"

    @property
    def supported_tools(self) -> list[str]:
        return []

    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: Optional[dict[str, Any]] = None,
    ) -> BaseTool:
        raise NotImplementedError()
"""
            zf.writestr("malicious-skill/provider.py", malicious_code)

        zip_content = zip_buffer.getvalue()
        provider_config = {
            "module": "provider",
            "class": "MaliciousProvider",
        }

        # Clean up any previous flag
        import sys

        sys.modules.pop("__malicious_flag__", None)

        # Load the provider (this executes the code)
        registry.load_provider_from_zip(
            zip_content=zip_content,
            provider_config=provider_config,
            skill_name="malicious-skill",
        )

        # The malicious code was executed
        assert "__malicious_flag__" in sys.modules

        # Clean up
        sys.modules.pop("__malicious_flag__", None)
