use super::*;
use serde_json::json;

fn response() -> Value {
    json!({"featuredPluginIds": ["remote-id"], "marketplaceLoadErrors": [], "marketplaces": [{
        "name": "openai-curated-remote", "path": null, "plugins": [{
            "id": "tool@openai-curated-remote", "remotePluginId": "remote-id", "name": "tool",
            "source": {"type": "remote"}, "installed": true, "enabled": false,
            "installPolicy": "NOT_AVAILABLE", "installPolicySource": "WORKSPACE_SETTING",
            "authPolicy": "ON_INSTALL", "availability": "DISABLED_BY_ADMIN",
            "disabledReason": "disabled_by_admin", "eligiblePlanTypes": ["business"],
            "mustShowInstallationInterstitial": true, "version": "2.0", "localVersion": "1.0",
            "interface": {"displayName": "Tool", "shortDescription": "Summary", "logoUrl": "https://example.test/icon.png",
                "longDescription": "private-marketing-content".repeat(10000),
                "screenshotUrls": [format!("data:image/png;base64,{}", "A".repeat(100000))],
                "logoDark": format!("data:image/png;base64,{}", "B".repeat(100000))},
            "unexpected-detail": "not-a-list-field"
        }]
    }]})
}

#[test]
fn list_projection_keeps_installation_permission_and_identity_fields() {
    let raw = response();
    let summary = summarize_plugin_catalog(raw.clone());
    let actual = &summary["marketplaces"][0]["plugins"][0];
    let expected = &raw["marketplaces"][0]["plugins"][0];
    for field in SUMMARY_FIELDS.iter().filter(|field| **field != "interface") {
        assert_eq!(
            actual[*field], expected[*field],
            "lost policy or identity field: {field}"
        );
    }
    assert_eq!(summary["featuredPluginIds"], raw["featuredPluginIds"]);
    assert_eq!(
        summary["marketplaceLoadErrors"],
        raw["marketplaceLoadErrors"]
    );
    assert_eq!(actual["interface"]["shortDescription"], "Summary");
    assert_eq!(
        actual["interface"]["logoUrl"],
        "https://example.test/icon.png"
    );
    assert!(actual["interface"].get("longDescription").is_none());
    assert!(actual["interface"].get("screenshotUrls").is_none());
    assert!(actual["interface"]["logoDark"].is_null());
    assert!(actual.get("unexpected-detail").is_none());
    assert!(json_bytes(&summary) < json_bytes(&raw) / 100);
}

#[test]
fn diagnostics_count_bytes_without_including_content_or_untrusted_keys() {
    let mut raw = response();
    raw["marketplaces"][0]["plugins"][0]["interface"]["secret-in-key"] = json!("secret-value");
    let (count, fields) = measure_fields(&raw);
    assert_eq!(count, 1);
    assert_eq!(
        fields["interface.longDescription"],
        json_bytes(&raw["marketplaces"][0]["plugins"][0]["interface"]["longDescription"])
    );
    assert_eq!(json_bytes(&raw), serde_json::to_vec(&raw).unwrap().len());
    let serialized = serde_json::to_string(&fields).unwrap();
    for secret in [
        "secret-in-key",
        "secret-value",
        "private-marketing-content",
        "example.test",
    ] {
        assert!(!serialized.contains(secret));
    }
}

#[test]
fn summary_falls_back_to_a_bounded_description_and_preserves_invalid_responses() {
    let raw = json!({"marketplaces": [{"plugins": [{"interface": {"longDescription": "中文".repeat(500)}}]}]});
    let summary = summarize_plugin_catalog(raw);
    assert_eq!(
        summary["marketplaces"][0]["plugins"][0]["interface"]["shortDescription"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        240
    );
    for invalid in [json!({}), Value::Null, json!({"marketplaces": null})] {
        assert_eq!(summarize_plugin_catalog(invalid.clone()), invalid);
    }
}
