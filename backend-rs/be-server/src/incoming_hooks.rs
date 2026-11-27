// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

#[cfg(test)]
mod tests {
    #[test]
    fn registered_route_keeps_python_ownership() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml");
        let table = crate::RouteTable::compile(crate::load_routes_config(&path).unwrap()).unwrap();
        assert!(!table.matches(&http::Method::POST, "/api/v1/incoming-hooks/token-value"));
        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const POST: u16 = 1 << 5;
        let registered = wegent_project_scheduler::registered_routes()
            .into_iter()
            .any(|(path, methods)| path == "/api/v1/incoming-hooks/:token" && methods & POST != 0);
        assert!(
            registered,
            "POST /api/v1/incoming-hooks/:token must be registered"
        );
    }
}
