use super::*;

#[test]
fn standard_empty_current_catalog_does_not_restore_historical_tools() {
    let body = json!({"tools":[],"input":[
        {"type":"additional_tools","tools":[{"type":"custom","name":"revoked"}]},
        {"role":"user","content":"Continue"}
    ]});
    let (standard, _) = responses_to_responses(&body, true, false, false).unwrap();
    assert_eq!(standard["tools"], json!([]));
    assert_eq!(
        standard["input"],
        json!([{"role":"user","content":"Continue"}])
    );
}
