use super::*;

#[test]
fn accepts_dws_success_envelopes_with_empty_error_objects() {
    assert!(!dws_response_failed(&json!({
        "success": true, "status": "success", "error": {}, "data": {"records": []}
    })));
    assert!(dws_response_failed(&json!({
        "success": false, "status": "error", "error": {"message": "permission denied"}
    })));
}
