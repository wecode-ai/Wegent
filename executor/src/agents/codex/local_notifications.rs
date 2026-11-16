// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// Local transport diagnostics join the same ordered owner mailbox as native events.
/// The existing weak proxy subscription does not retain this source after its turn.
pub(super) struct LocalNotificationSource {
    pub(super) sender: CodexNotificationSender,
}

enum RuntimeNotificationTarget {
    Hub(CodexNotificationHub),
    SharedClient(CodexAppServerClient),
}

impl LocalNotificationSource {
    pub(super) fn new(
        runtime: Option<CodexNotificationHub>,
        observer: Option<CodexNotificationSender>,
    ) -> Self {
        Self::with_runtime(runtime.map(RuntimeNotificationTarget::Hub), observer)
    }

    pub(super) fn for_shared_client(
        client: CodexAppServerClient,
        observer: Option<CodexNotificationSender>,
    ) -> Self {
        Self::with_runtime(
            Some(RuntimeNotificationTarget::SharedClient(client)),
            observer,
        )
    }

    fn with_runtime(
        runtime: Option<RuntimeNotificationTarget>,
        observer: Option<CodexNotificationSender>,
    ) -> Self {
        let (sender, mut receiver) = mpsc::unbounded_channel::<CodexNotification>();
        tokio::spawn(async move {
            while let Some(message) = receiver.recv().await {
                match runtime.as_ref() {
                    Some(RuntimeNotificationTarget::SharedClient(client)) => {
                        let _ = client.publish_runtime_notification(message.clone()).await;
                    }
                    Some(RuntimeNotificationTarget::Hub(hub)) => {
                        hub.send_runtime(message.clone()).await;
                    }
                    None => {}
                }
                if let Some(observer) = observer.as_ref() {
                    let _ = observer.send(message);
                }
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

    #[tokio::test]
    async fn shared_local_diagnostics_follow_the_replacement_process_generation() {
        let mut client = CodexAppServerClient::new("local-notification-restart");
        client.state = Arc::new(Mutex::new(CodexAppServerSharedState::default()));
        let runtime = Arc::clone(&client.state.lock().await.runtime_notifications);
        let thread_activity_changed = Arc::new(tokio::sync::Notify::new());
        let first = CodexNotificationHub::for_runtime(
            Arc::clone(&runtime),
            Arc::clone(&thread_activity_changed),
        );
        let mut receiver = first.subscribe_runtime();
        let mut child = super::super::tests::spawn_idle_app_server_child();
        let stdin = child.stdin.take().unwrap();
        client.state.lock().await.process = Some(CodexAppServerProcess {
            child,
            stdin: Arc::new(Mutex::new(stdin)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            notifications: first.clone(),
            reader_task: tokio::spawn(std::future::pending()),
        });
        let source = LocalNotificationSource::for_shared_client(client.clone(), None);
        for hub in [
            first,
            CodexNotificationHub::for_runtime(runtime, thread_activity_changed),
        ] {
            client
                .state
                .lock()
                .await
                .process
                .as_mut()
                .unwrap()
                .notifications = hub.clone();
            source
                .sender
                .send(json!({"method": "runtime/modelRetry"}).into())
                .unwrap();
            let message = timeout(Duration::from_secs(1), receiver.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(message.process_generation(), hub.process_generation);
        }
        client.restart().await;
    }
}
