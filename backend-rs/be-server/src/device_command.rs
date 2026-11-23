// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0
#[test]
fn commands_and_upgrade_stay_on_python_with_registered_rust_handlers() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml");
    let config = crate::hybrid::load_routes_config(&path).unwrap();
    let table = crate::RouteTable::compile(config.clone()).unwrap();
    let registered = wegent_devices::registered_routes();
    // Method bits: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const POST: u16 = 1 << 5;
    for endpoint in ["commands", "upgrade"] {
        let path = format!("/api/devices/:device_id/{endpoint}");
        assert!(
            !config
                .routes
                .iter()
                .any(|rule| rule.path == path && rule.methods.iter().any(|method| method == "POST")),
            "POST {path} must remain on Python until cutover"
        );
        let concrete = format!("/api/devices/abc/{endpoint}");
        assert!(!table.matches(&http::Method::POST, &concrete));
        assert!(!table.matches(&http::Method::GET, &concrete));
        assert!(
            registered
                .iter()
                .any(|(route, methods)| *route == path && methods & POST != 0),
            "POST {path} must be registered by the device router"
        );
    }
}
