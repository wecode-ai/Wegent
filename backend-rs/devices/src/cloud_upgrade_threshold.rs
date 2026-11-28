const THRESHOLD_ENV: &str = "CLOUD_DEVICE_UPGRADE_THRESHOLD";

type StableVersion = (u64, u64, u64);

#[derive(Clone, Debug, Default)]
pub(crate) struct CloudUpgradeThreshold(Option<StableVersion>);

#[derive(serde::Serialize)]
pub(crate) struct CloudUpgradeReminder {
    pub target_version: String,
}

impl CloudUpgradeThreshold {
    pub(crate) fn from_env() -> Self {
        let Some(value) = crate::config::optional_env_or_dotenv(THRESHOLD_ENV) else {
            return Self::default();
        };
        Self::parse(&value).unwrap_or_else(|| {
            tracing::warn!(
                setting = THRESHOLD_ENV,
                "Invalid cloud upgrade threshold; reminders disabled"
            );
            Self::default()
        })
    }

    fn parse(value: &str) -> Option<Self> {
        Some(Self(Some(stable_version(value.trim())?)))
    }

    pub(crate) fn reminder(&self, current: &str, published: &str) -> Option<CloudUpgradeReminder> {
        let threshold = self.0?;
        let current = stable_version(current)?;
        let target = stable_version(published)?;
        if current > threshold || current >= target {
            return None;
        }
        let (major, minor, patch) = target;
        Some(CloudUpgradeReminder {
            target_version: format!("{major}.{minor}.{patch}"),
        })
    }
}

fn stable_version(version: &str) -> Option<StableVersion> {
    fn number(part: &str) -> Option<u64> {
        if (part.len() > 1 && part.starts_with('0'))
            || !part.bytes().all(|byte| byte.is_ascii_digit())
        {
            return None;
        }
        part.parse().ok()
    }
    let mut parts = version.strip_prefix('v').unwrap_or(version).split('.');
    let version = (
        number(parts.next()?)?,
        number(parts.next()?)?,
        number(parts.next()?)?,
    );
    parts.next().is_none().then_some(version)
}

#[cfg(test)]
mod tests {
    use super::CloudUpgradeThreshold;

    #[test]
    fn reminds_below_and_at_the_threshold_when_a_new_release_is_available() {
        let threshold = CloudUpgradeThreshold::parse(" v2.0.4 ").unwrap();
        for current in ["1.9.3", "2.0.3", "v2.0.4"] {
            let reminder = threshold.reminder(current, "v2.0.10").unwrap();
            assert_eq!(reminder.target_version, "2.0.10");
        }
        for current in ["2.0.5", "2.0.10", "2.0.4-preview", ""] {
            assert!(threshold.reminder(current, "2.0.10").is_none(), "{current}");
        }
        for published in ["2.0.4", "2.0.3", "2.0.10-dev", ""] {
            assert!(
                threshold.reminder("2.0.4", published).is_none(),
                "{published}"
            );
        }
    }

    #[test]
    fn requires_one_stable_threshold() {
        for value in ["2.0.1,2.0.4", "2.0.4-dev", "2.0", ""] {
            assert!(CloudUpgradeThreshold::parse(value).is_none(), "{value}");
        }
        assert!(
            CloudUpgradeThreshold::default()
                .reminder("2.0.4", "2.0.10")
                .is_none()
        );
    }
}
