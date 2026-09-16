use std::sync::Arc;

pub(crate) use state::WecodeAppState;

mod aigc;
mod quota;
mod state;

pub(crate) type SharedWecodeAppState = Arc<WecodeAppState>;

brz_http_server::registry!(
    group = wecode_apis,
    dependencies(wecode: SharedWecodeAppState)
);

pub(crate) fn routes(
    wecode: SharedWecodeAppState,
) -> Result<brz_http_server::Router, brz_http_server::RegistryError> {
    brz_http_server::handlers!(wecode = wecode; group = self::wecode_apis)
}

#[cfg(test)]
mod tests {
    use brz_http_server::__private::inventory;

    #[test]
    fn wecode_route_is_registered_once() {
        let paths: Vec<_> = inventory::iter::<super::__http_registry_wecode_apis::Entry>
            .into_iter()
            .flat_map(|entry| (entry.0.routes)().iter().map(|route| route.path))
            .collect();

        assert_eq!(paths, ["/api/quota/claude/quota"]);
    }
}
