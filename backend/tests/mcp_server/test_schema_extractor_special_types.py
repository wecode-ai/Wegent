# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the enhanced schema_extractor with FastAPI special type detection."""

import inspect
from typing import Optional
from unittest.mock import MagicMock

import pytest
from fastapi import BackgroundTasks, Depends, Query, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.mcp_server.schema_extractor import (
    _is_dependency,
    _is_fastapi_special_type,
    _is_pydantic_body,
    extract_tool_parameters,
)


class TestIsDependency:
    """Tests for _is_dependency function."""

    def test_depends_marker(self):
        """Test detection of Depends() marker."""

        def get_db():
            pass

        def func(db: Session = Depends(get_db)):
            pass

        sig = inspect.signature(func)
        param = sig.parameters["db"]
        assert _is_dependency(param) is True

    def test_common_dependency_names(self):
        """Test detection of common dependency parameter names."""

        def func(db=None, current_user=None, background_tasks=None):
            pass

        sig = inspect.signature(func)

        assert _is_dependency(sig.parameters["db"]) is True
        assert _is_dependency(sig.parameters["current_user"]) is True
        assert _is_dependency(sig.parameters["background_tasks"]) is True

    def test_regular_parameter_not_dependency(self):
        """Test that regular parameters are not detected as dependencies."""

        def func(name: str, count: int = 10):
            pass

        sig = inspect.signature(func)

        assert _is_dependency(sig.parameters["name"]) is False
        assert _is_dependency(sig.parameters["count"]) is False


class TestIsFastapiSpecialType:
    """Tests for _is_fastapi_special_type function."""

    def test_background_tasks_detected(self):
        """Test BackgroundTasks is detected as special type."""
        assert _is_fastapi_special_type(BackgroundTasks) is True

    def test_request_detected(self):
        """Test Request is detected as special type."""
        assert _is_fastapi_special_type(Request) is True

    def test_response_detected(self):
        """Test Response is detected as special type."""
        assert _is_fastapi_special_type(Response) is True

    def test_regular_types_not_special(self):
        """Test regular types are not detected as special."""
        assert _is_fastapi_special_type(str) is False
        assert _is_fastapi_special_type(int) is False
        assert _is_fastapi_special_type(Session) is False

    def test_none_not_special(self):
        """Test None is not detected as special."""
        assert _is_fastapi_special_type(None) is False


class TestExtractToolParametersWithSpecialTypes:
    """Tests for extract_tool_parameters filtering FastAPI special types."""

    def test_filters_background_tasks(self):
        """Test BackgroundTasks parameter is filtered out."""

        def endpoint(
            name: str,
            background_tasks: BackgroundTasks,
            count: int = 10,
        ):
            pass

        params = extract_tool_parameters(endpoint)
        param_names = [p["name"] for p in params]

        assert "name" in param_names
        assert "count" in param_names
        assert "background_tasks" not in param_names

    def test_filters_request_response(self):
        """Test Request and Response parameters are filtered out."""

        def endpoint(
            name: str,
            request: Request,
            response: Response,
        ):
            pass

        params = extract_tool_parameters(endpoint)
        param_names = [p["name"] for p in params]

        assert "name" in param_names
        assert "request" not in param_names
        assert "response" not in param_names

    def test_filters_all_fastapi_special_types(self):
        """Test all FastAPI special types are filtered in combination."""

        def get_db():
            pass

        def get_user():
            pass

        def endpoint(
            knowledge_base_id: int,
            name: str = Query(default="default"),
            background_tasks: BackgroundTasks = None,
            db: Session = Depends(get_db),
            current_user=Depends(get_user),
        ):
            pass

        params = extract_tool_parameters(endpoint)
        param_names = [p["name"] for p in params]

        # Should include regular params
        assert "knowledge_base_id" in param_names
        assert "name" in param_names

        # Should exclude all special/dependency params
        assert "background_tasks" not in param_names
        assert "db" not in param_names
        assert "current_user" not in param_names


class TestBodyModel(BaseModel):
    """Test Pydantic model for body parameters."""

    title: str
    description: Optional[str] = None


class TestExtractToolParametersWithPydanticBody:
    """Tests for extract_tool_parameters with Pydantic body models."""

    def test_flattens_pydantic_body(self):
        """Test Pydantic body model is flattened into parameters."""

        def endpoint(
            knowledge_base_id: int,
            data: TestBodyModel,
            background_tasks: BackgroundTasks,
        ):
            pass

        params = extract_tool_parameters(endpoint)
        param_names = [p["name"] for p in params]

        # Should include path param
        assert "knowledge_base_id" in param_names

        # Should flatten Pydantic model fields
        assert "title" in param_names
        assert "description" in param_names

        # Should exclude BackgroundTasks
        assert "background_tasks" not in param_names
        assert "data" not in param_names  # Original body param name should be replaced
