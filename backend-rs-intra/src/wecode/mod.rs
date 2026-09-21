use std::sync::Arc;

pub(crate) use startup::SharedWecodeAppState;
pub(crate) use startup::build as build_app_state;

mod aigc;
mod aigc_video_playback;
mod cloud_devices_config;
mod document_download_policy;
mod employee_cache;
mod employee_profiles;
mod employee_sync;
mod entity_resolver;
mod erp;
mod erp_config;
mod erp_provider_impl;
mod external_knowledge;
mod grey;
mod media_policy;
mod media_signing;
#[cfg(test)]
mod mysql_tests;
mod quota;
mod sharding;
mod startup;
mod state;
mod subscription_workspaces;
mod user_cache;
mod user_profile;
mod video_result_urls;

brz_http_server::registry!(
    group = wecode_apis,
    dependencies(wecode: SharedWecodeAppState)
);

pub(crate) fn routes(
    wecode: SharedWecodeAppState,
) -> Result<brz_http_server::Router, brz_http_server::RegistryError> {
    let exact_quota =
        brz_http_server::handlers!(wecode = Arc::clone(&wecode); group = self::wecode_apis)?;
    let other = startup::routes(wecode)?;
    Ok(exact_quota.merge(other))
}

#[cfg(test)]
mod tests {
    use brz_http_server::__private::inventory;
    use http::Method;
    use std::path::Path;

    #[test]
    fn wecode_route_is_registered_once() {
        let paths: Vec<_> = inventory::iter::<super::__http_registry_wecode_apis::Entry>
            .into_iter()
            .flat_map(|entry| (entry.0.routes)().iter().map(|route| route.path))
            .collect();

        assert_eq!(paths, ["/api/quota/claude/quota"]);
    }

    #[test]
    fn private_cutover_keeps_nested_quota_and_other_routes_in_python() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = wegent_backend_rs::HybridConfig::new(
            "127.0.0.1:0".parse().unwrap(),
            "http://127.0.0.1:8004".parse().unwrap(),
            wegent_backend_rs::RouteTable::empty(),
        )
        .with_routes_file(&path)
        .unwrap();
        assert!(config.selects_rust(&Method::GET, "/api/quota"));
        assert!(!config.selects_rust(&Method::GET, "/api/quota/claude/quota"));
        // The four intra cutovers below are not active yet: their `[[routes]]`
        // entries in `config/routes.toml` stay commented out, so Python keeps
        // serving them.
        assert!(!config.selects_rust(&Method::GET, "/api/grey/status"));
        assert!(!config.selects_rust(&Method::GET, "/api/aigc-video/media/playback"));
        assert!(!config.selects_rust(&Method::GET, "/api/cloud-devices/config"));
        assert!(!config.selects_rust(
            &Method::GET,
            "/api/wecode/external-knowledge/provider/knowledge-bases"
        ));
        assert!(!config.selects_rust(&Method::POST, "/api/quota/claude/quota"));
        assert!(!config.selects_rust(&Method::GET, "/api/tasks/42/unmigrated"));
    }
}
