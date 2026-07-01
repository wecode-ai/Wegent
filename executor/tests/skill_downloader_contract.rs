// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    cell::RefCell,
    collections::{BTreeMap, VecDeque},
    time::Duration,
};

use serde_json::{json, Value};
use wegent_executor::services::api_client::{
    SkillApiClient, SkillApiResponse, SkillArchiveExtractor, SkillDownloader,
};

#[derive(Default)]
struct FakeSkillClient {
    calls: RefCell<Vec<String>>,
    responses: RefCell<VecDeque<SkillApiResponse>>,
}

impl FakeSkillClient {
    fn with_responses(responses: Vec<SkillApiResponse>) -> Self {
        Self {
            calls: RefCell::new(Vec::new()),
            responses: RefCell::new(responses.into()),
        }
    }
}

impl SkillApiClient for FakeSkillClient {
    fn get(&self, path: &str, _timeout: Duration) -> Option<SkillApiResponse> {
        self.calls.borrow_mut().push(path.to_owned());
        self.responses.borrow_mut().pop_front()
    }
}

#[derive(Default)]
struct FakeExtractor {
    calls: RefCell<Vec<(String, Vec<u8>)>>,
}

impl SkillArchiveExtractor for FakeExtractor {
    fn extract_skill_zip(&self, skill_name: &str, content: &[u8]) -> bool {
        self.calls
            .borrow_mut()
            .push((skill_name.to_owned(), content.to_vec()));
        true
    }
}

fn response(json_body: Value, content: &[u8]) -> SkillApiResponse {
    SkillApiResponse {
        json: json_body,
        content: content.to_vec(),
    }
}

#[test]
fn download_single_skill_uses_id_path_when_skill_ref_contains_skill_id() {
    let client = FakeSkillClient::with_responses(vec![response(json!({}), b"zip-bytes")]);
    let extractor = FakeExtractor::default();
    let downloader = SkillDownloader::new("default", None, &client, &extractor);
    let mut skill_ref = BTreeMap::new();
    skill_ref.insert("skill_id".to_owned(), json!(123));
    skill_ref.insert("namespace".to_owned(), json!("team-a"));
    skill_ref.insert("is_public".to_owned(), json!(false));

    let result = downloader.download_single_skill("analysis-skill", Some(&skill_ref));

    assert!(result);
    assert_eq!(client.calls.borrow().len(), 1);
    let download_path = &client.calls.borrow()[0];
    assert!(download_path.starts_with("/api/v1/kinds/skills/123/download"));
    assert!(download_path.contains("namespace=team-a"));
    assert_eq!(extractor.calls.borrow()[0].0, "analysis-skill");
    assert_eq!(extractor.calls.borrow()[0].1, b"zip-bytes");
}

#[test]
fn download_single_skill_falls_back_to_name_query_without_skill_id() {
    let client = FakeSkillClient::with_responses(vec![
        response(
            json!({
                "items": [{
                    "metadata": {
                        "labels": {"id": 456},
                        "namespace": "default"
                    }
                }]
            }),
            b"",
        ),
        response(json!({}), b"zip-bytes"),
    ]);
    let extractor = FakeExtractor::default();
    let downloader = SkillDownloader::new("default", None, &client, &extractor);

    let result = downloader.download_single_skill("fallback-skill", None);

    assert!(result);
    let calls = client.calls.borrow();
    assert!(calls[0].starts_with("/api/v1/kinds/skills?name=fallback-skill"));
    assert!(calls[0].contains("namespace=default"));
    assert!(calls[1].starts_with("/api/v1/kinds/skills/456/download"));
    assert_eq!(extractor.calls.borrow()[0].0, "fallback-skill");
}
