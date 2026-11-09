use super::*;

#[test]
fn an_explicit_connector_slug_must_match_the_declared_local_identity() {
    let manifest = json!({"name":"plugin", "connectors":[{
        "slug":"declared-local", "localAuth":{
            "kind":"browser_oauth", "health":["health"], "start":["login"],
            "tool":{"id":"cli","source":"bundled"}
        }
    }]});
    let declared = parse_local_auth_spec(&manifest, Some("declared-local")).unwrap();
    assert_eq!(declared.connector_slug, "declared-local");
    assert_eq!(declared.health, vec!["health"]);
    assert_eq!(declared.start, vec!["login"]);
    let error = match parse_local_auth_spec(&manifest, Some("plugin")) {
        Ok(_) => panic!("A plugin name cannot replace its declared connector slug"),
        Err(error) => error,
    };
    assert_eq!(error.code, "local_auth_missing");
}
