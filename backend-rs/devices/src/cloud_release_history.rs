const HISTORY_ENV: &str = "CLOUD_DEVICE_RELEASE_HISTORY";

type StableVersion = (u64, u64, u64);

#[derive(Clone, Debug, Default)]
pub(crate) struct CloudReleaseHistory(Vec<StableVersion>);

#[derive(serde::Serialize)]
pub(crate) struct CloudUpgradeReminder {
    pub target_version: String,
    pub versions_behind: usize,
}

impl CloudReleaseHistory {
    pub(crate) fn from_env() -> Self {
        let Some(value) = crate::config::optional_env_or_dotenv(HISTORY_ENV) else {
            return Self::default();
        };
        Self::parse(&value).unwrap_or_else(|| {
            tracing::warn!(
                setting = HISTORY_ENV,
                "Invalid cloud release history; reminders disabled"
            );
            Self::default()
        })
    }

    fn parse(value: &str) -> Option<Self> {
        let versions = value
            .split(',')
            .map(|version| stable_version(version.trim()))
            .collect::<Option<Vec<_>>>()?;
        if !versions.windows(2).all(|pair| pair[0] < pair[1]) {
            return None;
        }
        Some(Self(versions))
    }

    pub(crate) fn reminder(&self, current: &str) -> Option<CloudUpgradeReminder> {
        let index = self.0.binary_search(&stable_version(current)?).ok()?;
        let versions_behind = self.0.len() - 1 - index;
        if versions_behind < 3 {
            return None;
        }
        let (major, minor, patch) = self.0.last()?;
        Some(CloudUpgradeReminder {
            target_version: format!("{major}.{minor}.{patch}"),
            versions_behind,
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
    use super::CloudReleaseHistory;

    #[test]
    fn measures_distinct_releases_instead_of_numeric_version_gaps() {
        let history = CloudReleaseHistory::parse("1.9.3, v1.9.7, 2.0.0, 2.0.4").unwrap();
        let reminder = history.reminder("v1.9.3").unwrap();
        assert_eq!(reminder.target_version, "2.0.4");
        assert_eq!(reminder.versions_behind, 3);
        for version in ["1.9.7", "2.0.4", "0.9.0", "1.9.3-preview", "3.0.0"] {
            assert!(history.reminder(version).is_none(), "{version}");
        }
    }

    #[test]
    fn rejects_ambiguous_or_unordered_release_histories() {
        for catalog in ["1.0.0,v1.0.0,1.0.2", "1.0.2,1.0.0", "1.0.0,1.0.2-dev", ""] {
            assert!(CloudReleaseHistory::parse(catalog).is_none(), "{catalog}");
        }
    }
}
