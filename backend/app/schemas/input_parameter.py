# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Input Parameter schemas for custom placeholder parameter system.

This module defines schemas for:
- Input parameter types (text, textarea, select)
- Input parameter definition (parsed from templates)
- API request/response models for input parameters
"""
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class InputParameterType(str, Enum):
    """Input parameter type enumeration."""

    TEXT = "text"
    TEXTAREA = "textarea"
    SELECT = "select"


class InputParameter(BaseModel):
    """
    Input parameter definition parsed from template.

    Syntax formats:
    - text: {{name:label:text}}
    - textarea: {{name:label:textarea}}
    - select: {{name:label:select:option1|option2|option3}}
    """

    name: str = Field(..., description="Parameter unique identifier (variable name)")
    label: str = Field(..., description="Display label for the parameter")
    type: InputParameterType = Field(..., description="Parameter input type")
    options: Optional[List[str]] = Field(
        None, description="Options list for select type (pipe-separated in template)"
    )


class InputParametersResponse(BaseModel):
    """Response for listing input parameters."""

    parameters: List[InputParameter] = Field(
        default_factory=list, description="List of input parameters"
    )


class InputParameterValues(BaseModel):
    """Input parameter values provided by user."""

    values: Dict[str, str] = Field(
        default_factory=dict, description="Parameter name to value mapping"
    )
