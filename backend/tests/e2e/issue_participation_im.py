# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Issue participation protocol integration through the real private IM sender."""

import asyncio
import os
from typing import Any

import httpx
from sqlalchemy.orm import Session

from app.core import async_utils
from app.core.security import create_access_token
from app.db.session import SessionLocal
from app.models.delivery import LoopItem, LoopItemCollaborator
from app.schemas.delivery import LoopItemCreate
from app.services.channels.dingtalk.sender import DingTalkRobotSender
from app.services.loop_items.service import loop_item_service
from tests.e2e._dingtalk_card_server import RecordingDingTalkServer
from tests.e2e.dingtalk_notification_card_context import (
    CHANNEL_ID,
    CUSTOM_TEMPLATE_ID,
    _cleanup,
    _connect_dingtalk,
    _delete_sessions,
    _make_project,
    _make_user,
    _messager_channel,
)

TITLE = "修复登录后白屏"
CREATED = "事项已创建"
JOINED = "你已加入事项"


def _assert_cards(
    cards: list[dict[str, Any]], url: str, expected: dict[int, str]
) -> None:
    actual = []
    for card in cards:
        params = card["cardData"]["cardParamMap"]
        assert url in (params["primaryUrl"], params["secondaryUrl"]), params
        assert params["itemTitle"] == TITLE, params
        assert "打开 Wework 查看事项。" in params["detail"], params
        actual.append((card["openSpaceId"], params["headline"]))
    assert sorted(actual) == sorted(
        (f"dtv1.card//IM_ROBOT.staff-{user_id}", headline)
        for user_id, headline in expected.items()
    )


async def _personal_issue(
    server: RecordingDingTalkServer,
    client: httpx.AsyncClient,
    headers: dict[str, str],
    outsider_headers: dict[str, str],
    people: list[int],
    issue_ids: list[str],
) -> None:
    owner, initial, later, outsider = people
    issue = (
        (
            await client.post(
                "/api/v1/personal-issues",
                headers=headers,
                json={"title": TITLE, "participants": [owner, initial, initial]},
            )
        )
        .raise_for_status()
        .json()
    )
    issue_ids.append(issue["id"])
    url = f"wework://personal-issues/{issue['id']}"
    path = f"/api/v1/personal-issues/{issue['id']}"
    _assert_cards(server.cards(), url, {owner: CREATED, initial: JOINED})

    change = {
        "title": TITLE,
        "version": issue["version"],
        "participants": [owner, initial, later],
    }
    forbidden = await client.patch(
        path, headers=outsider_headers, json={**change, "participants": [outsider]}
    )
    assert forbidden.status_code == 404, forbidden.text
    _assert_cards(server.cards(), url, {owner: CREATED, initial: JOINED})

    updated = (
        (await client.patch(path, headers=headers, json=change))
        .raise_for_status()
        .json()
    )
    assert set(updated["metadata"]["participants"]) == {owner, initial, later}
    expected = {owner: CREATED, initial: JOINED, later: JOINED}
    _assert_cards(server.cards(), url, expected)

    unchanged = await client.patch(
        path, headers=headers, json={**change, "version": updated["version"]}
    )
    unchanged.raise_for_status()
    _assert_cards(server.cards(), url, expected)


async def _project_issue(
    server: RecordingDingTalkServer,
    db: Session,
    project_id: int,
    owner: int,
    invitee: int,
    issue_ids: list[str],
) -> None:
    before = len(server.cards())
    issue = loop_item_service.create(db, project_id, owner, LoopItemCreate(title=TITLE))
    issue_ids.append(issue.id)
    url = f"wework://boards/{project_id}/issues/{issue.id}"
    await server.wait_for_card(after=before, item_key=issue.id)
    _assert_cards(server.cards()[before:], url, {owner: CREATED})

    loop_item_service.add_collaborator(db, issue.id, invitee, owner)
    await server.wait_for_card(after=before + 1, item_key=issue.id)
    _assert_cards(server.cards()[before:], url, {owner: CREATED, invitee: JOINED})


async def run() -> None:
    server = RecordingDingTalkServer()
    server.start()
    original_url = DingTalkRobotSender.BASE_URL
    original_loop = async_utils.get_main_event_loop()
    DingTalkRobotSender.BASE_URL = server.base_url
    async_utils.set_main_event_loop(asyncio.get_running_loop())

    user_ids: list[int] = []
    project_ids: list[str] = []
    personal_ids: list[str] = []
    project_issue_ids: list[str] = []
    sessions = []
    try:
        with SessionLocal() as db:
            users = [
                _make_user(db, role)
                for role in ("owner", "initial", "later", "outsider")
            ]
            for user in users:
                user.git_info = {}
                user.preferences = "{}"
            user_ids.extend(user.id for user in users)
            channel = _messager_channel(
                channel_id=CHANNEL_ID,
                name="issue-participation-e2e",
                client_id="issue-participation-e2e",
                notification_card={"template_id": CUSTOM_TEMPLATE_ID},
            )
            channel.json["spec"]["config"]["api_base_url"] = server.base_url
            db.add(channel)
            project = _make_project(db, users[0])
            project_ids.append(str(project.id))
            for user in users:
                sessions.append(await _connect_dingtalk(db, user))
            owner, _, later, outsider = users
            headers = {
                user.id: {
                    "Authorization": "Bearer "
                    + create_access_token({"sub": user.user_name, "user_id": user.id})
                }
                for user in (owner, outsider)
            }
            async with httpx.AsyncClient(
                base_url=os.environ["E2E_API_URL"], timeout=10, trust_env=False
            ) as client:
                await _personal_issue(
                    server,
                    client,
                    headers[owner.id],
                    headers[outsider.id],
                    user_ids,
                    personal_ids,
                )
            await _project_issue(
                server, db, int(project.id), owner.id, later.id, project_issue_ids
            )
    finally:
        try:
            await _delete_sessions(sessions=sessions, user_ids=user_ids)
        finally:
            with SessionLocal() as db:
                db.query(LoopItem).filter(LoopItem.id.in_(personal_ids)).delete(
                    synchronize_session=False
                )
                db.query(LoopItemCollaborator).filter(
                    LoopItemCollaborator.loop_item_id.in_(project_issue_ids)
                ).delete(synchronize_session=False)
                _cleanup(
                    db, user_ids=user_ids, project_ids=project_ids, device_names=[]
                )
            DingTalkRobotSender.BASE_URL = original_url
            async_utils.set_main_event_loop(original_loop)
            server.stop()


if __name__ == "__main__":
    asyncio.run(run())
    print(
        "Issue creation and invitations delivered to the expected private IM recipients"
    )
