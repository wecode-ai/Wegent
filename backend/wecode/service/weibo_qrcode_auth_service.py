# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Weibo QR code authentication helpers."""

import base64
import io
import json
import logging
import uuid
from dataclasses import dataclass
from typing import Any

import httpx
import qrcode
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import create_access_token, get_password_hash
from app.models.user import User
from app.services.k_batch import apply_default_resources_sync

logger = logging.getLogger(__name__)

QRCODE_BASE_URL = "https://qrcode.sina.com.cn/qrcode"
QRCODE_APP_ID = "1146"
QRCODE_EXPIRE_SECONDS = 60
REQUEST_TIMEOUT_SECONDS = 10


@dataclass(frozen=True)
class WeiboQrcodeChallenge:
    """A QR code challenge returned to the login page."""

    sid: str
    qr_data: str
    qr_code_image: str
    expires_in: int


@dataclass(frozen=True)
class WeiboQrcodeLoginResult:
    """A completed QR code login result."""

    status: str
    access_token: str | None = None
    token_type: str = "bearer"


class WeiboQrcodeAuthError(Exception):
    """Raised when the upstream QR code auth service returns an invalid result."""


def _read_json(response: httpx.Response) -> dict[str, Any]:
    try:
        return response.json()
    except json.JSONDecodeError as exc:
        raise WeiboQrcodeAuthError("Invalid QR code service response") from exc


def _build_qr_code_image_data_url(data: str) -> str:
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_L,
        box_size=8,
        border=3,
    )
    qr.add_data(data)
    qr.make(fit=True)
    image = qr.make_image(fill_color="#1a1a1a", back_color="white")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


class WeiboQrcodeAuthService:
    """Integrates with Sina Weibo QR code login endpoints."""

    async def create_challenge(self) -> WeiboQrcodeChallenge:
        url = f"{QRCODE_BASE_URL}/newdata"
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.get(url, params={"appid": QRCODE_APP_ID})
            response.raise_for_status()

        payload = _read_json(response)
        if payload.get("status") != 0:
            raise WeiboQrcodeAuthError("Failed to create QR code")

        data = payload.get("data") or {}
        sid = data.get("sid")
        qr_data = data.get("data")
        qr_data_short = data.get("dataShort") or qr_data
        if not sid or not qr_data or not qr_data_short:
            raise WeiboQrcodeAuthError("QR code response is missing required fields")

        logger.info("Created Weibo QR code challenge: sid=%s", sid)
        return WeiboQrcodeChallenge(
            sid=sid,
            qr_data=qr_data,
            qr_code_image=_build_qr_code_image_data_url(qr_data_short),
            expires_in=QRCODE_EXPIRE_SECONDS,
        )

    async def complete_login(
        self,
        db: Session,
        sid: str,
        qr_data: str,
    ) -> WeiboQrcodeLoginResult:
        username, uid = await self._query_status(sid)
        if not username:
            return WeiboQrcodeLoginResult(status="pending")

        if uid:
            await self._push_scan(sid=sid, uid=uid, qr_data=qr_data)

        user = self._find_or_create_user(db, username)
        access_token = create_access_token(
            data={"sub": user.user_name, "user_id": user.id}
        )
        return WeiboQrcodeLoginResult(status="success", access_token=access_token)

    async def _query_status(self, sid: str) -> tuple[str, str]:
        url = f"{QRCODE_BASE_URL}/status"
        params = {"appid": QRCODE_APP_ID, "sid": sid, "poll": "1"}
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()

        payload = _read_json(response)
        if payload.get("status") != 2:
            return "", ""

        data = payload.get("data") or {}
        return str(data.get("username") or ""), str(data.get("uid") or "")

    async def _push_scan(self, sid: str, uid: str, qr_data: str) -> None:
        url = f"{QRCODE_BASE_URL}/push"
        params = {"appid": QRCODE_APP_ID, "uid": uid, "qrdata": qr_data}
        try:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
                response = await client.get(url, params=params)
                response.raise_for_status()
            payload = _read_json(response)
            if payload.get("status") == 0:
                logger.info("Pushed Weibo QR code scan confirmation: sid=%s", sid)
            else:
                logger.warning(
                    "Weibo QR code scan confirmation failed: sid=%s, msg=%s",
                    sid,
                    payload.get("msg"),
                )
        except Exception as exc:
            logger.warning("Failed to push Weibo QR code scan confirmation: %s", exc)

    def _find_or_create_user(self, db: Session, username: str) -> User:
        user = db.scalar(select(User).where(User.user_name == username))
        if user:
            changed = False
            if user.auth_source == "unknown":
                user.auth_source = "weibo_qrcode"
                changed = True
            if changed:
                db.commit()
                db.refresh(user)
            return user

        user = User(
            user_name=username,
            email=None,
            password_hash=get_password_hash(str(uuid.uuid4())),
            git_info=[],
            is_active=True,
            preferences=json.dumps({}),
            auth_source="weibo_qrcode",
        )
        db.add(user)
        db.commit()
        db.refresh(user)

        try:
            apply_default_resources_sync(user.id)
        except Exception as exc:
            logger.warning(
                "Failed to apply default resources for Weibo QR user %s: %s",
                user.id,
                exc,
            )

        return user


weibo_qrcode_auth_service = WeiboQrcodeAuthService()
