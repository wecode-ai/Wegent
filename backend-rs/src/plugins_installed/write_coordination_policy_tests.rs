// SPDX-License-Identifier: Apache-2.0
//! A stalled policy transaction must preserve the bootstrap fence.
use super::*;
use brz_mysql::{MysqlRouteKey, MysqlRouting, MysqlService};
use std::sync::atomic::{AtomicUsize, Ordering};

struct PolicyMysql {
    calls: AtomicUsize,
    stall_at: usize,
}

#[tokio::test]
async fn policy_bootstrap_retains_the_original_installation_scope() {
    let redis = LeaseRedis::default();
    let mut lease = PluginWriteLease::acquire_names(Some(&redis), 23, vec!["example".into()])
        .await
        .unwrap()
        .for_installations(vec![41]);
    let mut transaction = RevisionTransaction::default();
    lease.ensure_policy_on(&mut transaction).await.unwrap();
    assert_eq!(transaction.inserted_user, Some(23));
    assert_eq!(lease.installation_ids(), Some([41].as_slice()));
    assert!(lease.owns_installation(41));
    assert!(!lease.owns_installation(42));
    let keys = redis
        .owners
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(keys.len(), 2);
    assert!(keys.contains(&"wegent:plugin-write:23:example".to_owned()));
    assert!(keys.contains(&"wegent:plugin-write:23:@account-policy".to_owned()));
    lease.release().await;
    assert!(redis.owners.lock().unwrap().is_empty());
}

impl Mysql for PolicyMysql {
    type Transaction = RevisionTransaction;
    fn with_route<R: MysqlRouting + 'static>(&self, _: R) -> MysqlService {
        unreachable!()
    }
    fn route<K: MysqlRouteKey>(&self, _: K) -> Self {
        unreachable!()
    }
    async fn execute<S: AsRef<str> + Send, A: MysqlArgs + Send>(
        &self,
        _: S,
        _: A,
    ) -> MysqlResult<MysqlExecution> {
        unreachable!()
    }
    async fn fetch_optional<S: AsRef<str> + Send, A: MysqlArgs + Send, T: FromMysqlRow + Send>(
        &self,
        _: S,
        _: A,
    ) -> MysqlResult<Option<T>> {
        unreachable!()
    }
    async fn fetch_one<S: AsRef<str> + Send, A: MysqlArgs + Send, T: FromMysqlRow + Send>(
        &self,
        _: S,
        _: A,
    ) -> MysqlResult<T> {
        unreachable!()
    }
    async fn fetch_all<S: AsRef<str> + Send, A: MysqlArgs + Send, T: FromMysqlRow + Send>(
        &self,
        _: S,
        _: A,
    ) -> MysqlResult<Vec<T>> {
        unreachable!()
    }
    fn fetch<
        'a,
        S: AsRef<str> + Send + 'a,
        A: MysqlArgs + Send + 'a,
        T: FromMysqlRow + Send + 'a,
    >(
        &'a self,
        _: S,
        _: A,
    ) -> impl futures_util::Stream<Item = MysqlResult<T>> + Send + 'a {
        futures_util::stream::empty()
    }
    async fn with_transaction<T, F>(&self, operation: F) -> MysqlResult<T>
    where
        T: Send,
        F: for<'a> AsyncFnOnce(&'a mut Self::Transaction) -> MysqlResult<T> + Send,
    {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let result = operation(&mut RevisionTransaction::default()).await;
        if call == self.stall_at {
            std::future::pending::<()>().await;
        }
        result
    }
}

#[tokio::test(start_paused = true)]
async fn policy_readiness_wait_is_inside_the_operation_deadline() {
    let redis = LeaseRedis::default();
    let lease = PluginWriteLease::acquire_names(Some(&redis), 23, vec!["example".into()])
        .await
        .unwrap();
    let mysql = PolicyMysql {
        calls: AtomicUsize::new(0),
        stall_at: 0,
    };
    let start = tokio::time::Instant::now();
    let error = tokio::time::timeout(
        OPERATION_BUDGET + Duration::from_secs(1),
        lease.ensure_policy(&mysql),
    )
    .await
    .expect("policy readiness must honor its own operation deadline")
    .unwrap_err();
    assert_eq!(plugin_write_error_code(&error), Some("plugin_write_busy"));
    assert_eq!(start.elapsed(), OPERATION_BUDGET);
    assert!(
        !redis
            .owners
            .lock()
            .unwrap()
            .contains_key("wegent:plugin-write:23:@account-policy")
    );
}

#[tokio::test(start_paused = true)]
async fn uncertain_policy_commit_retains_the_bootstrap_lease_until_expiry() {
    let redis = LeaseRedis::default();
    let lease = PluginWriteLease::acquire_names(Some(&redis), 23, vec!["example".into()])
        .await
        .unwrap();
    let mysql = PolicyMysql {
        calls: AtomicUsize::new(0),
        stall_at: 1,
    };
    let start = tokio::time::Instant::now();
    let error = lease.ensure_policy(&mysql).await.unwrap_err();
    assert_eq!(plugin_write_error_code(&error), Some("plugin_write_busy"));
    assert_eq!(start.elapsed(), ACQUIRE_WAIT);
    assert!(
        redis
            .owners
            .lock()
            .unwrap()
            .contains_key("wegent:plugin-write:23:@account-policy")
    );
    let error = PluginWriteLease::acquire(Some(&redis), 23)
        .await
        .err()
        .unwrap();
    assert_eq!(plugin_write_error_code(&error), Some("plugin_write_busy"));
}
