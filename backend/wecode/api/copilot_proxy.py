# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import APIRouter, Request, HTTPException, Depends
import httpx
import logging
from app.core import security
from app.models.user import User

router = APIRouter()

@router.api_route("/copilot/{path:path}", methods=["GET"])
async def proxy_copilot(
    path: str,
    request: Request,
    current_user: User = Depends(security.get_current_user)
):
    """
    Generic proxy for all paths under copilot.weibo.com/v1/, automatically get current user user_name from system as wecode-user and pass through
    """
    logger = logging.getLogger("proxy_copilot")

    # Construct target URL
    target_url = f"http://copilot.weibo.com/v1/{path}"
    # logger.info(f"proxy_copilot target_url: {target_url}")

    # Copy all headers, force override wecode-user, ensure key is str
    headers = {str(k): str(v) for k, v in request.headers.items()}
    headers.pop("host", None)  # Remove host to avoid overriding target host
    headers.pop("Authorization", None)
    headers["wecode-user"] = current_user.user_name

    # Read request body
    body = await request.body()

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.request(
                method=request.method,
                url=target_url,
                headers=headers,
                params=request.query_params,
                content=body,
                timeout=10
            )
        # Print passthrough response headers
        # logger.info(f"proxy_copilot response headers: {resp.status_code}")
        # logger.info(f"proxy_copilot response headers: {dict(resp.headers)}")
        # Passthrough response
        content_type = resp.headers.get("content-type", "")
        if content_type.startswith("application/json"):
            return resp.json()
        return resp.text
    except httpx.RequestError as e:
        logger.error(f"Request to copilot failed: {str(e)}")
        raise HTTPException(status_code=502, detail=f"Request to copilot failed: {str(e)}")
    except Exception as e:
        logger.error(f"Unexpected error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Unexpected error: {str(e)}")