# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List, Dict, Any
import requests

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.models.kind import Kind
from app.schemas.kind import Model
from shared.logger import setup_logger

logger = setup_logger("dify_api")

router = APIRouter()


@router.get("/apps")
def get_dify_apps(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user)
) -> List[Dict[str, Any]]:
    """
    Get list of Dify applications for the current user

    Retrieves Dify applications from the user's configured Dify instance.
    Requires DIFY_API_KEY and DIFY_BASE_URL to be configured in a Model.

    Returns:
        List of Dify applications with id, name, mode, and icon
    """

    # Find user's Dify Model configuration
    models = db.query(Kind).filter(
        Kind.user_id == current_user.id,
        Kind.kind == "Model",
        Kind.is_active == True
    ).all()

    dify_config = None
    for model in models:
        try:
            model_crd = Model.model_validate(model.json)
            env = model_crd.spec.modelConfig.get("env", {})

            # Check if this model has Dify configuration
            if "DIFY_API_KEY" in env and "DIFY_BASE_URL" in env:
                dify_config = {
                    "api_key": env["DIFY_API_KEY"],
                    "base_url": env["DIFY_BASE_URL"]
                }
                break
        except Exception as e:
            logger.warning(f"Failed to parse model {model.id}: {e}")
            continue

    if not dify_config:
        raise HTTPException(
            status_code=404,
            detail="No Dify configuration found. Please configure DIFY_API_KEY and DIFY_BASE_URL in a Model."
        )

    # Call Dify API to get applications
    try:
        api_url = f"{dify_config['base_url']}/v1/apps"
        headers = {
            "Authorization": f"Bearer {dify_config['api_key']}",
            "Content-Type": "application/json"
        }

        logger.info(f"Fetching Dify apps from: {api_url}")

        response = requests.get(
            api_url,
            headers=headers,
            timeout=10
        )

        response.raise_for_status()
        data = response.json()

        # Extract app list from response
        # Dify API returns: {"data": [{"id": "...", "name": "...", "mode": "...", "icon": "..."}]}
        apps = data.get("data", [])

        # Transform to simplified format
        result = []
        for app in apps:
            result.append({
                "id": app.get("id", ""),
                "name": app.get("name", "Unnamed App"),
                "mode": app.get("mode", "chat"),  # chat, workflow, agent, chatflow
                "icon": app.get("icon", ""),
                "icon_background": app.get("icon_background", "#1C64F2")
            })

        logger.info(f"Successfully fetched {len(result)} Dify apps")
        return result

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


@router.get("/apps/{app_id}/parameters")
def get_dify_app_parameters(
    app_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user)
) -> Dict[str, Any]:
    """
    Get parameters schema for a specific Dify application

    Args:
        app_id: Dify application ID

    Returns:
        Parameters schema with field definitions
    """

    # Find user's Dify Model configuration
    models = db.query(Kind).filter(
        Kind.user_id == current_user.id,
        Kind.kind == "Model",
        Kind.is_active == True
    ).all()

    dify_config = None
    for model in models:
        try:
            model_crd = Model.model_validate(model.json)
            env = model_crd.spec.modelConfig.get("env", {})

            if "DIFY_API_KEY" in env and "DIFY_BASE_URL" in env:
                dify_config = {
                    "api_key": env["DIFY_API_KEY"],
                    "base_url": env["DIFY_BASE_URL"]
                }
                break
        except Exception as e:
            logger.warning(f"Failed to parse model {model.id}: {e}")
            continue

    if not dify_config:
        raise HTTPException(
            status_code=404,
            detail="No Dify configuration found"
        )

    # Call Dify API to get app parameters
    try:
        api_url = f"{dify_config['base_url']}/v1/parameters"
        headers = {
            "Authorization": f"Bearer {dify_config['api_key']}",
            "Content-Type": "application/json"
        }

        params = {"app_id": app_id}

        logger.info(f"Fetching parameters for Dify app: {app_id}")

        response = requests.get(
            api_url,
            headers=headers,
            params=params,
            timeout=10
        )

        response.raise_for_status()
        data = response.json()

        logger.info(f"Successfully fetched parameters for app {app_id}")
        return data

    except requests.exceptions.HTTPError as e:
        # If parameters endpoint doesn't exist, return empty schema
        if e.response is not None and e.response.status_code == 404:
            logger.info(f"Parameters endpoint not available for app {app_id}, returning empty schema")
            return {"user_input_form": []}

        error_msg = f"Dify API HTTP error: {e}"
        logger.error(error_msg)
        raise HTTPException(status_code=502, detail=error_msg)

    except Exception as e:
        error_msg = f"Failed to fetch app parameters: {str(e)}"
        logger.error(error_msg)
        raise HTTPException(status_code=500, detail=error_msg)
