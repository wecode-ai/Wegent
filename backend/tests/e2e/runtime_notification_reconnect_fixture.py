"""Seed IM configuration in the isolated desktop CI database and Redis only."""

from __future__ import annotations

import asyncio
import json
import os

from app.core.cache import cache_manager
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.services.im.session_service import im_session_service
from shared.utils.crypto import encrypt_sensitive_data


async def run() -> None:
    request = json.loads(os.environ["WEWORK_IM_RECONNECT_FIXTURE"])
    user_id = request["userId"]
    channel_id = 779178
    session = await im_session_service.get_or_create_private_session(
        db=None,
        user_id=user_id,
        channel_type="dingtalk",
        channel_id=channel_id,
        conversation_id="reconnect-ci",
        sender_id="reconnect-ci-sender",
        proactive_recipient_id="reconnect-ci-staff",
        display_name="Reconnect protocol fixture",
    )
    if request["operation"] == "disable":
        await im_session_service.disable_global_notification(user_id)
    elif request["operation"] == "seed":
        with SessionLocal() as db:
            db.add(
                Kind(
                    id=channel_id,
                    user_id=0,
                    kind="Messager",
                    name="reconnect-ci",
                    namespace="system",
                    is_active=True,
                    json={
                        "spec": {
                            "channelType": "dingtalk",
                            "isEnabled": True,
                            "config": {
                                "client_id": "reconnect-ci-app",
                                "client_secret": encrypt_sensitive_data(
                                    "reconnect-ci-secret"
                                ),
                                "api_base_url": request["apiBase"],
                            },
                        }
                    },
                )
            )
            db.commit()
        await im_session_service.enable_global_notification(db=None, session=session)
    elif request["operation"] == "receipts":
        receipts = {}
        async with cache_manager._client_context() as client:
            async for key in client.scan_iter(
                match="channel:runtime_notification_receipt:*"
            ):
                value = await client.get(key)
                if value == b"sent" or value == "sent":
                    receipts[str(key)] = "sent"
        print(json.dumps({"receipts": receipts}))
    else:
        raise ValueError("Unknown reconnect fixture operation")
    if request["operation"] != "receipts":
        print(json.dumps({"configured": True, "sessionKey": session.session_key}))
    await cache_manager.aclose()


if __name__ == "__main__":
    asyncio.run(run())
