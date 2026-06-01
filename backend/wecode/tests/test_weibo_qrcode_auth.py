# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from sqlalchemy.orm import Session

from app.models.user import User
from wecode.service import weibo_qrcode_auth_service as service_module
from wecode.service.weibo_qrcode_auth_service import WeiboQrcodeAuthService


@pytest.mark.asyncio
async def test_create_weibo_qrcode_challenge(httpx_mock):
    httpx_mock.add_response(
        method="GET",
        url="https://qrcode.sina.com.cn/qrcode/newdata?appid=1142",
        json={
            "status": 0,
            "msg": "OK",
            "data": {
                "sid": "sid-1",
                "data": "https://koudai.sina.com/staffvdun/qr?d=full",
                "dataShort": "https://vpn.sina.com/s/short",
            },
        },
    )

    challenge = await WeiboQrcodeAuthService().create_challenge()

    assert challenge.sid == "sid-1"
    assert challenge.qr_data == "https://koudai.sina.com/staffvdun/qr?d=full"
    assert challenge.qr_code_image.startswith("data:image/png;base64,")
    assert challenge.expires_in == 60


@pytest.mark.asyncio
async def test_complete_weibo_qrcode_login_creates_user(
    httpx_mock,
    monkeypatch,
    test_db: Session,
):
    monkeypatch.setattr(
        service_module,
        "apply_default_resources_sync",
        lambda user_id: None,
    )
    httpx_mock.add_response(
        method="GET",
        url="https://qrcode.sina.com.cn/qrcode/status?appid=1142&sid=sid-1&poll=1",
        json={
            "status": 2,
            "data": {
                "username": "weibo-user",
                "uid": "123",
            },
        },
    )
    httpx_mock.add_response(
        method="GET",
        url=(
            "https://qrcode.sina.com.cn/qrcode/push?"
            "appid=1142&uid=123&qrdata=https%3A%2F%2Fkoudai.sina.com%2Fqr"
        ),
        json={"status": 0},
    )

    result = await WeiboQrcodeAuthService().complete_login(
        db=test_db,
        sid="sid-1",
        qr_data="https://koudai.sina.com/qr",
    )

    user = test_db.query(User).filter(User.user_name == "weibo-user").first()
    assert result.status == "success"
    assert result.access_token
    assert user is not None
    assert user.auth_source == "weibo_qrcode"


@pytest.mark.asyncio
async def test_complete_weibo_qrcode_login_returns_pending(
    httpx_mock, test_db: Session
):
    httpx_mock.add_response(
        method="GET",
        url="https://qrcode.sina.com.cn/qrcode/status?appid=1142&sid=sid-1&poll=1",
        json={"status": 0},
    )

    result = await WeiboQrcodeAuthService().complete_login(
        db=test_db,
        sid="sid-1",
        qr_data="https://koudai.sina.com/qr",
    )

    assert result.status == "pending"
    assert result.access_token is None
