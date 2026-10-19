use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};

struct Directory(PathBuf);

impl Directory {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "default-resource-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn write(&self, name: &str, body: &str) {
        std::fs::write(self.0.join(name), body).unwrap();
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn missing_new_user_directory_has_no_resources() {
    let root = Directory::new();
    assert!(load_resources(&root.0.join("new_user")).unwrap().is_empty());
}

#[test]
fn batch_loader_keeps_yaml_then_yml_order_and_document_order() {
    let root = Directory::new();
    root.write(
        "z.yaml",
        "kind: Shell\nmetadata: {name: z}\n---\nkind: Shell\nmetadata: {name: second}\n",
    );
    root.write("a.yml", "kind: Shell\nmetadata: {name: yml}\n");
    root.write(
        "a.yaml",
        "kind: Shell\nmetadata: {name: first}\n---\nnull\n---\ninvalid: document\n",
    );
    let docs = load_resources(&root.0).unwrap();
    let names: Vec<_> = docs
        .iter()
        .map(|r| r["metadata"]["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["first", "z", "second", "yml"]);
}

#[test]
fn malformed_later_document_discards_the_entire_file_only() {
    let root = Directory::new();
    root.write(
        "a.yaml",
        "kind: Shell\nmetadata: {name: discarded}\n---\n[malformed\n",
    );
    root.write("b.yaml", "kind: Shell\nmetadata: {name: retained}\n");
    let docs = load_resources(&root.0).unwrap();
    assert_eq!(docs.len(), 1);
    assert_eq!(docs[0]["metadata"]["name"], "retained");
}

#[test]
fn schemas_validate_references_before_persistence() {
    let valid = json!({"metadata":{"name":"bot"},"spec":{"ghostRef":{"name":"ghost"},"shellRef":{"name":"shell"}}});
    assert!(schema::validate("Bot", &valid).is_ok());
    let mut invalid = valid.clone();
    invalid["spec"]["ghostRef"]["name"] = json!(1);
    assert!(schema::validate("Bot", &invalid).is_err());
    let mut fixed = valid;
    fixed["spec"]["execution_policy"] = json!({"mode":"fixed"});
    assert!(schema::validate("Bot", &fixed).is_err());
    fixed["spec"]["execution_policy"]["environment_id"] = json!("7");
    assert!(schema::validate("Bot", &fixed).is_ok());
    fixed["spec"]["execution_policy"]["unexpected"] = json!(true);
    assert!(schema::validate("Bot", &fixed).is_err());
}

#[test]
fn quick_phrase_validation_counts_trimmed_nonempty_phrases() {
    let mut team = json!({"metadata":{"name":"agent"},"spec":{"members":[],"collaborationModel":"solo","quick_phrases":[" "," hello "]}});
    assert!(schema::validate("Team", &team).is_ok());
    team["spec"]["quick_phrases"] = json!(["a", "b", "c", "d", "e", "f", "g"]);
    assert!(schema::validate("Team", &team).is_err());
}

#[test]
fn extraction_preserves_declared_status_and_masked_keys() {
    let mut resource =
        json!({"spec":{"modelConfig":{"env":{"api_key":"***"}}},"status":{"state":"Unavailable"}});
    extract("Model", &mut resource).unwrap();
    assert_eq!(resource["status"]["state"], "Unavailable");
    assert_eq!(resource["spec"]["modelConfig"]["env"]["api_key"], "***");
    resource["status"] = Value::Null;
    extract("Model", &mut resource).unwrap();
    assert_eq!(resource["status"]["state"], "Available");
}
