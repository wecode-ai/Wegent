// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Bind channel streaming to deployment credentials and HTTP trust.

use std::sync::OnceLock;

use brz_mysql::MysqlService;
use serde_json::Value;
use wegent_channel_streaming::TelegramTransport;
use wegent_channel_streaming::dingtalk_card::{
    CARD_REQUEST_TIMEOUT, CONNECT_TIMEOUT, CardAccessToken, CardAuthorization, CardCredentials,
    DingTalkCardTransport,
};

use crate::background_jobs::project::notifications::{
    active_dingtalk_channel_config, dingtalk_access_token, dingtalk_credentials, telegram_message,
};

#[cfg(test)]
pub(crate) use wegent_channel_streaming::dingtalk_card::CardRef;
pub(crate) use wegent_channel_streaming::dingtalk_card::CardStream;

pub(crate) struct ChannelCredentials<'a>(pub &'a MysqlService);

impl CardAuthorization for ChannelCredentials<'_> {
    async fn active_credentials(&self, channel_id: i64) -> Result<CardCredentials, String> {
        let config = active_dingtalk_channel_config(self.0, channel_id)
            .await
            .map_err(|error| format!("DingTalk channel {channel_id}: {error}"))?;
        let (client_id, client_secret) = dingtalk_credentials(&config)
            .ok_or_else(|| format!("DingTalk channel {channel_id}: missing channel credentials"))?;
        Ok(CardCredentials {
            client_id: client_id.to_owned(),
            client_secret: client_secret.to_owned(),
        })
    }

    async fn exchange_token(
        &self,
        http: &brz_http::Client,
        credentials: &CardCredentials,
    ) -> Result<CardAccessToken, String> {
        let access =
            dingtalk_access_token(http, &credentials.client_id, &credentials.client_secret)
                .await
                .map_err(|error| error.to_string())?;
        Ok(CardAccessToken {
            token: access.token,
            expires_in: access.expires_in,
        })
    }
}

impl TelegramTransport for ChannelCredentials<'_> {
    async fn send_or_edit(
        &self,
        channel: i64,
        chat: i64,
        message_id: Option<i64>,
        content: &str,
    ) -> anyhow::Result<Value> {
        telegram_message(self.0, channel, chat, message_id, content).await
    }
}

pub(crate) fn from_process(mysql: &MysqlService) -> DingTalkCardTransport<ChannelCredentials<'_>> {
    DingTalkCardTransport::new(ChannelCredentials(mysql), http_client())
}

/// The process-lifetime card HTTP client. The deployment trust anchor joins the
/// built-in roots so an intercepted HTTPS endpoint validates.
fn http_client() -> Option<brz_http::Client> {
    static CLIENT: OnceLock<Option<brz_http::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            let builder = brz_http::Client::builder()
                .timeout(CARD_REQUEST_TIMEOUT)
                .connect_timeout(CONNECT_TIMEOUT)
                .read_timeout(CARD_REQUEST_TIMEOUT)
                .configure(|inner| match crate::http_trust::trust_anchor() {
                    Some(anchor) => inner.add_root_certificate(anchor),
                    None => inner,
                });
            match builder.build() {
                Ok(client) => Some(client),
                Err(error) => {
                    tracing::error!(%error, "failed to build the DingTalk card HTTP client");
                    None
                }
            }
        })
        .clone()
}
