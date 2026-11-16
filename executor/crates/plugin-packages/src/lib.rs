//! Capability package publication, discovery, configuration, and activation.
use wegent_filesystem::{directory_link, file_lease};
use wegent_protocol as protocol;
use wegent_runtime_config as config;
use wegent_runtime_logging as logging;
pub mod codex_configuration;
pub mod local;
pub mod services;

/// Native session reload invoked while the package activation lease is held.
pub trait SkillConfigurationReloader: Send + Sync {
    fn reload<'a>(
        &'a self,
        home: &'a std::path::Path,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<usize, String>> + Send + 'a>>;
}

#[cfg(test)]
struct NoRunningSessions;
#[cfg(test)]
impl SkillConfigurationReloader for NoRunningSessions {
    fn reload<'a>(
        &'a self,
        _: &'a std::path::Path,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<usize, String>> + Send + 'a>>
    {
        Box::pin(async { Ok(0) })
    }
}

pub mod skill_selection;
