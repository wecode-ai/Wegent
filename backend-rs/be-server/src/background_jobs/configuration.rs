//! Native jobs enabled independently of migrated Python job families.
use super::{BackgroundJobsClient, config::BackgroundJobsConfig};

pub(crate) fn client_from_env() -> anyhow::Result<BackgroundJobsClient> {
    let configuration = BackgroundJobsConfig::from_env()?;
    let explicit_allowlist =
        wegent_backend_config::env_or_dotenv("WEGENT_RS_JOB_ALLOWLIST").is_some();
    Ok(BackgroundJobsClient::new(application_defaults(
        configuration,
        explicit_allowlist,
    )))
}

fn application_defaults(
    mut configuration: BackgroundJobsConfig,
    explicit_allowlist: bool,
) -> BackgroundJobsConfig {
    if !explicit_allowlist {
        configuration
            .job_allowlist
            .insert(super::device::RETENTION_JOB.to_owned());
        configuration.job_allowlist.extend([
            super::robot::managed_jobs::SCAN.to_owned(),
            super::robot::managed_jobs::EXECUTE.to_owned(),
        ]);
    }
    configuration
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeSet, time::Duration};
    fn configuration() -> BackgroundJobsConfig {
        BackgroundJobsConfig {
            scheduler_enabled: true,
            worker_enabled: true,
            job_allowlist: BTreeSet::new(),
            shutdown_grace: Duration::from_secs(30),
        }
    }
    #[test]
    fn enables_native_jobs_by_default_and_preserves_explicit_deployment_controls() {
        assert_eq!(
            application_defaults(configuration(), false).job_allowlist,
            [
                super::super::device::RETENTION_JOB.to_owned(),
                super::super::robot::managed_jobs::SCAN.to_owned(),
                super::super::robot::managed_jobs::EXECUTE.to_owned(),
            ]
            .into()
        );
        assert!(
            application_defaults(configuration(), true)
                .job_allowlist
                .is_empty()
        );
        let mut explicit = configuration();
        explicit
            .job_allowlist
            .insert("device_heartbeat_monitor".to_owned());
        assert_eq!(
            application_defaults(explicit.clone(), true).job_allowlist,
            explicit.job_allowlist
        );
        explicit.scheduler_enabled = false;
        explicit.worker_enabled = false;
        assert!(!application_defaults(explicit, false).enabled());
    }
}
