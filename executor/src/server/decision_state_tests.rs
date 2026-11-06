//! Verify application request states retain one backend HTTP connection pool.
use super::*;
use axum::extract::FromRef;
use local_decision_proxy::DecisionProxyState;

#[derive(Clone)]
struct NoopRunner;

impl crate::server::TaskRunner for NoopRunner {
    type SubmitFuture = std::future::Ready<crate::server::RunnerResult>;

    fn submit(&self, _: crate::protocol::ExecutionRequest) -> Self::SubmitFuture {
        std::future::ready(crate::server::RunnerResult {
            status: crate::protocol::TaskStatus::Failed,
            message: None,
        })
    }
}

#[test]
fn every_request_reuses_the_backend_http_pool() {
    let state = crate::server::AppState::new(NoopRunner);
    let first: DecisionProxyState = FromRef::from_ref(&state);
    let second: DecisionProxyState = FromRef::from_ref(&state);
    assert!(Arc::ptr_eq(first.runtime(), second.runtime()));
}
