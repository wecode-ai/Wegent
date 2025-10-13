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
    通用代理 copilot.weibo.com/v1/ 下所有路径，自动从系统获取当前用户 user_name 作为 wecode-user 透传
    """
    logger = logging.getLogger("proxy_copilot")

    # 构造目标 URL
    target_url = f"http://copilot.weibo.com/v1/{path}"
    logger.info(f"proxy_copilot target_url: {target_url}")

    # 复制所有 headers，强制覆盖 wecode-user，确保 key 为 str
    headers = {str(k): str(v) for k, v in request.headers.items()}
    headers.pop("host", None)  # 移除 host，避免覆盖目标 host
    headers.pop("Authorization", None)
    headers["wecode-user"] = current_user.user_name

    # 读取请求体
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
        # 打印透传响应的 headers
        logger.info(f"proxy_copilot response headers: {resp.status_code}")
        logger.info(f"proxy_copilot response headers: {dict(resp.headers)}")
        # 透传响应
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