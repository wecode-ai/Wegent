# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for app/core/exceptions.py
"""

import pytest
from fastapi import status
from fastapi.exceptions import RequestValidationError
from unittest.mock import Mock

from app.core.exceptions import (
    NotFoundException,
    ConflictException,
    ValidationException,
    CustomHTTPException,
    http_exception_handler,
    validation_exception_handler,
    python_exception_handler
)


class TestCustomExceptions:
    """Test custom exception classes"""

    def test_not_found_exception(self):
        """Test NotFoundException creates correct status code"""
        exc = NotFoundException(detail="Resource not found")

        assert exc.status_code == status.HTTP_404_NOT_FOUND
        assert exc.detail == "Resource not found"

    def test_conflict_exception(self):
        """Test ConflictException creates correct status code"""
        exc = ConflictException(detail="Resource already exists")

        assert exc.status_code == status.HTTP_409_CONFLICT
        assert exc.detail == "Resource already exists"

    def test_validation_exception(self):
        """Test ValidationException creates correct status code"""
        exc = ValidationException(detail="Invalid input")

        assert exc.status_code == status.HTTP_400_BAD_REQUEST
        assert exc.detail == "Invalid input"

    def test_custom_http_exception_with_error_code(self):
        """Test CustomHTTPException with custom error code"""
        exc = CustomHTTPException(
            status_code=400,
            detail="Custom error",
            error_code=1001
        )

        assert exc.status_code == 400
        assert exc.detail == "Custom error"
        assert exc.error_code == 1001

    def test_custom_http_exception_without_error_code(self):
        """Test CustomHTTPException without custom error code"""
        exc = CustomHTTPException(
            status_code=500,
            detail="Server error"
        )

        assert exc.status_code == 500
        assert exc.detail == "Server error"
        assert exc.error_code is None


class TestExceptionHandlers:
    """Test exception handler functions"""

    @pytest.mark.asyncio
    async def test_http_exception_handler(self):
        """Test HTTP exception handler returns correct response"""
        request = Mock()
        exc = NotFoundException(detail="User not found")

        response = await http_exception_handler(request, exc)

        assert response.status_code == status.HTTP_404_NOT_FOUND
        assert b"User not found" in response.body

    @pytest.mark.asyncio
    async def test_http_exception_handler_with_custom_error_code(self):
        """Test HTTP exception handler with custom error code"""
        request = Mock()
        exc = CustomHTTPException(
            status_code=400,
            detail="Bad request",
            error_code=2001
        )

        response = await http_exception_handler(request, exc)

        assert response.status_code == 400
        assert b"2001" in response.body
        assert b"Bad request" in response.body

    @pytest.mark.asyncio
    async def test_validation_exception_handler(self):
        """Test validation exception handler"""
        request = Mock()

        # Create a mock validation error
        exc = Mock(spec=RequestValidationError)
        exc.errors.return_value = [
            {
                "loc": ["body", "username"],
                "msg": "field required",
                "type": "value_error.missing"
            }
        ]

        response = await validation_exception_handler(request, exc)

        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
        assert b"validation failed" in response.body.lower()

    @pytest.mark.asyncio
    async def test_python_exception_handler(self):
        """Test Python exception handler"""
        request = Mock()
        exc = Exception("Unexpected error")

        response = await python_exception_handler(request, exc)

        assert response.status_code == status.HTTP_500_INTERNAL_SERVER_ERROR
        assert b"Internal server error" in response.body


class TestExceptionUsage:
    """Test using exceptions in actual scenarios"""

    def test_raise_not_found_exception(self):
        """Test raising NotFoundException"""
        with pytest.raises(NotFoundException) as exc_info:
            raise NotFoundException(detail="Item not found")

        assert exc_info.value.status_code == 404
        assert "Item not found" in str(exc_info.value.detail)

    def test_raise_conflict_exception(self):
        """Test raising ConflictException"""
        with pytest.raises(ConflictException) as exc_info:
            raise ConflictException(detail="Duplicate entry")

        assert exc_info.value.status_code == 409
        assert "Duplicate entry" in str(exc_info.value.detail)

    def test_raise_validation_exception(self):
        """Test raising ValidationException"""
        with pytest.raises(ValidationException) as exc_info:
            raise ValidationException(detail="Invalid email format")

        assert exc_info.value.status_code == 400
        assert "Invalid email format" in str(exc_info.value.detail)
