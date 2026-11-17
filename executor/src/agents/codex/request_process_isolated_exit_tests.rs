// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test(start_paused = true)]
async fn ordinary_source_reads_keep_their_existing_preparation_budget() {
    let fixture = Fixture::new();
    let preparation = fixture.client.state.lock().await;
    let read = fixture
        .client
        .request("thread/read", json!({"threadId":"shared-source"}));
    tokio::pin!(read);
    assert!(futures_util::poll!(read.as_mut()).is_pending());
    tokio::time::advance(Duration::from_secs(codex_rpc_timeout_seconds() + 1)).await;
    tokio::time::resume();
    drop(preparation);
    assert!(read.await.unwrap()["pid"].as_u64().is_some());
    fixture.client.restart().await;
}

#[tokio::test]
async fn an_unadmitted_read_waits_for_release_before_starting_a_shared_process() {
    let fixture = Fixture::new();
    let registry = fixture.client.state.lock().await.isolated_rpc.clone();
    let (owner, requests) = registry.owner();
    owner.bind("source").unwrap();
    drop(requests);
    let read = fixture
        .client
        .request("thread/read", json!({"threadId":"source"}));
    tokio::pin!(read);
    assert!(futures_util::poll!(read.as_mut()).is_pending());
    assert!(fixture.client.state.lock().await.process.is_none());
    assert!(registry.get("source").is_some());
    drop(owner);
    let result = read.await.unwrap();
    assert!(result["pid"].as_u64().is_some());
    fixture.client.restart().await;
}

#[tokio::test]
async fn a_replacement_owner_receives_the_first_dispatch_after_release() {
    let fixture = Fixture::new();
    let registry = fixture.client.state.lock().await.isolated_rpc.clone();
    let (owner, requests) = registry.owner();
    owner.bind("source").unwrap();
    drop(requests);
    let read = fixture
        .client
        .request("thread/read", json!({"threadId":"source"}));
    tokio::pin!(read);
    assert!(futures_util::poll!(read.as_mut()).is_pending());
    let (replacement, mut requests) = registry.owner();
    assert!(replacement.bind("source").is_err());
    drop(owner);
    replacement.bind("source").unwrap();
    assert!(futures_util::poll!(read.as_mut()).is_pending());
    let request = requests.try_recv().unwrap();
    assert_eq!(request.method, "thread/read");
    request
        .reply
        .send(Ok(json!({"owner":"replacement"})))
        .unwrap();
    assert_eq!(read.await.unwrap()["owner"], "replacement");
    assert!(fixture.client.state.lock().await.process.is_none());
    assert!(requests.try_recv().is_err());
}

#[tokio::test]
async fn an_admitted_read_with_a_lost_response_is_never_replayed() {
    let fixture = Fixture::new();
    let registry = fixture.client.state.lock().await.isolated_rpc.clone();
    let (owner, mut requests) = registry.owner();
    owner.bind("source").unwrap();
    let read = fixture
        .client
        .request("thread/read", json!({"threadId":"source"}));
    tokio::pin!(read);
    assert!(futures_util::poll!(read.as_mut()).is_pending());
    drop(requests.try_recv().unwrap());
    drop(requests);
    drop(owner);
    assert!(read.await.unwrap_err().contains("response channel closed"));
    assert!(fixture.client.state.lock().await.process.is_none());
}

#[tokio::test(start_paused = true)]
async fn waiting_for_owner_release_does_not_reset_the_read_deadline() {
    let fixture = Fixture::new();
    let registry = fixture.client.state.lock().await.isolated_rpc.clone();
    let (owner, requests) = registry.owner();
    owner.bind("source").unwrap();
    drop(requests);
    let read = fixture
        .client
        .request("thread/read", json!({"threadId":"source"}));
    tokio::pin!(read);
    assert!(futures_util::poll!(read.as_mut()).is_pending());
    let budget = Duration::from_secs(codex_rpc_timeout_seconds());
    tokio::time::advance(budget / 2).await;
    drop(owner);
    let (replacement, mut requests) = registry.owner();
    replacement.bind("source").unwrap();
    assert!(futures_util::poll!(read.as_mut()).is_pending());
    let admitted = requests.try_recv().unwrap();
    tokio::time::advance(budget - budget / 2).await;
    assert!(read.await.unwrap_err().contains("timed out"));
    assert!(admitted.reply.is_closed());
    assert!(requests.try_recv().is_err());
    assert!(fixture.client.state.lock().await.process.is_none());
}
