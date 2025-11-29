# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API router module, providing a global API router instance
"""
from fastapi import APIRouter

# Create a global API router instance
api_router = APIRouter()


# Function to get the API router instance
def get_api_router() -> APIRouter:
    """
    Get the global API router instance

    Returns:
        APIRouter: Global API router instance
    """
    return api_router
