// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#[test]
fn decision_routes_are_selected_and_registered_in_the_application() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml");
    let table = crate::RouteTable::compile(crate::load_routes_config(&path).unwrap()).unwrap();
    for method in [http::Method::GET, http::Method::POST] {
        assert!(table.matches(&method, "/api/models/decisions"));
    }
    // Inspect emitted registrations from the collection used by Application.
    let methods: Vec<_> = wegent_model_decisions::registered_routes()
        .into_iter()
        .filter_map(|(path, methods)| (path == "/api/models/decisions").then_some(methods))
        .collect();
    assert_eq!(methods.len(), 2);
    assert_eq!(
        methods.into_iter().fold(0, |all, method| all | method),
        2 | 32
    );
}
