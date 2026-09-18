//! Shared public state plus resources owned exclusively by internal APIs.
use brz_redis::Redis;
use std::sync::Arc;
use wegent_backend_rs::AppState;

pub struct WecodeAppState<R: Redis> {
    pub app: Arc<AppState>,
    pub tauth_redis: Option<R>,
    pub aigc_quota_endpoint: brz_http::Endpoint,
}

impl<R: Redis> WecodeAppState<R> {
    pub fn public(&self) -> &Arc<AppState> {
        &self.app
    }

    pub fn aigc_quota_endpoint(&self) -> &brz_http::Endpoint {
        &self.aigc_quota_endpoint
    }
}
