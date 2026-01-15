# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from fastapi import status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ValidationError

from app.core.exceptions import (
    ConflictException,
    CustomHTTPException,
    NotFoundException,
    ValidationException,
    http_exception_handler,
    python_exception_handler,
    validation_exception_handler,
)


@pytest.mark.unit
class TestCustomExceptions:
    """Test custom exception classes"""

    def test_not_found_exception(self):
        """Test NotFoundException initialization"""
        exc = NotFoundException(detail="Resource not found")

        assert exc.status_code == status.HTTP_404_NOT_FOUND
        assert exc.detail == "Resource not found"

    def test_conflict_exception(self):
        """Test ConflictException initialization"""
        exc = ConflictException(detail="Resource already exists")

        assert exc.status_code == status.HTTP_409_CONFLICT
        assert exc.detail == "Resource already exists"

    def test_validation_exception(self):
        """Test ValidationException initialization"""
        exc = ValidationException(detail="Invalid input data")

        assert exc.status_code == status.HTTP_400_BAD_REQUEST
        assert exc.detail == "Invalid input data"

    def test_custom_http_exception_with_error_code(self):
        """Test CustomHTTPException with custom error code"""
        exc = CustomHTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal error",
            error_code=5001,
        )

        assert exc.status_code == status.HTTP_500_INTERNAL_SERVER_ERROR
        assert exc.detail == "Internal error"
        assert exc.error_code == 5001

    def test_custom_http_exception_without_error_code(self):
        """Test CustomHTTPException without custom error code"""
        exc = CustomHTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Bad request"
        )

        assert exc.status_code == status.HTTP_400_BAD_REQUEST
        assert exc.detail == "Bad request"
        assert exc.error_code is None


@pytest.mark.asyncio
@pytest.mark.unit
class TestExceptionHandlers:
    """Test exception handler functions"""

    async def test_http_exception_handler(self):
        """Test HTTP exception handler returns correct JSON response"""
        exc = NotFoundException(detail="User not found")

        response = await http_exception_handler(request=None, exc=exc)

        assert response.status_code == status.HTTP_404_NOT_FOUND
        response_body = eval(response.body.decode())
        assert response_body["detail"] == "User not found"
        assert response_body["error_code"] == status.HTTP_404_NOT_FOUND

    async def test_http_exception_handler_with_custom_error_code(self):
        """Test HTTP exception handler with custom error code"""
        exc = CustomHTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Server error",
            error_code=5001,
        )

        response = await http_exception_handler(request=None, exc=exc)

        assert response.status_code == status.HTTP_500_INTERNAL_SERVER_ERROR
        response_body = eval(response.body.decode())
        assert response_body["detail"] == "Server error"
        assert response_body["error_code"] == 5001

    async def test_validation_exception_handler(self):
        """Test validation exception handler"""

        class TestModel(BaseModel):
            name: str
            age: int

        try:
            TestModel(name="test", age="invalid")
        except ValidationError as e:
            # Convert to RequestValidationError
            exc = RequestValidationError(errors=e.errors())

            response = await validation_exception_handler(request=None, exc=exc)

            assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
            response_body = eval(response.body.decode())
            assert response_body["error_code"] == status.HTTP_422_UNPROCESSABLE_ENTITY
            assert "Request parameter validation failed" in response_body["detail"]
            assert "errors" in response_body

    async def test_python_exception_handler(self):
        """Test Python exception handler for general exceptions"""
        exc = Exception("Something went wrong")

        response = await python_exception_handler(request=None, exc=exc)

        assert response.status_code == status.HTTP_500_INTERNAL_SERVER_ERROR
        response_body = eval(response.body.decode())
        assert response_body["error_code"] == status.HTTP_500_INTERNAL_SERVER_ERROR
        assert response_body["detail"] == "Internal server error"

    async def test_exception_handlers_return_json_response(self):
        """Test that all exception handlers return JSONResponse"""
        from fastapi.responses import JSONResponse

        exc1 = NotFoundException(detail="Not found")
        response1 = await http_exception_handler(None, exc1)
        assert isinstance(response1, JSONResponse)

        exc2 = Exception("Error")
        response2 = await python_exception_handler(None, exc2)
        assert isinstance(response2, JSONResponse)
