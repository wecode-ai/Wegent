//! Short, one-attempt lease admission for negotiated Native HTTP writes.

use super::*;
use std::future::Future;
use tokio::sync::{Semaphore, SemaphorePermit, oneshot};
use tracing::Instrument;

// Every acquisition must have room for cleanup before it sends anything to Redis.
static PENDING_ADMISSION_CLEANUPS: Semaphore = Semaphore::const_new(64);
const PENDING_SET_BUDGET: Duration = Duration::from_secs(5);
const PROVISIONAL_LEASE_MS: u64 = 1_000;
const PROMOTABLE_AGE_MS: u64 = 200;
pub(crate) const NATIVE_LEASE_PROMOTION_SCRIPT: &str = r"
if redis.call('GET', KEYS[1]) ~= ARGV[1]
    or redis.call('PTTL', KEYS[1]) < tonumber(ARGV[2]) then
    return 0
end
return redis.call('PEXPIRE', KEYS[1], ARGV[3])
";

pub(crate) async fn complete_native_write<T, F>(
    operation: impl FnOnce(oneshot::Sender<()>) -> F,
) -> Result<T, tokio::task::JoinError>
where
    T: Send + 'static,
    F: Future<Output = T> + Send + 'static,
{
    // Either stop before the transaction or keep ownership of it through cleanup.
    let (liveness, response) = oneshot::channel();
    let result = tokio::spawn(operation(liveness).in_current_span()).await;
    drop(response);
    result
}

pub(crate) enum NativeAdmissionError {
    Occupied,
    Deadline,
    Cancelled,
    RedisUnavailable,
    RedisReplyUnknown,
    RedisReplyLate,
    RedisPromotionNotConfirmed,
    RedisPromotionUnavailable,
    CleanupCapacityExhausted,
    Mysql(MysqlError),
    LegacyAcquire(MysqlError),
    Verify(MysqlError),
    Policy(MysqlError),
    PolicyTimedOut,
}

#[derive(Clone, Copy)]
pub(crate) struct NativeWriteAdmission<'a> {
    pub deadline: Instant,
    pub is_cancelled: &'a (dyn Fn() -> bool + Sync),
}

impl NativeWriteAdmission<'_> {
    fn check(self) -> Result<(), NativeAdmissionError> {
        self.check_cancelled()?;
        if Instant::now() >= self.deadline {
            return Err(NativeAdmissionError::Deadline);
        }
        Ok(())
    }

    pub(crate) fn check_cancelled(self) -> Result<(), NativeAdmissionError> {
        if (self.is_cancelled)() {
            return Err(NativeAdmissionError::Cancelled);
        }
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct NativeAdmissionTiming {
    pub installation_scope_mysql_ms: Option<u64>,
    pub plugin_acquire_redis_ms: Option<u64>,
    pub policy_lookup_mysql_ms: Option<u64>,
    pub policy_acquire_redis_ms: Option<u64>,
    pub policy_verify_redis_ms: Option<u64>,
    pub policy_initialize_mixed_ms: Option<u64>,
    pub unlock_redis_ms: Option<u64>,
}

impl<'a, R: Redis + Clone + 'static> PluginWriteLease<'a, R> {
    pub(crate) async fn acquire_native_installed<M: Mysql>(
        mysql: &M,
        redis: Option<&'a R>,
        user_id: i64,
        ids: &[i64],
        admission: Option<NativeWriteAdmission<'_>>,
        timing: &mut NativeAdmissionTiming,
    ) -> Result<Self, NativeAdmissionError> {
        let (mut names, ids) = measure(
            &mut timing.installation_scope_mysql_ms,
            admission_query(
                admission.map(|admission| admission.deadline),
                mysql.with_transaction(async |tx| {
                    scoped::installation_scope(tx, user_id, Some(ids)).await
                }),
            ),
        )
        .await?;
        let Some(admission) = admission else {
            return measure(
                &mut timing.plugin_acquire_redis_ms,
                Self::acquire_names(redis, user_id, names),
            )
            .await
            .map(|lease| lease.for_installations(ids))
            .map_err(NativeAdmissionError::LegacyAcquire);
        };
        let redis = redis.ok_or(NativeAdmissionError::RedisUnavailable)?;
        scoped::normalize_names(&mut names);
        let started = Instant::now();
        let mut acquired: Option<Self> = None;
        for name in names {
            let attempt = match admission.check() {
                Ok(()) => {
                    Self::acquire_native_named(redis, user_id, name, admission.deadline).await
                }
                Err(error) => Err(error),
            };
            timing.plugin_acquire_redis_ms = Some(started.elapsed().as_millis() as u64);
            match attempt {
                Ok(lease) => {
                    if let Some(group) = &mut acquired {
                        group.include(lease);
                    } else {
                        acquired = Some(lease);
                    }
                }
                Err(error) => {
                    if let Some(group) = acquired {
                        measure(&mut timing.unlock_redis_ms, group.release()).await;
                    }
                    return Err(error);
                }
            }
        }
        Ok(acquired
            .expect("normalized lease scope")
            .for_installations(ids))
    }

    pub(crate) async fn ensure_native_policy<M: Mysql>(
        &self,
        mysql: &M,
        admission: NativeWriteAdmission<'_>,
        timing: &mut NativeAdmissionTiming,
    ) -> Result<(), NativeAdmissionError> {
        admission.check()?;
        let bootstrap = if self.name != "@account-policy" {
            let ready = measure(
                &mut timing.policy_lookup_mysql_ms,
                admission_query(
                    Some(admission.deadline),
                    mysql.with_transaction(async |tx| {
                        Ok(load_policy(tx, self.user_id)
                            .await?
                            .is_some_and(|row| row.is_active == Some(true)))
                    }),
                ),
            )
            .await?;
            admission.check()?;
            if ready {
                return self
                    .verify_native_policy_leases(admission, timing, None)
                    .await;
            }
            Some(
                measure(
                    &mut timing.policy_acquire_redis_ms,
                    Self::acquire_native_named(
                        self.redis,
                        self.user_id,
                        "@account-policy".to_owned(),
                        admission.deadline,
                    ),
                )
                .await?,
            )
        } else {
            None
        };
        self.create_native_policy(mysql, admission, timing, bootstrap)
            .await
    }

    async fn verify_native_policy_leases(
        &self,
        admission: NativeWriteAdmission<'_>,
        timing: &mut NativeAdmissionTiming,
        bootstrap: Option<&Self>,
    ) -> Result<(), NativeAdmissionError> {
        admission.check()?;
        measure(
            &mut timing.policy_verify_redis_ms,
            tokio::time::timeout_at(admission.deadline, self.verify_policy_leases(bootstrap)),
        )
        .await
        .map_err(|_| NativeAdmissionError::Deadline)?
        .map_err(NativeAdmissionError::Verify)?;
        admission.check()
    }

    async fn create_native_policy<M: Mysql>(
        &self,
        mysql: &M,
        admission: NativeWriteAdmission<'_>,
        timing: &mut NativeAdmissionTiming,
        bootstrap: Option<Self>,
    ) -> Result<(), NativeAdmissionError> {
        if let Err(error) = self
            .verify_native_policy_leases(admission, timing, bootstrap.as_ref())
            .await
        {
            if let Some(lease) = bootstrap {
                measure(&mut timing.unlock_redis_ms, lease.release()).await;
            }
            return Err(error);
        }

        // Once the MySQL transaction starts, a timed-out commit can still complete.
        let transaction_deadline = (Instant::now() + ACQUIRE_WAIT).min(self.deadline);
        let result = measure(
            &mut timing.policy_initialize_mixed_ms,
            tokio::time::timeout_at(transaction_deadline, self.initialize_policy_row(mysql)),
        )
        .await
        .map_err(|_| NativeAdmissionError::PolicyTimedOut)?;
        if matches!(&result, Ok(_) | Err(MysqlError::InvalidQuery { .. }))
            && let Some(lease) = bootstrap
        {
            measure(&mut timing.unlock_redis_ms, lease.release()).await;
        }
        result.map_err(NativeAdmissionError::Policy)
    }

    pub(super) async fn acquire_native_named(
        redis: &'a R,
        user_id: i64,
        name: String,
        deadline: Instant,
    ) -> Result<Self, NativeAdmissionError> {
        Self::acquire_native_named_with_cleanup_slots(
            redis,
            user_id,
            name,
            deadline,
            &PENDING_ADMISSION_CLEANUPS,
        )
        .await
    }

    pub(super) async fn acquire_native_named_with_cleanup_slots(
        redis: &'a R,
        user_id: i64,
        name: String,
        deadline: Instant,
        cleanup_slots: &'static Semaphore,
    ) -> Result<Self, NativeAdmissionError> {
        if Instant::now() >= deadline {
            return Err(NativeAdmissionError::Deadline);
        }
        let permit = cleanup_slots
            .try_acquire()
            .map_err(|_| NativeAdmissionError::CleanupCapacityExhausted)?;
        let key = format!("wegent:plugin-write:{user_id}:{name}");
        let mut random = [0_u8; 16];
        getrandom::getrandom(&mut random).map_err(|_| NativeAdmissionError::RedisUnavailable)?;
        let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let lease = Self {
            redis,
            key,
            token,
            user_id,
            name,
            additional: Vec::new(),
            installations: None,
            verify_timing: None,
            deadline: Instant::now() + OPERATION_BUDGET,
        };
        let attempt = R::clone(redis);
        let key = lease.key.clone();
        let token = lease.token.clone();
        let mut pending = Box::pin(async move {
            attempt
                .set_with(
                    key,
                    token,
                    SetOptions::default()
                        .if_absent()
                        .with_expiration(SetExpiration::Milliseconds(PROVISIONAL_LEASE_MS)),
                )
                .await
        });
        match tokio::time::timeout_at(deadline, &mut pending).await {
            Ok(Ok(true)) => lease.promote_native_set(deadline, permit).await,
            Ok(Ok(false)) => Err(NativeAdmissionError::Occupied),
            Ok(Err(_)) => Err(NativeAdmissionError::RedisUnavailable),
            Err(_) => {
                let redis = R::clone(redis);
                let key = lease.key;
                let token = lease.token;
                tokio::spawn(async move {
                    let _permit = permit;
                    if matches!(
                        tokio::time::timeout(PENDING_SET_BUDGET, pending).await,
                        Ok(Ok(true))
                    ) {
                        PluginWriteLease::<'static, R>::release_key(&redis, user_id, &key, &token)
                            .await;
                    }
                });
                Err(NativeAdmissionError::RedisReplyUnknown)
            }
        }
    }

    async fn promote_native_set(
        self,
        deadline: Instant,
        permit: SemaphorePermit<'static>,
    ) -> Result<Self, NativeAdmissionError> {
        let failure = if Instant::now() >= deadline {
            NativeAdmissionError::RedisReplyLate
        } else {
            // Redis can execute an abandoned command later. A stale provisional key
            // must never gain the transaction TTL, even if its token still matches.
            let promotion = self.redis.eval::<_, _, _, i64>(
                NATIVE_LEASE_PROMOTION_SCRIPT,
                [self.key.as_str()],
                (
                    self.token.as_str(),
                    PROVISIONAL_LEASE_MS - PROMOTABLE_AGE_MS,
                    LEASE_SECONDS * 1_000,
                ),
            );
            match tokio::time::timeout_at(deadline, promotion).await {
                Ok(Ok(1)) if Instant::now() < deadline => return Ok(self),
                Ok(Err(_)) => NativeAdmissionError::RedisPromotionUnavailable,
                Ok(Ok(_)) | Err(_) => NativeAdmissionError::RedisPromotionNotConfirmed,
            }
        };
        let redis = R::clone(self.redis);
        let Self {
            user_id,
            key,
            token,
            ..
        } = self;
        tokio::spawn(async move {
            let _permit = permit;
            // If cleanup reaches Redis before a pending promotion, the token
            // check also prevents that promotion from restoring the lease.
            PluginWriteLease::<'static, R>::release_key(&redis, user_id, &key, &token).await;
        });
        Err(failure)
    }
}

async fn admission_query<T>(
    deadline: Option<Instant>,
    query: impl Future<Output = MysqlResult<T>>,
) -> Result<T, NativeAdmissionError> {
    let Some(deadline) = deadline else {
        return query.await.map_err(NativeAdmissionError::Mysql);
    };
    if Instant::now() >= deadline {
        return Err(NativeAdmissionError::Deadline);
    }
    tokio::time::timeout_at(deadline, query)
        .await
        .map_err(|_| NativeAdmissionError::Deadline)?
        .map_err(NativeAdmissionError::Mysql)
}

async fn measure<T>(elapsed: &mut Option<u64>, work: impl Future<Output = T>) -> T {
    let started = Instant::now();
    let result = work.await;
    *elapsed = Some(started.elapsed().as_millis() as u64);
    result
}
