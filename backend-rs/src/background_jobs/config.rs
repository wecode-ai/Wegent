//! Shared process switches and an explicit Rust background-job allowlist.

use std::collections::BTreeSet;
use std::time::Duration;

use anyhow::{Result, bail};

/// An empty allowlist keeps Rust jobs disabled regardless of process switches.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackgroundJobsConfig {
    pub scheduler_enabled: bool,
    pub worker_enabled: bool,
    pub job_allowlist: BTreeSet<String>,
    pub shutdown_grace: Duration,
}

impl BackgroundJobsConfig {
    pub fn from_env() -> Result<Self> {
        Self::from_lookup(crate::config::env_or_dotenv)
    }

    fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let scheduler_enabled = boolean(&lookup, "SCHEDULED_TASKS_ENABLED")?;
        let worker_enabled = boolean(&lookup, "EMBEDDED_CELERY_ENABLED")?;
        let job_allowlist = lookup("WEGENT_RS_JOB_ALLOWLIST")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect::<BTreeSet<_>>();
        if job_allowlist.contains("*") {
            bail!("WEGENT_RS_JOB_ALLOWLIST requires explicit job names; '*' is not accepted");
        }
        let seconds = lookup("WEGENT_RS_JOBS_SHUTDOWN_GRACE_SECONDS")
            .map(|value| value.parse::<u64>())
            .transpose()?
            .unwrap_or(30);
        Ok(Self {
            scheduler_enabled,
            worker_enabled,
            job_allowlist,
            shutdown_grace: Duration::from_secs(seconds),
        })
    }

    pub fn allows(&self, name: &str) -> bool {
        self.job_allowlist.contains(name)
    }

    pub fn enabled(&self) -> bool {
        self.scheduler_enabled || self.worker_enabled
    }

    /// Validate even a disabled process so misspelled allowed names fail early.
    pub fn validate_registered<'a>(&self, names: impl IntoIterator<Item = &'a str>) -> Result<()> {
        let registered = names.into_iter().collect::<BTreeSet<_>>();
        for name in &self.job_allowlist {
            if !registered.contains(name.as_str()) {
                bail!("WEGENT_RS_JOB_ALLOWLIST contains an unregistered job: {name}");
            }
        }
        Ok(())
    }
}

fn boolean(lookup: &impl Fn(&str) -> Option<String>, name: &str) -> Result<bool> {
    match lookup(name).as_deref().map(str::trim) {
        None | Some("") => Ok(true),
        Some(value) => match value.to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Ok(true),
            "0" | "false" | "no" | "off" => Ok(false),
            _ => bail!("{name} must be a boolean"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn config(values: &[(&str, &str)]) -> Result<BackgroundJobsConfig> {
        let values = values.iter().copied().collect::<HashMap<_, _>>();
        BackgroundJobsConfig::from_lookup(|name| values.get(name).map(|value| (*value).to_owned()))
    }

    #[test]
    fn shared_switches_default_on_with_no_allowed_rust_jobs() {
        let config = config(&[]).unwrap();
        assert!(config.scheduler_enabled);
        assert!(config.worker_enabled);
        assert!(config.enabled());
        assert!(config.job_allowlist.is_empty());
        assert!(!config.allows("repository_update"));
        assert_eq!(config.shutdown_grace, Duration::from_secs(30));
    }

    #[test]
    fn worker_and_scheduler_are_independent() {
        let worker = config(&[("SCHEDULED_TASKS_ENABLED", "false")]).unwrap();
        assert!(worker.worker_enabled);
        assert!(!worker.scheduler_enabled);
        let scheduler = config(&[("EMBEDDED_CELERY_ENABLED", "false")]).unwrap();
        assert!(scheduler.scheduler_enabled);
        assert!(!scheduler.worker_enabled);
        let disabled = config(&[
            ("SCHEDULED_TASKS_ENABLED", "false"),
            ("EMBEDDED_CELERY_ENABLED", "false"),
        ])
        .unwrap();
        assert!(!disabled.enabled());
    }

    #[test]
    fn retired_rust_switches_are_not_aliases() {
        let config = config(&[
            ("WEGENT_RS_SCHEDULER_ENABLED", "false"),
            ("WEGENT_RS_WORKER_ENABLED", "invalid"),
        ])
        .unwrap();
        assert!(config.scheduler_enabled);
        assert!(config.worker_enabled);
    }

    #[test]
    fn shared_switches_accept_boolean_values_and_blank_defaults() {
        for value in ["1", "true", "YES", " on ", "", " "] {
            let config = config(&[
                ("SCHEDULED_TASKS_ENABLED", value),
                ("EMBEDDED_CELERY_ENABLED", value),
            ])
            .unwrap();
            assert!(config.scheduler_enabled, "value: {value:?}");
            assert!(config.worker_enabled, "value: {value:?}");
        }
        for value in ["0", "false", "NO", " off "] {
            let config = config(&[
                ("SCHEDULED_TASKS_ENABLED", value),
                ("EMBEDDED_CELERY_ENABLED", value),
            ])
            .unwrap();
            assert!(!config.scheduler_enabled, "value: {value:?}");
            assert!(!config.worker_enabled, "value: {value:?}");
        }
    }

    #[test]
    fn allowlist_is_explicit_and_rejects_unknown_handlers() {
        let config = config(&[
            ("SCHEDULED_TASKS_ENABLED", "false"),
            ("EMBEDDED_CELERY_ENABLED", "false"),
            (
                "WEGENT_RS_JOB_ALLOWLIST",
                " repository_update, repository_update ",
            ),
        ])
        .unwrap();
        assert_eq!(config.job_allowlist.len(), 1);
        assert!(config.allows("repository_update"));
        assert!(!config.allows("other"));
        assert!(config.validate_registered(["repository_update"]).is_ok());
        assert!(config.validate_registered(["other"]).is_err());
    }

    #[test]
    fn invalid_boolean_and_wildcard_do_not_silently_enable_work() {
        for name in ["SCHEDULED_TASKS_ENABLED", "EMBEDDED_CELERY_ENABLED"] {
            let error = config(&[(name, "maybe")]).unwrap_err();
            assert!(error.to_string().contains(name));
        }
        assert!(config(&[("WEGENT_RS_JOB_ALLOWLIST", "*")]).is_err());
    }

    #[test]
    fn shutdown_grace_remains_configurable() {
        let configured = config(&[("WEGENT_RS_JOBS_SHUTDOWN_GRACE_SECONDS", "7")]).unwrap();
        assert_eq!(configured.shutdown_grace, Duration::from_secs(7));
        assert!(config(&[("WEGENT_RS_JOBS_SHUTDOWN_GRACE_SECONDS", "invalid")]).is_err());
    }
}
