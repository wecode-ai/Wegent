use std::{
    collections::HashMap,
    env, fs,
    io::Write,
    net::TcpListener,
    path::Path,
    sync::{Arc, Barrier, Mutex},
    thread,
    time::{Duration, SystemTime},
};

use super::{
    available_logical_entry, bridge_navigation_url, bridge_request_authorized,
    browser_file_url_from_path, browser_open_action, browser_webview_url,
    consume_approved_agent_risk, directory_entry_modified_unix_seconds, directory_listing_html,
    download_event_owner, file_url_path, format_directory_entry_modified, format_file_size,
    loaded_browser_url, local_file_browser_title, logical_owner_for_native_label,
    merge_request_option, native_webview_label, read_http_request, ready_logical_entry,
    register_agent_approval, register_preview_source, relabel_logical_entry,
    remove_logical_entry_if_native_matches, resolve_agent_bridge_label,
    resolve_browser_navigation_url, script_browser_action, script_resolve_inspect_target,
    script_semantic_inspect, should_block_local_file_preview, should_record_loaded_url,
    should_replay_browser_open_request, update_logical_entry_if_native_matches,
    wait_for_browser_ready_with_observer, DirectoryEntry, EmbeddedBrowserBridgeRequest,
    EmbeddedBrowserDownloadPayload, EmbeddedBrowserOpenAction, EmbeddedBrowserPageState,
    EmbeddedBrowserReadiness, EmbeddedBrowserState, EMBEDDED_BROWSER_BRIDGE_TOKEN_ENV,
    EMBEDDED_BROWSER_NOT_READY_ERROR,
};
use encoding_rs::GB18030;
use serde_json::{json, Value};
use tauri::WebviewUrl;

static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());

fn test_temp_dir(name: &str) -> std::path::PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "wework-embedded-browser-test-{}-{name}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir_all(&directory).expect("test temp directory should be created");
    directory
}

#[test]
fn new_browser_uses_the_requested_url_as_its_initial_navigation() {
    let external_url = tauri::Url::parse("https://example.com/").unwrap();
    let app_url =
        tauri::Url::parse("tauri://localhost/extension-page.html?sessionId=test").unwrap();

    assert!(matches!(
        browser_webview_url(external_url),
        WebviewUrl::External(_)
    ));
    assert!(matches!(
        browser_webview_url(app_url),
        WebviewUrl::CustomProtocol(_)
    ));
}

#[test]
fn placeholder_load_does_not_replace_the_requested_url() {
    assert!(!should_record_loaded_url("about:blank"));
    assert!(should_record_loaded_url("https://example.com/"));
}

#[test]
fn directory_file_url_converts_back_to_path() {
    let root = test_temp_dir("directory-file-url");
    let directory = root.join("reports");
    fs::create_dir_all(&directory).unwrap();
    let url = browser_file_url_from_path(&directory).unwrap();

    assert_eq!(file_url_path(&url).unwrap(), directory);
}

#[test]
fn directory_listing_html_links_files_and_directories() {
    let modified = format_directory_entry_modified(Ok(
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_715_072_504)
    ))
    .unwrap();
    let html = directory_listing_html(
        Path::new("/Users/me/reports"),
        &[
            DirectoryEntry {
                name: "nested/".to_string(),
                url: "file:///Users/me/reports/nested/".to_string(),
                is_directory: true,
                size: None,
                modified: None,
                modified_unix_seconds: None,
            },
            DirectoryEntry {
                name: "a < b.txt".to_string(),
                url: "file:///Users/me/reports/a%20%3C%20b.txt".to_string(),
                is_directory: false,
                size: Some(12),
                modified: Some(modified.clone()),
                modified_unix_seconds: Some(1_715_072_504),
            },
        ],
        false,
    );

    assert!(html.contains("<table id=\"directory-listing\""));
    assert!(html.contains("href=\"file:///Users/me/reports/nested/\""));
    assert!(html.contains("a &lt; b.txt"));
    assert!(html.contains("12 B"));
    assert!(html.contains(&modified));
    assert!(html.contains("data-testid=\"embedded-browser-directory-sort-name\""));
    assert!(html.contains("function sortDirectory(button)"));
    assert!(!html.contains("class=\"entry entry-"));
    assert!(!modified.ends_with('s'));
}

#[test]
fn file_sizes_use_readable_decimal_units() {
    assert_eq!(format_file_size(12), "12 B");
    assert_eq!(format_file_size(1_234), "1.2 kB");
    assert_eq!(format_file_size(12_345_678), "12.3 MB");
    assert_eq!(format_file_size(1_234_567_890), "1.2 GB");
}

#[test]
fn directory_modified_unix_seconds_supports_sorting() {
    assert_eq!(
        directory_entry_modified_unix_seconds(Ok(
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_715_072_504)
        )),
        Some(1_715_072_504)
    );
}

#[test]
fn loaded_directory_preview_url_preserves_requested_directory_url() {
    let state = EmbeddedBrowserState::default();
    register_preview_source(
        &state,
        "file:///tmp/wework-embedded-browser/directory-1.html",
        "file:///Users/me/reports",
    );

    assert_eq!(
        loaded_browser_url(
            &state,
            "file:///tmp/wework-embedded-browser/directory-1.html"
        ),
        Some("file:///Users/me/reports".to_string())
    );
    assert_eq!(loaded_browser_url(&state, "about:blank"), None);
}

#[test]
fn directory_preview_navigation_updates_to_nested_directory_url() {
    let state = EmbeddedBrowserState::default();
    let root = test_temp_dir("nested-directory-preview");
    let nested = root.join("a").join("b");
    fs::create_dir_all(&nested).unwrap();

    let root_url = browser_file_url_from_path(&root).unwrap();
    let root_display = resolve_browser_navigation_url(&state, root_url.as_str()).unwrap();
    assert_eq!(
        loaded_browser_url(&state, root_display.as_str()),
        Some(root_url.to_string())
    );
    assert_eq!(
        local_file_browser_title(&root_url),
        Some(format!("Index of {}", root.display()))
    );

    let nested_url = browser_file_url_from_path(&nested).unwrap();
    let nested_display = resolve_browser_navigation_url(&state, nested_url.as_str()).unwrap();
    assert_ne!(nested_display.as_str(), root_display.as_str());
    assert_eq!(
        loaded_browser_url(&state, nested_display.as_str()),
        Some(nested_url.to_string())
    );
    assert_eq!(
        resolve_browser_navigation_url(&state, nested_display.as_str()).unwrap(),
        nested_display
    );
}

#[test]
fn text_file_urls_use_generated_preview_pages() {
    let state = EmbeddedBrowserState::default();
    let root = test_temp_dir("text-preview");
    let markdown_path = root.join("README.md");
    let html_path = root.join("index.html");
    let plain_text_path = root.join("plain-text");
    let gb18030_path = root.join("chinese.txt");
    let utf16_path = root.join("utf16.txt");
    let binary_path = root.join("archive.zip");
    fs::write(&markdown_path, "# 标题\n").unwrap();
    fs::write(&html_path, "<h1>Rendered HTML</h1>").unwrap();
    fs::write(&plain_text_path, "中文文本\n第二行").unwrap();
    let (gb18030_text, _, _) = GB18030.encode("中文编码");
    fs::write(&gb18030_path, gb18030_text.as_ref()).unwrap();
    fs::write(&utf16_path, [0xFF, 0xFE, 0x2D, 0x4E, 0x87, 0x65]).unwrap();
    fs::write(&binary_path, [0x50, 0x4b, 0x03, 0x04, 0x00]).unwrap();

    let markdown_url = browser_file_url_from_path(&markdown_path).unwrap();
    assert_eq!(
        local_file_browser_title(&markdown_url),
        Some("README.md".to_string())
    );
    let markdown_display = resolve_browser_navigation_url(&state, markdown_url.as_str()).unwrap();
    assert_ne!(markdown_display.as_str(), markdown_url.as_str());
    let markdown_preview = fs::read_to_string(file_url_path(&markdown_display).unwrap()).unwrap();
    assert!(markdown_preview.contains("README.md"));
    assert!(markdown_preview.contains("标题"));
    assert!(!markdown_preview.contains(markdown_url.as_str()));
    assert_eq!(
        loaded_browser_url(&state, markdown_display.as_str()),
        Some(markdown_url.to_string())
    );

    let plain_text_url = browser_file_url_from_path(&plain_text_path).unwrap();
    let plain_text_display =
        resolve_browser_navigation_url(&state, plain_text_url.as_str()).unwrap();
    assert_ne!(plain_text_display.as_str(), plain_text_url.as_str());
    let plain_text_preview =
        fs::read_to_string(file_url_path(&plain_text_display).unwrap()).unwrap();
    assert!(plain_text_preview.contains("plain-text"));
    assert!(plain_text_preview.contains("中文文本"));
    assert_eq!(
        loaded_browser_url(&state, plain_text_display.as_str()),
        Some(plain_text_url.to_string())
    );

    let gb18030_url = browser_file_url_from_path(&gb18030_path).unwrap();
    let gb18030_display = resolve_browser_navigation_url(&state, gb18030_url.as_str()).unwrap();
    let gb18030_preview = fs::read_to_string(file_url_path(&gb18030_display).unwrap()).unwrap();
    assert!(gb18030_preview.contains("中文编码"));

    let utf16_url = browser_file_url_from_path(&utf16_path).unwrap();
    let utf16_display = resolve_browser_navigation_url(&state, utf16_url.as_str()).unwrap();
    let utf16_preview = fs::read_to_string(file_url_path(&utf16_display).unwrap()).unwrap();
    assert!(utf16_preview.contains("中文"));

    let html_url = browser_file_url_from_path(&html_path).unwrap();
    let html_display = resolve_browser_navigation_url(&state, html_url.as_str()).unwrap();
    assert_eq!(html_display, html_url);

    let binary_url = browser_file_url_from_path(&binary_path).unwrap();
    let binary_display = resolve_browser_navigation_url(&state, binary_url.as_str()).unwrap();
    assert_eq!(binary_display.as_str(), binary_url.as_str());
    assert!(should_block_local_file_preview(&binary_url));
    assert!(!should_block_local_file_preview(&html_url));
    assert!(!should_block_local_file_preview(&markdown_url));
}

#[test]
fn bridge_navigation_allows_http_https_and_file() {
    assert!(bridge_navigation_url("https://example.com/").is_ok());
    assert!(bridge_navigation_url("http://example.com/").is_ok());
    assert!(bridge_navigation_url("file:///etc/passwd").is_ok());
    assert!(bridge_navigation_url("file:///Users/me/report.html").is_ok());
    assert!(bridge_navigation_url("javascript:alert(1)").is_err());
    assert!(bridge_navigation_url("data:text/html,<b>x</b>").is_err());
}

#[test]
fn closed_agent_tab_routes_fail_without_retargeting() {
    let state = EmbeddedBrowserState::default();
    {
        let mut webviews = state.webviews.lock().unwrap();
        webviews.insert(
            "workspace-browser-active".to_string(),
            super::EmbeddedBrowserEntry {
                native_label: "native-1".to_string(),
                title: None,
                url: None,
                opened_at_unix_ms: 0,
                phase: super::EmbeddedBrowserPhase::Opening,
            },
        );
    }
    state.active_tabs.lock().unwrap().insert(
        "workspace-browser".to_string(),
        "workspace-browser-active".to_string(),
    );
    {
        let mut agent_tabs = state.agent_tabs.lock().unwrap();
        agent_tabs.insert(
            ("workspace-browser".to_string(), "session-1".to_string()),
            super::AgentTabRoute {
                label: "workspace-browser-active".to_string(),
                last_request_at_unix_ms: 0,
                closed_at_unix_ms: Some(1),
            },
        );
    }

    let error = resolve_agent_bridge_label(&state, "workspace-browser", Some("session-1"))
        .expect_err("closed tab routes should fail");
    assert_eq!(error, "agent tab was closed");
}

#[test]
fn bridge_authorization_requires_the_runtime_token() {
    let _lock = TEST_ENV_LOCK.lock().unwrap();
    let old_token = env::var_os(EMBEDDED_BROWSER_BRIDGE_TOKEN_ENV);
    env::set_var(EMBEDDED_BROWSER_BRIDGE_TOKEN_ENV, "secret-token");

    assert!(bridge_request_authorized("Authorization: Bearer secret-token\r\n").unwrap());
    assert!(!bridge_request_authorized("Authorization: Bearer wrong\r\n").unwrap());
    assert!(!bridge_request_authorized("Host: 127.0.0.1\r\n").unwrap());

    if let Some(old_token) = old_token {
        env::set_var(EMBEDDED_BROWSER_BRIDGE_TOKEN_ENV, old_token);
    } else {
        env::remove_var(EMBEDDED_BROWSER_BRIDGE_TOKEN_ENV);
    }
}

#[test]
fn http_request_reads_body_when_content_length_is_not_the_first_header() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let body = r#"{"action":"status"}"#;
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        read_http_request(&mut stream).unwrap()
    });

    let mut client = std::net::TcpStream::connect(address).unwrap();
    write!(
        client,
        "POST /browser HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        body
    )
    .unwrap();

    let (_headers, parsed_body) = server.join().unwrap();
    assert_eq!(parsed_body, body);
}

#[test]
fn opening_route_is_hidden_from_public_access_but_available_to_native_callbacks() {
    let native_label = native_webview_label("workspace-browser", 41);
    let mut entries = HashMap::from([(
        "workspace-browser".to_string(),
        (
            native_label.clone(),
            EmbeddedBrowserReadiness::Opening,
            None,
        ),
    )]);

    let public_entry = ready_logical_entry(&entries, "workspace-browser", |entry| entry.1);
    assert_eq!(public_entry.unwrap_err(), EMBEDDED_BROWSER_NOT_READY_ERROR);

    let callback_updated = update_logical_entry_if_native_matches(
        &mut entries,
        &native_label,
        |entry| entry.0.as_str(),
        |entry| entry.2 = Some("loaded"),
    );
    assert!(callback_updated);
    assert_eq!(entries["workspace-browser"].2, Some("loaded"));

    entries.get_mut("workspace-browser").unwrap().1 = EmbeddedBrowserReadiness::Ready;
    assert!(ready_logical_entry(&entries, "workspace-browser", |entry| entry.1).is_ok());
}

#[test]
fn hidden_route_exposes_page_state_without_becoming_bridge_ready() {
    let entries = HashMap::from([(
        "workspace-browser".to_string(),
        (
            "https://example.test/",
            EmbeddedBrowserReadiness::Opening,
            true,
        ),
    )]);

    assert_eq!(
        ready_logical_entry(&entries, "workspace-browser", |entry| entry.1).unwrap_err(),
        EMBEDDED_BROWSER_NOT_READY_ERROR
    );
    assert_eq!(
        available_logical_entry(&entries, "workspace-browser", |entry| entry.2)
            .unwrap()
            .0,
        "https://example.test/"
    );
}

#[test]
fn bridge_open_waits_for_an_opening_route_without_requesting_again() {
    assert_eq!(
        browser_open_action(Some(EmbeddedBrowserReadiness::Opening)),
        EmbeddedBrowserOpenAction::WaitForReady
    );
    assert_eq!(
        browser_open_action(None),
        EmbeddedBrowserOpenAction::RequestOpen
    );
    assert_eq!(
        browser_open_action(Some(EmbeddedBrowserReadiness::Ready)),
        EmbeddedBrowserOpenAction::Ready
    );
}

#[test]
fn bridge_replays_pending_open_requests_only_while_no_route_is_registered() {
    assert!(!should_replay_browser_open_request(0, None));
    assert!(!should_replay_browser_open_request(4, None));
    assert!(should_replay_browser_open_request(5, None));
    assert!(should_replay_browser_open_request(10, None));
    assert!(!should_replay_browser_open_request(
        5,
        Some(EmbeddedBrowserReadiness::Opening)
    ));
    assert!(!should_replay_browser_open_request(
        5,
        Some(EmbeddedBrowserReadiness::Ready)
    ));
}

#[test]
fn bridge_waits_for_ready_instead_of_accepting_an_opening_registration() {
    let readiness = Arc::new(Mutex::new(EmbeddedBrowserReadiness::Opening));
    let waiter_readiness = Arc::clone(&readiness);
    let started = Arc::new(Barrier::new(2));
    let waiter_started = Arc::clone(&started);

    let waiter = thread::spawn(move || {
        let mut first_check = true;
        wait_for_browser_ready_with_observer(
            || {
                if first_check {
                    first_check = false;
                    waiter_started.wait();
                }
                Ok(Some(*waiter_readiness.lock().unwrap()))
            },
            100,
            Duration::from_millis(1),
            |_, _| Ok(()),
        )
    });

    started.wait();
    assert!(!waiter.is_finished());
    *readiness.lock().unwrap() = EmbeddedBrowserReadiness::Ready;
    assert_eq!(waiter.join().unwrap(), Ok(()));
}

#[test]
fn native_webview_labels_are_unique_across_creation_sequences() {
    let first = native_webview_label("workspace-browser", 41);
    let second = native_webview_label("workspace-browser", 42);

    assert_ne!(first, second);
}

#[test]
fn page_state_serializes_native_identity() {
    let state = EmbeddedBrowserPageState {
        invalid_tls_certificate: None,
        native_label: "workspace-browser-native-41".to_string(),
        title: Some("Example".to_string()),
        url: Some("https://example.com/".to_string()),
    };

    let serialized = serde_json::to_value(state).unwrap();

    assert_eq!(serialized["nativeLabel"], "workspace-browser-native-41");
}

#[test]
fn bridge_request_deserializes_inspect_options_and_ref_target() {
    let request: EmbeddedBrowserBridgeRequest = serde_json::from_value(json!({
        "action": "resolveRef",
        "inspectId": "wk-inspect-1",
        "index": 4,
        "ref": "wk-mvp:wk-inspect-1:main:4:abcd1234",
        "options": { "maxNodes": 12 }
    }))
    .unwrap();

    assert_eq!(request.action, "resolveRef");
    assert_eq!(request.inspect_id.as_deref(), Some("wk-inspect-1"));
    assert_eq!(request.index, Some(4));
    assert_eq!(
        request.ref_.as_deref(),
        Some("wk-mvp:wk-inspect-1:main:4:abcd1234")
    );
    assert_eq!(request.options.unwrap()["maxNodes"], 12);
}

#[test]
fn inspect_script_embeds_options_as_json_data() {
    let script = script_semantic_inspect(&json!({
        "mode": "compact",
        "maxNodes": 25,
        "label": "quote \" and </script>"
    }))
    .unwrap();

    assert!(script.contains("const rawOptions = {"));
    assert!(script.contains("\"maxNodes\":25"));
    assert!(script.contains("bridgeTrust: 'page_world'"));
    assert!(!script.contains("__WEWORK_INSPECT_OPTIONS__"));
}

#[test]
fn resolve_ref_script_uses_opaque_ref_without_selector_parsing() {
    let script = script_resolve_inspect_target(&EmbeddedBrowserBridgeRequest {
        action: "resolveRef".to_string(),
        url: None,
        expression: None,
        selector: None,
        text: None,
        key: None,
        x: None,
        y: None,
        timeout_ms: None,
        label: None,
        options: None,
        inspect_id: Some("wk-inspect-1".to_string()),
        index: Some(7),
        ref_: Some("wk-mvp:wk-inspect-1:main:7:abcd1234".to_string()),
        browser_session_id: None,
    });

    assert!(script.contains("resolveInspectTarget"));
    assert!(script.contains("\"inspectId\":\"wk-inspect-1\""));
    assert!(script.contains("\"index\":7"));
    assert!(script.contains("\"ref\":\"wk-mvp:wk-inspect-1:main:7:abcd1234\""));
    assert!(!script.contains("document.querySelector"));
}

#[test]
fn browser_action_script_embeds_target_input_as_json_data() {
    let script = script_browser_action(
        "fill",
        &EmbeddedBrowserBridgeRequest {
            action: "fill".to_string(),
            url: None,
            expression: None,
            selector: Some("#name".to_string()),
            text: Some("Alice \" Admin".to_string()),
            key: None,
            x: None,
            y: None,
            timeout_ms: None,
            label: None,
            options: None,
            inspect_id: Some("wk-inspect-1".to_string()),
            index: Some(2),
            ref_: None,
            browser_session_id: None,
        },
    )
    .unwrap();

    assert!(script.contains("const input = {"));
    assert!(script.contains("\"action\":\"fill\""));
    assert!(script.contains("\"selector\":\"#name\""));
    assert!(script.contains("\"text\":\"Alice \\\" Admin\""));
    assert!(script.contains("\"inspectId\":\"wk-inspect-1\""));
    assert!(script.contains("\"index\":2"));
    assert!(!script.contains("__WEWORK_ACTION_INPUT__"));
}

#[test]
fn approval_registration_adds_payload_and_consumes_approved_risk_once() {
    let state = EmbeddedBrowserState::default();
    let mut result = json!({
        "ok": false,
        "approval": {
            "risk": "high",
            "actionKind": "click",
            "reason": "AI wants to click submit.",
            "target": {
                "role": "button",
                "name": "Submit"
            }
        },
        "error": {
            "code": "approval_required",
            "message": "AI wants to click submit."
        }
    });

    let payload = register_agent_approval(
        &state,
        "workspace-browser",
        "click",
        "click:ref:wk-mvp:1",
        &mut result,
    )
    .unwrap()
    .unwrap();

    assert_eq!(payload.risk, "high");
    assert_eq!(payload.action_kind, "click");
    assert_eq!(
        result
            .pointer("/approval/approvalId")
            .and_then(Value::as_str),
        Some(payload.approval_id.as_str())
    );
    assert!(
        !consume_approved_agent_risk(&state, "workspace-browser", "click:ref:wk-mvp:1").unwrap()
    );

    {
        let mut approvals = state.agent_approvals.lock().unwrap();
        approvals
            .get_mut(&payload.approval_id)
            .expect("approval state")
            .approved = true;
    }

    assert!(
        consume_approved_agent_risk(&state, "workspace-browser", "click:ref:wk-mvp:1").unwrap()
    );
    assert!(
        !consume_approved_agent_risk(&state, "workspace-browser", "click:ref:wk-mvp:1").unwrap()
    );
}

#[test]
fn merge_request_option_preserves_existing_object_options() {
    let mut request = EmbeddedBrowserBridgeRequest {
        action: "click".to_string(),
        url: None,
        expression: None,
        selector: None,
        text: None,
        key: None,
        x: None,
        y: None,
        timeout_ms: None,
        label: None,
        options: Some(json!({ "waitAfterMs": 100 })),
        inspect_id: None,
        index: None,
        ref_: Some("wk-mvp:1".to_string()),
        browser_session_id: None,
    };

    merge_request_option(&mut request, "riskApproved", Value::Bool(true));

    let options = request.options.expect("options");
    assert_eq!(options["waitAfterMs"], 100);
    assert_eq!(options["riskApproved"], true);
}

#[test]
fn download_payload_serializes_native_identity() {
    let payload = EmbeddedBrowserDownloadPayload {
        id: "download-1".to_string(),
        label: "workspace-browser-owner".to_string(),
        native_label: "workspace-browser-native-41".to_string(),
        url: "https://example.com/app.dmg".to_string(),
        path: Some("/tmp/app.dmg".to_string()),
        status: "finished".to_string(),
        received_bytes: Some(1024),
        total_bytes: Some(1024),
    };

    let serialized = serde_json::to_value(payload).unwrap();

    assert_eq!(serialized["nativeLabel"], "workspace-browser-native-41");
}

#[test]
fn native_identity_resolves_the_current_owner_after_logical_relabel() {
    let native_label = native_webview_label("workspace-browser", 41);
    let mut owners = HashMap::from([("workspace-browser".to_string(), native_label.clone())]);
    let identity = owners.remove("workspace-browser").unwrap();
    owners.insert("workspace-browser-regression-owner".to_string(), identity);

    let owner = logical_owner_for_native_label(
        owners
            .iter()
            .map(|(logical_label, native_label)| (logical_label.as_str(), native_label.as_str())),
        &native_label,
    );

    assert_eq!(owner.as_deref(), Some("workspace-browser-regression-owner"));
}

#[test]
fn download_event_owner_follows_relabel_and_ignores_reused_logical_label() {
    let original_native = native_webview_label("workspace-browser", 41);
    let replacement_native = native_webview_label("workspace-browser", 42);
    let owners = HashMap::from([
        (
            "workspace-browser-regression-owner".to_string(),
            original_native.clone(),
        ),
        ("workspace-browser".to_string(), replacement_native),
    ]);

    let owner = download_event_owner(
        owners
            .iter()
            .map(|(logical_label, native_label)| (logical_label.as_str(), native_label.as_str())),
        &original_native,
    );

    assert_eq!(owner.as_deref(), Some("workspace-browser-regression-owner"));
}

#[test]
fn conditional_native_removal_preserves_a_replacement_entry() {
    let original_native = native_webview_label("workspace-browser", 41);
    let replacement_native = native_webview_label("workspace-browser", 42);
    let mut owners = HashMap::from([("workspace-browser".to_string(), replacement_native.clone())]);

    let removed = remove_logical_entry_if_native_matches(
        &mut owners,
        "workspace-browser",
        &original_native,
        String::as_str,
    );

    assert_eq!(removed, None);
    assert_eq!(owners.get("workspace-browser"), Some(&replacement_native));
}

#[test]
fn conditional_native_removal_removes_the_matching_entry() {
    let native_label = native_webview_label("workspace-browser", 41);
    let mut owners = HashMap::from([("workspace-browser".to_string(), native_label.clone())]);

    let removed = remove_logical_entry_if_native_matches(
        &mut owners,
        "workspace-browser",
        &native_label,
        String::as_str,
    );

    assert_eq!(removed.as_deref(), Some(native_label.as_str()));
    assert!(!owners.contains_key("workspace-browser"));
}

#[test]
fn native_scoped_update_follows_relabel_without_mutating_reused_logical_label() {
    let original_native = native_webview_label("workspace-browser", 41);
    let replacement_native = native_webview_label("workspace-browser", 42);
    let mut entries = HashMap::from([
        (
            "workspace-browser-task-1".to_string(),
            (original_native.clone(), None),
        ),
        ("workspace-browser".to_string(), (replacement_native, None)),
    ]);

    let updated = update_logical_entry_if_native_matches(
        &mut entries,
        &original_native,
        |entry| entry.0.as_str(),
        |entry| entry.1 = Some("https://openai.com/".to_string()),
    );

    assert!(updated);
    assert_eq!(
        entries["workspace-browser-task-1"].1.as_deref(),
        Some("https://openai.com/")
    );
    assert_eq!(entries["workspace-browser"].1, None);
}

#[test]
fn relabel_rejects_an_occupied_destination_without_orphaning_the_source() {
    let mut entries = HashMap::from([
        ("workspace-browser-source".to_string(), "source-native"),
        ("workspace-browser-target".to_string(), "target-native"),
    ]);

    let result = relabel_logical_entry(
        &mut entries,
        "workspace-browser-source",
        "workspace-browser-target",
    );

    assert_eq!(
        result,
        Err("Embedded browser destination label is already open".to_string())
    );
    assert_eq!(entries["workspace-browser-source"], "source-native");
    assert_eq!(entries["workspace-browser-target"], "target-native");
}
