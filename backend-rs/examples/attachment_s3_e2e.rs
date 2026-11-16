// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Assemble the real attachment API with its S3 storage implementation.
//! The standard public entrypoint retains its MySQL storage contract. This
//! application uses the same extension point as deployment-owned backends,
//! without replacing HTTP handlers, authentication, MySQL or the object store.
use std::sync::Arc;

use wegent_backend_rs::{
    Application, BoxError, HybridConfig, MinioConfig, S3StorageBackend, build_app_state, run_hybrid,
};

fn main() -> Result<(), BoxError> {
    wegent_backend_rs::config::init_env();
    let logs = brz_logs::init_default()?;
    let runtime = tokio::runtime::Runtime::new()?;
    let result: Result<(), BoxError> = runtime.block_on(async {
        let mut state = build_app_state().await?;
        let config = MinioConfig::from_env()
            .ok_or_else(|| std::io::Error::other("S3 endpoint and credentials are required"))?;
        state.attachment_upload =
            Arc::new(S3StorageBackend::new(state.attachment_http.clone(), config));
        let application = Application::build(Arc::new(state)).await?;
        run_hybrid(HybridConfig::from_env()?, application).await
    });
    logs.flush()?;
    result
}
