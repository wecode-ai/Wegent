// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// Local transport diagnostics join the same ordered owner mailbox as native events.
/// The existing weak proxy subscription does not retain this source after its turn.
pub(super) struct LocalNotificationSource {
    pub(super) sender: CodexNotificationSender,
}

impl LocalNotificationSource {
    pub(super) fn new(
        runtime: Option<CodexNotificationHub>,
        observer: Option<CodexNotificationSender>,
    ) -> Self {
        let (sender, mut receiver) = mpsc::unbounded_channel::<CodexNotification>();
        tokio::spawn(async move {
            while let Some(message) = receiver.recv().await {
                publish(runtime.as_ref(), observer.as_ref(), message).await;
            }
        });
        Self { sender }
    }
}

pub(super) async fn publish(
    runtime: Option<&CodexNotificationHub>,
    observer: Option<&CodexNotificationSender>,
    message: impl Into<CodexNotification>,
) {
    let message = message.into();
    if let Some(runtime) = runtime {
        runtime.send_runtime(message.clone()).await;
    }
    if let Some(observer) = observer {
        let _ = observer.send(message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_diagnostics_reach_the_native_owner_in_order_without_an_observer() {
        let hub = CodexNotificationHub::new();
        let mut receiver = hub.subscribe_runtime();
        let source = LocalNotificationSource::new(Some(hub.clone()), None);
        for waiting in [true, false] {
            source
                .sender
                .send(
                    json!({"method": "runtime/modelRetry", "params": {
                        "threadId": "root", "waitId": "wait-1", "waiting": waiting,
                    }})
                    .into(),
                )
                .unwrap();
        }
        drop(source);
        for waiting in [true, false] {
            let message = timeout(Duration::from_secs(1), receiver.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(message["params"]["waiting"], waiting);
            assert_eq!(message.process_generation(), hub.process_generation);
        }
    }
}
