//! Compose application-owned credential brokers at each child spawn.
pub use wegent_subprocess::environment::{
    hydrate_process_environment, normalized_process_path, strip_ansi_codes, ShellEnvironmentLoad,
};

pub fn process_env(extra_env: &[(String, String)]) -> std::collections::HashMap<String, String> {
    wegent_subprocess::environment::merge_process_environment(
        std::env::vars()
            .chain(crate::services::git_credentials::environment())
            .chain(extra_env.iter().cloned())
            .chain(crate::plugin_account_auth::broker::environment()),
    )
}

#[derive(Debug)]
pub struct CredentialEnvironment;
impl wegent_claude_harness::ChildEnvironment for CredentialEnvironment {
    fn environment(&self, extra: &[(String, String)]) -> std::collections::HashMap<String, String> {
        process_env(extra)
    }
}
