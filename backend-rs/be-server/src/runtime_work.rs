// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Bind Socket.IO Runtime calls to the application's transport handles.

use wegent_runtime_work::{RuntimeExecutionProxy, RuntimeRequestServices, RuntimeRpcServices};

use crate::AppState;

pub(crate) fn transport(app: &AppState) -> RuntimeRpcServices<'_> {
    RuntimeRpcServices {
        redis: app.redis.as_ref(),
        socketio_rpc: app.socketio_rpc.as_deref(),
    }
}

pub(crate) fn request_services(app: &AppState) -> RuntimeRequestServices<'_> {
    RuntimeRequestServices {
        auth: &app.auth,
        mysql: &app.mysql,
        transport: transport(app),
        proxy: &AccountProxy,
    }
}

struct AccountProxy;

#[async_trait::async_trait]
impl RuntimeExecutionProxy for AccountProxy {
    async fn execution_proxy_url(
        &self,
        mysql: &brz_mysql::MysqlService,
        user_id: i32,
    ) -> Option<String> {
        crate::users_me_proxy_config::execution_proxy_url(mysql, user_id)
            .await
            .ok()
    }
}

#[test]
fn runtime_work_route_registration_preserves_gateway_ownership() {
    use http::Method;

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml");
    let config = crate::hybrid::load_routes_config(&path).unwrap();
    let table = crate::RouteTable::compile(config.clone()).unwrap();
    let registered = wegent_runtime_work::registered_routes();
    // Method bits: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
    const GET: u16 = 1 << 1;
    const POST: u16 = 1 << 5;
    const PUT: u16 = 1 << 6;
    for (method, bit, path, selected) in [
        (Method::GET, GET, "/api/runtime-work", false),
        (Method::POST, POST, "/api/runtime-work/transcript", false),
        (
            Method::POST,
            POST,
            "/api/runtime-work/transcript/search",
            true,
        ),
        (Method::GET, GET, "/api/runtime-work/im-notifications", true),
        (
            Method::PUT,
            PUT,
            "/api/runtime-work/im-notifications/presence",
            true,
        ),
    ] {
        assert_eq!(
            config.routes.iter().any(|rule| rule.path == path
                && rule
                    .methods
                    .iter()
                    .any(|candidate| candidate == method.as_str())),
            selected,
            "{method} {path}",
        );
        assert_eq!(table.matches(&method, path), selected, "{method} {path}");
        assert_eq!(
            registered
                .iter()
                .filter(|(route, methods)| *route == path && methods & bit != 0)
                .count(),
            1,
            "{method} {path}",
        );
    }
    assert!(!table.matches(&Method::GET, "/api/runtime-work/other"));
    assert!(!table.matches(&Method::GET, "/api/runtime-work/transcript"));
    assert!(!table.matches(&Method::GET, "/api/runtime-work/transcript/search"));
}
