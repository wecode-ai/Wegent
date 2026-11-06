// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! SMTP/MIME and official DingTalk transports configured by their caller.
use super::GroupSummary;
use crate::config::env_or_dotenv;
use anyhow::{Context, Result, bail};
use chrono::Utc;
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    message::{MultiPart, SinglePart},
    transport::smtp::authentication::Credentials,
};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::Mutex;

pub struct SmtpSender {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    sender: lettre::message::Mailbox,
}
impl SmtpSender {
    pub fn from_env() -> Result<Self> {
        let host = env_or_dotenv("EMAIL_SMTP_HOST").unwrap_or_default();
        if host.is_empty() {
            bail!("EMAIL_SMTP_HOST is not configured");
        }
        let port = env_or_dotenv("EMAIL_SMTP_PORT")
            .map(|v| v.parse::<u16>())
            .transpose()?
            .unwrap_or(25);
        let sender = env_or_dotenv("EMAIL_SENDER")
            .unwrap_or_default()
            .parse()
            .context("EMAIL_SENDER is invalid")?;
        let tls = env_or_dotenv("EMAIL_USE_TLS").is_some_and(|v| {
            matches!(v.to_ascii_lowercase().as_str(), "true" | "yes" | "1" | "on")
        });
        let builder = if tls {
            AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&host)?
        } else {
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host)
        };
        let credentials = Credentials::new(
            env_or_dotenv("EMAIL_LOGIN_USER").unwrap_or_default(),
            env_or_dotenv("EMAIL_PASSWORD").unwrap_or_default(),
        );
        let transport = builder
            .port(port)
            .timeout(Some(Duration::from_secs(30)))
            .credentials(credentials)
            .build();
        Ok(Self { transport, sender })
    }
    pub async fn group_summary(
        &self,
        email: &str,
        user: &str,
        groups: &[GroupSummary],
        frontend: &str,
        hours: i64,
    ) -> Result<bool> {
        if groups.is_empty() {
            return Ok(true);
        }
        let (subject, html, text) = group_email(user, groups, frontend, hours);
        let message = Message::builder()
            .from(self.sender.clone())
            .to(email.parse()?)
            .subject(subject)
            .multipart(
                MultiPart::alternative()
                    .singlepart(SinglePart::plain(text))
                    .singlepart(SinglePart::html(html)),
            )?;
        self.transport.send(message).await?;
        // Preserve the source's per-process throttle below 60 emails/minute.
        tokio::time::sleep(Duration::from_secs(1)).await;
        Ok(true)
    }
}

pub struct DingtalkSender {
    client: brz_http::Client,
    key: String,
    secret: String,
    user_info_url: String,
    token: Mutex<(String, i64)>,
}
impl DingtalkSender {
    pub fn new(
        client: brz_http::Client,
        key: String,
        secret: String,
        user_info_url: String,
    ) -> Self {
        Self {
            client,
            key,
            secret,
            user_info_url,
            token: Mutex::new((String::new(), 0)),
        }
    }
    pub async fn markdown(&self, email: &str, title: &str, content: &str) -> Result<bool> {
        if self.user_info_url.is_empty() {
            bail!("DINGTALK_USER_INFO_URL is not configured");
        }
        let response = self
            .client
            .post(&self.user_info_url)?
            .json(&json!({"emails":[email]}))
            .send()
            .await?;
        if !response.status().is_success() {
            bail!(
                "DingTalk recipient lookup returned HTTP {}",
                response.status().as_u16()
            );
        }
        let users: Value = response.json().await?;
        let Some(employee) = users
            .as_array()
            .and_then(|v| v.first())
            .and_then(|v| v["EMPLOYEE_ID"].as_str())
        else {
            return Ok(false);
        };
        let token = {
            let mut token = self.token.lock().await;
            if Utc::now().timestamp() >= token.1 {
                let response = self
                    .client
                    .post("https://api.dingtalk.com/v1.0/oauth2/accessToken")?
                    .json(&json!({"appKey":self.key,"appSECRET":self.secret}))
                    .send()
                    .await?;
                if !response.status().is_success() {
                    bail!(
                        "DingTalk access token request returned HTTP {}",
                        response.status().as_u16()
                    );
                }
                let body: Value = response.json().await?;
                token.0 = body["accessToken"].as_str().unwrap_or("").into();
                token.1 = Utc::now().timestamp() + body["expireIn"].as_i64().unwrap_or(7200) - 600;
            }
            token.0.clone()
        };
        let response=self.client.post("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend")?
            .header("x-acs-dingtalk-access-token",token).json(&json!({"robotCode":self.key,"userIds":[employee],
                "msgKey":"sampleMarkdown","msgParam":json!({"title":title,"text":content}).to_string()})).send().await?;
        Ok(response.status().is_success())
    }
}

fn markdown_html(markdown: &str) -> String {
    let parser = pulldown_cmark::Parser::new(markdown).map(|event| {
        if matches!(event, pulldown_cmark::Event::SoftBreak) {
            pulldown_cmark::Event::HardBreak
        } else {
            event
        }
    });
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, parser);
    html
}

pub fn group_email(
    user: &str,
    groups: &[GroupSummary],
    frontend: &str,
    hours: i64,
) -> (String, String, String) {
    let total: usize = groups.iter().map(|g| g.conversation.len()).sum();
    let subject = format!(
        "Wegent 群聊汇总 - 最近{hours}小时您参与的 {} 个群聊有 {total} 条新消息",
        groups.len()
    );
    let mut group_html = String::new();
    let mut text = format!(
        "Wegent 群聊汇总\n\n您好 {user}，以下是您参与的群聊最近 {hours} 小时的消息汇总：\n\n"
    );
    for group in groups {
        let url = format!("{frontend}/chat?taskId={}", group.task_id);
        group_html.push_str(
            &include_str!("notify_group_fragment.html")
                .replace("{{task_url}}", &url)
                .replace("{{group['title']}}", &group.title)
                .replace("{{summary_html}}", &markdown_html(&group.summary)),
        );
        text.push_str(&format!(
            "\n=== {} ({} 条消息) ===\n摘要: {}\n查看完整对话: {url}\n",
            group.title,
            group.conversation.len(),
            group.summary
        ));
    }
    let html = include_str!("notify_group_email.html")
        .replace("{{user_name}}", user)
        .replace("{{hours_back}}", &hours.to_string())
        .replace("{{groups_html}}", &group_html);
    (subject, html, text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::background_jobs::notifications::Message;
    #[test]
    fn email_has_html_and_plain_alternatives_and_task_links() {
        let group = GroupSummary {
            task_id: 42,
            title: "Group".into(),
            conversation: vec![Message {
                role: "user".into(),
                username: "User".into(),
                content: "message".into(),
            }],
            summary: "**Decisions**\nFollow up".into(),
        };
        let (subject, html, text) = group_email("User", &[group], "https://example.invalid", 9);
        assert!(subject.contains("1 条新消息"));
        assert!(html.contains("<strong>Decisions</strong>"));
        assert!(html.contains("<br />"));
        assert!(html.contains("taskId=42"));
        assert!(text.contains("**Decisions**"));
        assert!(!html.contains("{{"));
    }
}
