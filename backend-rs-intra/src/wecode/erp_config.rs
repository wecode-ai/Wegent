//! ERP endpoint and credentials, resolved only by the private application.
use std::env;
#[derive(Debug, Clone)]
pub struct AppConfig {
    pub erp_opensearch_base_url: String,
    pub erp_client_id: String,
    pub erp_client_secret: String,
}
impl AppConfig {
    pub fn from_env() -> Self {
        Self {
            erp_opensearch_base_url: env::var("ERP_OPENSEARCH_BASE_URL")
                .unwrap_or_default()
                .trim()
                .trim_end_matches('/')
                .to_string(),
            erp_client_id: env::var("ERP_CLIENT_ID").unwrap_or_default(),
            erp_client_secret: env_var_case_insensitive("ERP_CLIENT_secret").unwrap_or_default(),
        }
    }
}
fn env_var_case_insensitive(name: &str) -> Option<String> {
    match_env_var_case_insensitive(name, env::vars())
}

fn match_env_var_case_insensitive(
    name: &str,
    entries: impl IntoIterator<Item = (String, String)>,
) -> Option<String> {
    let entries: Vec<_> = entries.into_iter().collect();
    entries
        .iter()
        .find(|(key, _)| key == name)
        .or_else(|| {
            entries
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
        })
        .map(|(_, value)| value.clone())
}

#[cfg(test)]
mod tests {
    use super::match_env_var_case_insensitive;

    #[test]
    fn env_lookup_prefers_exact_name_then_matches_case_variants() {
        let name = "WEGENT_TEST_CASE_INSENSITIVE_LOOKUP";
        let lower = name.to_ascii_lowercase();
        assert_eq!(match_env_var_case_insensitive(name, []), None);
        assert_eq!(
            match_env_var_case_insensitive(name, [(lower.clone(), "value-lower".into())]),
            Some("value-lower".into())
        );
        assert_eq!(
            match_env_var_case_insensitive(
                name,
                [
                    (lower, "value-lower".into()),
                    (name.into(), "value-exact".into())
                ],
            ),
            Some("value-exact".into())
        );
    }
}
