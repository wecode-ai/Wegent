# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Email notification client for sending emails via SMTP.
"""

import logging
import smtplib
import time
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import List, Optional

import markdown

from app.core.config import settings

logger = logging.getLogger(__name__)


class EmailClient:
    """
    Email client for sending notifications via SMTP.

    Usage:
        client = EmailClient()
        await client.send_html_email(
            to_emails=["user@staff.weibo.com"],
            subject="Notification",
            html_content="<h1>Hello</h1>"
        )
    """

    def __init__(self):
        self.smtp_host = settings.EMAIL_SMTP_HOST
        self.smtp_port = settings.EMAIL_SMTP_PORT
        self.sender = settings.EMAIL_SENDER
        self.login_user = (
            settings.EMAIL_LOGIN_USER
        )  # Login username (may differ from sender)
        self.password = settings.EMAIL_PASSWORD
        self.use_tls = settings.EMAIL_USE_TLS

    def send_html_email(
        self,
        to_emails: List[str],
        subject: str,
        html_content: str,
        text_content: Optional[str] = None,
    ) -> bool:
        """
        Send an HTML email to multiple recipients.

        Args:
            to_emails: List of recipient email addresses
            subject: Email subject
            html_content: HTML content of the email
            text_content: Optional plain text alternative

        Returns:
            True if sent successfully, False otherwise
        """
        try:
            # Create message
            msg = MIMEMultipart("alternative")
            msg["Subject"] = subject
            msg["From"] = self.sender
            msg["To"] = ", ".join(to_emails)

            # Add text part if provided
            if text_content:
                text_part = MIMEText(text_content, "plain", "utf-8")
                msg.attach(text_part)

            # Add HTML part
            html_part = MIMEText(html_content, "html", "utf-8")
            msg.attach(html_part)

            # Connect and send
            if self.use_tls:
                server = smtplib.SMTP(self.smtp_host, self.smtp_port)
                server.starttls()
            else:
                server = smtplib.SMTP(self.smtp_host, self.smtp_port)

            # Debug: print credentials (mask password)
            password_masked = self.password[:3] + "***" if self.password else "None"
            logger.info(
                f"[Email] SMTP login with user={self.login_user}, password={password_masked}"
            )

            server.login(self.login_user, self.password)
            server.sendmail(self.sender, to_emails, msg.as_string())
            server.quit()

            logger.info(f"[Email] Email sent successfully to {to_emails}")
            # 邮箱限制1分钟60封邮件, 所以再这里发送一封邮件 sleep 1s
            time.sleep(1)
            return True
        except Exception as e:
            logger.error(f"[Email] Failed to send email to {to_emails}: {e}")
            return False

    def send_unread_summary_email(
        self,
        to_email: str,
        user_name: str,
        unread_groups: List[dict],
        frontend_url: str,
    ) -> bool:
        """
        Send a daily unread message summary email.

        Args:
            to_email: Recipient email address
            user_name: User's display name
            unread_groups: List of dicts with group info:
                - task_id: Task/group ID
                - title: Group/task title
                - count: Number of unread messages
            frontend_url: Base URL for the frontend

        Returns:
            True if sent successfully, False otherwise
        """
        if not unread_groups:
            logger.info(f"[Email] No unread messages for {to_email}, skipping email")
            return True

        subject = f"Wegent 群聊消息汇总 - 您有 {sum(g['count'] for g in unread_groups)} 条未读消息"

        # Build HTML content
        group_rows = ""
        for group in unread_groups:
            task_url = f"{frontend_url}/chat?taskId={group['task_id']}"
            group_rows += f"""
            <tr>
                <td style="padding: 12px; border-bottom: 1px solid #eee;">
                    <a href="{task_url}" style="color: #1890ff; text-decoration: none;">
                        {group['title']}
                    </a>
                </td>
                <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: center;">
                    <span style="background: #ff4d4f; color: white; padding: 2px 8px; border-radius: 10px;">
                        {group['count']}
                    </span>
                </td>
            </tr>
            """

        html_content = f"""
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0;">
                <h1 style="color: white; margin: 0; font-size: 24px;">Wegent 消息汇总</h1>
                <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">
                    您好 {user_name}，以下是您今天的未读群聊消息
                </p>
            </div>

            <div style="background: white; padding: 20px; border: 1px solid #eee; border-top: none;">
                <table style="width: 100%; border-collapse: collapse;">
                    <thead>
                        <tr style="background: #fafafa;">
                            <th style="padding: 12px; text-align: left; border-bottom: 2px solid #eee;">群聊名称</th>
                            <th style="padding: 12px; text-align: center; border-bottom: 2px solid #eee;">未读消息</th>
                        </tr>
                    </thead>
                    <tbody>
                        {group_rows}
                    </tbody>
                </table>

                <div style="margin-top: 20px; text-align: center;">
                    <a href="{frontend_url}"
                       style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 30px; border-radius: 5px; text-decoration: none; font-weight: bold;">
                        前往 Wegent 查看
                    </a>
                </div>
            </div>

            <div style="background: #fafafa; padding: 15px; border-radius: 0 0 10px 10px; text-align: center; font-size: 12px; color: #999;">
                <p style="margin: 0;">此邮件由 Wegent 系统自动发送，请勿回复</p>
                <p style="margin: 5px 0 0 0;">如需帮助，请联系管理员</p>
            </div>
        </body>
        </html>
        """

        text_content = f"""
        Wegent 消息汇总

        您好 {user_name}，以下是您今天的未读群聊消息：

        """
        for group in unread_groups:
            text_content += f"- {group['title']}: {group['count']} 条未读消息\n"
        text_content += f"\n前往 Wegent 查看: {frontend_url}"

        return self.send_html_email(
            to_emails=[to_email],
            subject=subject,
            html_content=html_content,
            text_content=text_content,
        )

    def send_group_chat_summary_email(
        self,
        to_email: str,
        user_name: str,
        group_summaries: List[dict],
        frontend_url: str,
        hours_back: int = 12,
    ) -> bool:
        """
        Send a daily group chat conversation summary email.

        Args:
            to_email: Recipient email address
            user_name: User's display name
            group_summaries: List of dicts with group info:
                - task_id: Task/group ID
                - title: Group/task title
                - conversation: List of messages (used for counting only)
                - summary: AI-generated summary of the conversation
            frontend_url: Base URL for the frontend
            hours_back: Number of hours the summary covers

        Returns:
            True if sent successfully, False otherwise
        """
        if not group_summaries:
            logger.info(
                f"[Email] No group chat activity for {to_email}, skipping email"
            )
            return True

        total_messages = sum(len(g.get("conversation", [])) for g in group_summaries)
        subject = f"Wegent 群聊汇总 - 最近{hours_back}小时您参与的 {len(group_summaries)} 个群聊有 {total_messages} 条新消息"

        # Build HTML content for each group (summary only, no conversation details)
        groups_html = ""
        for group in group_summaries:
            task_url = f"{frontend_url}/chat?taskId={group['task_id']}"
            conversation = group.get("conversation", [])
            summary = group.get("summary", "")
            # Convert Markdown summary to HTML
            summary_html = (
                markdown.markdown(summary, extensions=["nl2br"]) if summary else ""
            )

            groups_html += f"""
            <div style="margin-bottom: 20px; border: 1px solid #eee; border-radius: 8px; overflow: hidden;">
                <div style="background: #fafafa; padding: 12px 15px; border-bottom: 1px solid #eee;">
                    <a href="{task_url}" style="color: #1890ff; text-decoration: none; font-weight: bold; font-size: 16px;">
                        {group['title']}
                    </a>
                </div>
                <div style="padding: 15px;">
                    <div style="color: #666; font-size: 14px; line-height: 1.6;">{summary_html}</div>
                </div>
                <div style="padding: 0 15px 15px; text-align: center;">
                    <a href="{task_url}"
                       style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 10px 24px; border-radius: 5px; text-decoration: none; font-weight: bold; font-size: 13px;">
                        前往 Wegent 查看完整对话
                    </a>
                </div>
            </div>
            """

        html_content = f"""
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 700px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0;">
                <h1 style="color: white; margin: 0; font-size: 24px;">Wegent 群聊汇总</h1>
                <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">
                    您好 {user_name}，以下是您参与的群聊最近 {hours_back} 小时的消息汇总
                </p>
            </div>

            <div style="background: white; padding: 20px; border: 1px solid #eee; border-top: none;">
                {groups_html}
            </div>

            <div style="background: #fafafa; padding: 15px; border-radius: 0 0 10px 10px; text-align: center; font-size: 12px; color: #999;">
                <p style="margin: 0;">此邮件由 Wegent 系统自动发送，请勿回复</p>
                <p style="margin: 5px 0 0 0;">如需帮助，请联系管理员</p>
            </div>
        </body>
        </html>
        """

        # Build plain text content (summary only)
        text_content = f"""Wegent 群聊汇总

您好 {user_name}，以下是您参与的群聊最近 {hours_back} 小时的消息汇总：

"""
        for group in group_summaries:
            task_url = f"{frontend_url}/chat?taskId={group['task_id']}"
            conversation = group.get("conversation", [])
            text_content += f"\n=== {group['title']} ({len(conversation)} 条消息) ===\n"
            text_content += f"摘要: {group.get('summary', '')}\n"
            text_content += f"查看完整对话: {task_url}\n"

        return self.send_html_email(
            to_emails=[to_email],
            subject=subject,
            html_content=html_content,
            text_content=text_content,
        )
