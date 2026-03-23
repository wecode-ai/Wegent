# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for dynamic skill provider loading."""

import io
import sys
import zipfile

from chat_shell.skills import SkillToolContext
from chat_shell.skills.registry import SkillToolRegistry


def _build_out_of_order_skill_zip() -> bytes:
    """Create a skill ZIP whose tool module appears before _base.py."""

    provider_code = """
from chat_shell.skills import SkillToolProvider


class TestProvider(SkillToolProvider):
    @property
    def provider_name(self) -> str:
        return "synthetic"

    @property
    def supported_tools(self) -> list[str]:
        return ["echo"]

    def create_tool(self, tool_name, context, tool_config=None):
        if tool_name != "echo":
            raise ValueError(f"Unknown tool: {tool_name}")
        from .command_tool import EchoTool
        return EchoTool()
"""

    command_tool_code = """
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field


class EchoInput(BaseModel):
    text: str = Field(...)


try:
    from ._base import PREFIX
except ImportError:
    import sys

    package_name = __name__.rsplit(".", 1)[0]
    _base_module = sys.modules.get(f"{package_name}._base")
    if _base_module:
        PREFIX = _base_module.PREFIX
    else:
        raise ImportError(f"Cannot import _base from {package_name}")


class EchoTool(BaseTool):
    name: str = "echo"
    description: str = "Echo text with a prefix"
    args_schema: type[BaseModel] = EchoInput

    def _run(self, text: str):
        return f"{PREFIX}:{text}"
"""

    base_code = """
PREFIX = "loaded"
"""

    init_code = """
from . import _base
"""

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
        # Write command_tool before _base to reproduce the original failure mode.
        zip_file.writestr("zip-order-skill/command_tool.py", command_tool_code)
        zip_file.writestr("zip-order-skill/provider.py", provider_code)
        zip_file.writestr("zip-order-skill/_base.py", base_code)
        zip_file.writestr("zip-order-skill/__init__.py", init_code)
    return buffer.getvalue()


def test_load_provider_from_zip_handles_base_module_dependencies():
    """Tool modules importing ._base should load regardless of ZIP entry order."""

    skill_name = "zip-order-skill"
    package_name = "skill_pkg_zip_order_skill"
    registry = SkillToolRegistry()

    provider = registry.load_provider_from_zip(
        zip_content=_build_out_of_order_skill_zip(),
        provider_config={"module": "provider", "class": "TestProvider"},
        skill_name=skill_name,
    )

    assert provider is not None
    registry.register(provider)

    context = SkillToolContext(
        task_id=1,
        subtask_id=1,
        user_id=1,
        db_session=None,
        ws_emitter=None,
    )

    tools = registry.create_tools_for_skill(
        skill_config={"tools": [{"name": "echo", "provider": "synthetic"}]},
        context=context,
    )

    assert len(tools) == 1
    assert tools[0].invoke({"text": "hello"}) == "loaded:hello"

    for module_name in list(sys.modules):
        if module_name == package_name or module_name.startswith(f"{package_name}."):
            sys.modules.pop(module_name, None)
