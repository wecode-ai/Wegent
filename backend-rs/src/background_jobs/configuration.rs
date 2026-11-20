//! Native jobs enabled independently of migrated Python job families.
use super::{BackgroundJobsClient, config::BackgroundJobsConfig};

pub(crate) fn client_from_env() -> anyhow::Result<BackgroundJobsClient> {
    let configuration = BackgroundJobsConfig::from_env()?;
    let explicit_allowlist =
        wegent_backend_config::env_or_dotenv("WEGENT_RS_JOB_ALLOWLIST").is_some();
    let web_enabled = super::knowledge::index::enabled("WEB_AUTO_UPDATE_SCHEDULE_ENABLED", false);
    let configuration = application_defaults(configuration, explicit_allowlist, web_enabled);
    if web_enabled && configuration.enabled() && explicit_allowlist {
        for job in [
            super::knowledge::sync::WEB_SCAN,
            super::knowledge::ORPHAN_CLEANUP,
            super::knowledge::STALE_SCAN,
        ] {
            anyhow::ensure!(
                configuration.allows(job),
                "WEB_AUTO_UPDATE_SCHEDULE_ENABLED requires {job} in WEGENT_RS_JOB_ALLOWLIST"
            );
        }
    }
    Ok(BackgroundJobsClient::new(configuration))
}

fn application_defaults(
    mut configuration: BackgroundJobsConfig,
    explicit_allowlist: bool,
    web_enabled: bool,
) -> BackgroundJobsConfig {
    if !explicit_allowlist {
        configuration
            .job_allowlist
            .insert(super::device::RETENTION_JOB.to_owned());
        configuration.job_allowlist.extend([
            super::robot::managed_jobs::SCAN.to_owned(),
            super::robot::managed_jobs::EXECUTE.to_owned(),
        ]);
        if web_enabled {
            configuration.job_allowlist.extend([
                super::knowledge::sync::WEB_SCAN.to_owned(),
                super::knowledge::ORPHAN_CLEANUP.to_owned(),
                super::knowledge::STALE_SCAN.to_owned(),
            ]);
        }
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
            application_defaults(configuration(), false, false).job_allowlist,
            [
                super::super::device::RETENTION_JOB.to_owned(),
                super::super::robot::managed_jobs::SCAN.to_owned(),
                super::super::robot::managed_jobs::EXECUTE.to_owned(),
            ]
            .into()
        );
        assert!(
            application_defaults(configuration(), true, false)
                .job_allowlist
                .is_empty()
        );
        let mut explicit = configuration();
        explicit
            .job_allowlist
            .insert("device_heartbeat_monitor".to_owned());
        assert_eq!(
            application_defaults(explicit.clone(), true, true).job_allowlist,
            explicit.job_allowlist
        );
        explicit.scheduler_enabled = false;
        explicit.worker_enabled = false;
        assert!(!application_defaults(explicit, false, true).enabled());
    }

    #[test]
    fn web_opt_in_enables_scan_and_existing_recovery_jobs_only() {
        let enabled = application_defaults(configuration(), false, true);
        for job in [
            super::super::knowledge::sync::WEB_SCAN,
            super::super::knowledge::ORPHAN_CLEANUP,
            super::super::knowledge::STALE_SCAN,
        ] {
            assert!(enabled.allows(job));
        }
        assert!(!enabled.allows(super::super::knowledge::sync::WEB_REFRESH));
    }

    #[test]
    fn explicit_web_configuration_validates_dependencies_at_startup() {
        if let Ok(case) = std::env::var("WEB_CONFIGURATION_TEST_CASE") {
            let result = client_from_env();
            if case == "missing" {
                assert!(result.err().unwrap().to_string().contains("requires"));
            } else {
                assert_eq!(
                    result
                        .unwrap()
                        .is_enabled(super::super::knowledge::sync::WEB_SCAN),
                    case == "enabled"
                );
            }
            return;
        }
        let required = [
            super::super::knowledge::sync::WEB_SCAN,
            super::super::knowledge::STALE_SCAN,
            super::super::knowledge::ORPHAN_CLEANUP,
        ]
        .join(",");
        for case in ["disabled", "missing", "enabled"] {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "background_jobs::configuration::tests::explicit_web_configuration_validates_dependencies_at_startup", "--nocapture"])
                .env("WEB_CONFIGURATION_TEST_CASE", case)
                .env("WEGENT_BACKEND_RS_ENV_FILE", "/nonexistent-web-config-test.env")
                .env("SCHEDULED_TASKS_ENABLED", "true")
                .env("EMBEDDED_CELERY_ENABLED", "true")
                .env("WEB_AUTO_UPDATE_SCHEDULE_ENABLED", if case == "disabled" { "false" } else { "true" })
                .env("WEGENT_RS_JOB_ALLOWLIST", if case == "enabled" { &required } else { "device_heartbeat_monitor" })
                .output().unwrap();
            assert!(
                output.status.success(),
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
}
