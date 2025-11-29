# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any, Dict

import requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from shared.logger import setup_logger
from shared.utils.crypto import decrypt_sensitive_data, is_data_encrypted
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User

logger = setup_logger("dify_api")

router = APIRouter()


class DifyAppInfoRequest(BaseModel):
    """Request to get Dify app info"""

    api_key: str
    base_url: str = "https://api.dify.ai"


@router.post("/app/info")
def get_dify_app_info(
    request: DifyAppInfoRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """
    Get Dify application information using API key

    Uses Dify's /v1/info endpoint to retrieve basic app information.
    This can be used to validate the API key and get app details.

    Args:
        request: Contains api_key and base_url

    Returns:
        App information including name, description, mode, etc.
    """

    try:
        # Decrypt API key if it's encrypted
        api_key = request.api_key
        if api_key and is_data_encrypted(api_key):
            api_key = decrypt_sensitive_data(api_key) or api_key
            logger.info("Decrypted API key for Dify app info request")

        api_url = f"{request.base_url}/v1/info"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        logger.info(f"Fetching Dify app info from: {api_url}")

        response = requests.get(api_url, headers=headers, timeout=10)

        response.raise_for_status()
        data = response.json()

        logger.info(
            f"Successfully fetched Dify app info: {data.get('name', 'Unknown')}"
        )
        return data

    except requests.exceptions.HTTPError as e:
        error_msg = f"Dify API HTTP error: {e}"
        if e.response is not None:
            try:
                error_data = e.response.json()
                error_msg = f"Dify API error: {error_data.get('message', str(e))}"
            except:
                pass
        logger.error(error_msg)
        raise HTTPException(status_code=502, detail=error_msg)

    except requests.exceptions.RequestException as e:
        error_msg = f"Failed to connect to Dify API: {str(e)}"
        logger.error(error_msg)
        raise HTTPException(status_code=502, detail=error_msg)

    except Exception as e:
        error_msg = f"Unexpected error: {str(e)}"
        logger.error(error_msg)
        raise HTTPException(status_code=500, detail=error_msg)


@router.post("/app/parameters")
def get_dify_app_parameters(
    request: DifyAppInfoRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> Dict[str, Any]:
    """
    Get parameters schema for a Dify application

    Uses Dify's /v1/parameters endpoint to retrieve app input parameters schema.

    Args:
        request: Contains api_key and base_url

    Returns:
        Parameters schema with user_input_form and system_parameters
    """

    try:
        # Decrypt API key if it's encrypted
        api_key = request.api_key
        if api_key and is_data_encrypted(api_key):
            api_key = decrypt_sensitive_data(api_key) or api_key
            logger.info("Decrypted API key for Dify app parameters request")

        api_url = f"{request.base_url}/v1/parameters"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        logger.info(f"Fetching Dify app parameters from: {api_url}")

        response = requests.get(api_url, headers=headers, timeout=10)

        response.raise_for_status()
        data = response.json()

        logger.info("Successfully fetched Dify app parameters")
        return data

    except requests.exceptions.HTTPError as e:
        error_msg = f"Dify API HTTP error: {e}"
        if e.response is not None:
            try:
                error_data = e.response.json()
                error_msg = f"Dify API error: {error_data.get('message', str(e))}"
            except:
                pass
        logger.error(error_msg)
        raise HTTPException(status_code=502, detail=error_msg)

    except Exception as e:
        error_msg = f"Failed to fetch app parameters: {str(e)}"
        logger.error(error_msg)
        raise HTTPException(status_code=500, detail=error_msg)
