# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Conversation AI Card implementation with a post-run settings action."""

from typing import TYPE_CHECKING, Any

from dingtalk_stream.card_replier import AICardStatus

from app.services.channels.dingtalk.card import DingTalkMarkdownCard
from app.services.channels.dingtalk.card_transport import stringify_card_data

if TYPE_CHECKING:
    from dingtalk_stream import ChatbotMessage
    from dingtalk_stream.stream import DingTalkStreamClient


class DingTalkConversationCardInstance(DingTalkMarkdownCard):
    """Match the SDK AI-card interface while using an administrator template."""

    def __init__(
        self,
        client: "DingTalkStreamClient",
        incoming_message: "ChatbotMessage",
        template_id: str,
    ) -> None:
        super().__init__(client, incoming_message)
        self.card_template_id = template_id
        self.card_instance_id: str | None = None
        self.markdown = ""
        self.inputing_status = False

    def set_order(self, _order: list[str]) -> None:
        """Keep compatibility with the built-in AIMarkdownCardInstance."""

    def _card_data(self, *, show_settings: bool, status: str = "") -> dict[str, str]:
        return stringify_card_data(
            {
                "title": "Wegent",
                "content": self.markdown,
                "status": status,
                "showSettings": show_settings,
                "settingsText": "会话设置",
            }
        )

    def ai_start(self) -> None:
        if self.card_instance_id:
            return
        self.card_instance_id = self.start(
            self.card_template_id,
            self._card_data(show_settings=False, status="正在处理"),
            support_forward=False,
        )

    def ai_streaming(self, markdown: str, append: bool = False) -> None:
        if not self.card_instance_id:
            return
        if append:
            self.markdown += markdown
        else:
            self.markdown = markdown
        if not self.inputing_status:
            self.put_card_data(
                self.card_instance_id,
                {
                    **self._card_data(show_settings=False, status="正在处理"),
                    "flowStatus": AICardStatus.INPUTING,
                },
            )
            self.inputing_status = True
        self.streaming(
            self.card_instance_id,
            "content",
            self.markdown,
            append=False,
            finished=False,
            failed=False,
        )

    def ai_finish(self, markdown: str | None = None, **_kwargs: Any) -> None:
        if not self.card_instance_id:
            return
        if markdown is not None:
            self.markdown = markdown
        self.finish(
            self.card_instance_id,
            self._card_data(show_settings=True, status=""),
        )

    def ai_fail(self) -> None:
        if not self.card_instance_id:
            return
        self.fail(
            self.card_instance_id,
            self._card_data(show_settings=True, status="执行失败"),
        )
