"""
DataTable Service data model definitions.
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class TableContext(BaseModel):
    """Table context."""

    provider: str  # 'dingtalk', 'feishu', etc.
    base_id: str
    sheet_id_or_name: str
    url: Optional[str] = None


class TableQueryRequest(BaseModel):
    """Table query request."""

    provider: str = Field(description="Table provider, e.g. 'dingtalk'")
    base_id: str = Field(description="Table base ID")
    sheet_id_or_name: str = Field(description="Sheet ID or name")
    user_name: Optional[str] = Field(
        default=None, description="Username for access control"
    )
    max_records: int = Field(default=100, description="Maximum number of records")
    filters: Optional[Dict[str, Any]] = Field(
        default=None, description="Query filter conditions"
    )


class TableQueryResponse(BaseModel):
    """Table query response."""

    field_schema: Dict[str, str] = Field(description="Field name to type mapping")
    records: List[Dict[str, Any]] = Field(description="List of records")
    total_count: int = Field(description="Total number of records")


class TableValidateRequest(BaseModel):
    """Table URL validation request."""

    url: str = Field(description="Table URL")
    user_name: Optional[str] = Field(default=None, description="Username")


class TableValidateResponse(BaseModel):
    """Table URL validation response."""

    valid: bool = Field(description="Whether the URL is valid")
    provider: Optional[str] = Field(default=None, description="Table provider")
    base_id: Optional[str] = Field(default=None, description="Table base ID")
    sheet_id: Optional[str] = Field(default=None, description="Sheet ID")
    error_message: Optional[str] = Field(default=None, description="Error message")
