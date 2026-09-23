//! Shared public state plus resources owned exclusively by internal APIs.
use brz_redis::Redis;
use std::sync::Arc;
use wegent_backend_rs::AppState;

use super::nevis::NevisClient;

pub struct WecodeAppState<R: Redis> {
    pub app: Arc<AppState>,
    pub tauth_redis: Option<R>,
    pub aigc_quota: super::aigc::AigcQuotaService,
    /// The process-lifetime Nevis Sandbox client the cloud-device endpoints
    /// share (`wecode.service.nevis_client.nevis_client`).
    pub nevis_client: NevisClient,
}

impl<R: Redis> WecodeAppState<R> {
    pub fn public(&self) -> &Arc<AppState> {
        &self.app
    }

    pub fn aigc_quota(&self) -> &super::aigc::AigcQuotaService {
        &self.aigc_quota
    }

    pub fn nevis_client(&self) -> &NevisClient {
        &self.nevis_client
    }
}
