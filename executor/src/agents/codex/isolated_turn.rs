// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl CodexAppServerClient {
    /// An isolated writer must exclude cold prediction resumes in the same Home.
    /// Keep admission until the child exits and releases its native writer lock.
    pub(super) async fn admit_isolated_thread(
        &self,
        thread_id: &str,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>, String> {
        let gate = self.thread_lifecycle_gate(thread_id).await;
        let admission = gate.lock_owned().await;
        let state = self.state.lock().await;
        if state.active_threads_snapshot().contains_key(thread_id) {
            return Err("Cannot start an isolated writer while the thread is running".into());
        }
        let loaded_process = state.process.is_some();
        drop(state);
        if loaded_process {
            self.release_thread_subscription_under_admission(thread_id, true)
                .await?;
        }
        Ok(admission)
    }
}
