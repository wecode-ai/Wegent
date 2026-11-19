// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl CodexAppServerClient {
    /// Coordinates participating isolated turns and prediction preparation per named Home.
    pub(super) async fn admit_named_home_writer(
        &self,
        cancellation: Option<&mut oneshot::Receiver<()>>,
    ) -> Result<Option<tokio::sync::OwnedMutexGuard<()>>, ()> {
        if !self.has_dedicated_home() {
            return Ok(None);
        }
        let gate = Arc::clone(&self.state.lock().await.named_home_writer_admission);
        let admission = gate.lock_owned();
        let writer = match cancellation {
            Some(cancellation) => tokio::select! {
                biased;
                _ = cancellation => return Err(()),
                writer = admission => writer,
            },
            None => admission.await,
        };
        Ok(Some(writer))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named_request() -> ExecutionRequest {
        serde_json::from_value(json!({
            "user_name":"synthetic", "team_namespace":"default", "team_name":"writer-owner",
            "team_id":12, "bot":[{"id":31,"shell_type":"Codex"}]
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn canonical_request_home_serializes_only_its_own_writer() {
        let _environment = LaunchEnvironment::new();
        let client = CodexAppServerClient::new("unused-named-home-writer-scope");
        let mut request = named_request();
        let first = client.for_request(&request).unwrap();
        let same_home = client.for_request(&request).unwrap();
        request
            .extra
            .insert("team_name".into(), json!("other-writer"));
        let other_home = client.for_request(&request).unwrap();
        assert!(Arc::ptr_eq(&first.state, &same_home.state));
        assert!(!Arc::ptr_eq(&first.state, &other_home.state));
        let owner = first.admit_named_home_writer(None).await.unwrap();
        let waiting = same_home.admit_named_home_writer(None);
        tokio::pin!(waiting);
        assert!(futures_util::poll!(&mut waiting).is_pending());
        let other = other_home.admit_named_home_writer(None);
        tokio::pin!(other);
        assert!(matches!(
            futures_util::poll!(&mut other),
            std::task::Poll::Ready(Ok(Some(_)))
        ));
        drop(owner);
        assert!(waiting.await.unwrap().is_some());
    }

    #[tokio::test]
    async fn default_home_does_not_acquire_named_home_writer_admission() {
        let client = CodexAppServerClient::new("unused-default-home-writer-scope");
        let gate = Arc::clone(&client.state.lock().await.named_home_writer_admission);
        let _owner = gate.lock_owned().await;
        let admission = client.admit_named_home_writer(None);
        tokio::pin!(admission);
        assert!(matches!(
            futures_util::poll!(&mut admission),
            std::task::Poll::Ready(Ok(None))
        ));
    }

    #[tokio::test]
    async fn cancelled_admission_preserves_the_current_home_owner() {
        let _environment = LaunchEnvironment::new();
        let client = CodexAppServerClient::new("unused-cancelled-home-writer")
            .for_request(&named_request())
            .unwrap();
        let owner = client.admit_named_home_writer(None).await.unwrap();
        let (cancel, mut receiver) = oneshot::channel();
        let waiting = client.admit_named_home_writer(Some(&mut receiver));
        tokio::pin!(waiting);
        assert!(futures_util::poll!(&mut waiting).is_pending());
        cancel.send(()).unwrap();
        assert_eq!(waiting.await.err(), Some(()));
        let next = client.admit_named_home_writer(None);
        tokio::pin!(next);
        assert!(futures_util::poll!(&mut next).is_pending());
        drop(owner);
        assert!(next.await.unwrap().is_some());
    }

    #[tokio::test]
    async fn dropped_or_failed_owner_releases_its_home_writer() {
        let _environment = LaunchEnvironment::new();
        let client = CodexAppServerClient::new("unused-dropped-home-writer")
            .for_request(&named_request())
            .unwrap();
        let mut owner = Box::pin(async {
            let _writer = client.admit_named_home_writer(None).await.unwrap();
            std::future::pending::<()>().await;
        });
        assert!(futures_util::poll!(&mut owner).is_pending());
        let next = client.admit_named_home_writer(None);
        tokio::pin!(next);
        assert!(futures_util::poll!(&mut next).is_pending());
        drop(owner);
        let result: Result<(), &str> = async {
            let _writer = next.await.unwrap();
            Err("original operation error")
        }
        .await;
        assert_eq!(result, Err("original operation error"));
        assert!(client
            .admit_named_home_writer(None)
            .await
            .unwrap()
            .is_some());
    }
}
