// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// Native emits thread/closed before removing its pending-unload entry.
/// Only its explicit pre-execution rejection permits resubmitting a resume.
pub(super) async fn with_thread_resume_barrier<F, Fut>(
    method: &str,
    params: &Value,
    timeout_seconds: u64,
    mut request: F,
) -> Result<Value, String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    let Some(thread_id) = params["threadId"]
        .as_str()
        .filter(|_| method == "thread/resume")
    else {
        return request().await;
    };
    let closing =
        format!("thread {thread_id} is closing; retry thread/resume after the thread is closed");
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds);
    with_rpc_timeout("thread/resume admission", timeout_seconds, async {
        let mut observed_closing = false;
        loop {
            if Instant::now() >= deadline {
                return Err(format!(
                    "codex app-server thread/resume admission timed out after {timeout_seconds}s"
                ));
            }
            let result = request().await;
            if result.as_ref().err() != Some(&closing) {
                return result;
            }
            if !observed_closing {
                log_executor_event(
                    "codex thread resume waiting for native teardown",
                    &[("thread_id", thread_id.to_owned())],
                );
                observed_closing = true;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test(start_paused = true)]
    async fn an_unfinished_native_unload_keeps_the_original_rpc_deadline() {
        let attempts = AtomicUsize::new(0);
        let error =
            with_thread_resume_barrier("thread/resume", &json!({"threadId":"thread-1"}), 1, || {
                attempts.fetch_add(1, Ordering::SeqCst);
                std::future::ready(Err(
                    "thread thread-1 is closing; retry thread/resume after the thread is closed"
                        .into(),
                ))
            })
            .await
            .unwrap_err();
        assert_eq!(
            error,
            "codex app-server thread/resume admission timed out after 1s"
        );
        assert!(attempts.load(Ordering::SeqCst) > 1);
        assert!(attempts.load(Ordering::SeqCst) <= 40);
    }

    #[tokio::test]
    async fn other_errors_and_operations_are_never_replayed() {
        for (method, params, error) in [
            (
                "thread/resume",
                json!({"threadId":"thread-1"}),
                "permission denied",
            ),
            (
                "thread/resume",
                json!({"threadId":"thread-2"}),
                "thread thread-1 is closing; retry thread/resume after the thread is closed",
            ),
            (
                "turn/start",
                json!({"threadId":"thread-1"}),
                "thread thread-1 is closing; retry thread/resume after the thread is closed",
            ),
        ] {
            let attempts = AtomicUsize::new(0);
            let result = with_thread_resume_barrier(method, &params, 1, || {
                attempts.fetch_add(1, Ordering::SeqCst);
                std::future::ready(Err(error.to_owned()))
            })
            .await;
            assert_eq!(result, Err(error.to_owned()));
            assert_eq!(attempts.load(Ordering::SeqCst), 1);
        }
    }
}
