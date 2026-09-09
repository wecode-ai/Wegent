"""Public route, authentication and input-boundary regression coverage."""


def test_event_center_api_retains_unconfigured_task(test_client, test_token):
    headers = {"Authorization": f"Bearer {test_token}"}
    response = test_client.post(
        "/api/v1/cloud-projects",
        headers=headers,
        json={"project_key": "EVAPI", "name": "Event API"},
    )
    assert response.status_code == 201
    base = f"/api/v1/cloud-projects/{response.json()['id']}"
    config = test_client.get(f"{base}/event-center", headers=headers)
    assert config.status_code == 200
    assert config.json()["enabled"] is False
    event = test_client.post(
        f"{base}/events",
        headers=headers,
        json={"title": "Process task", "request_id": "api-1"},
    )
    assert event.status_code == 201
    assert event.json()["status"] == "waiting_configuration"
    event_id = event.json()["id"]
    assert (
        test_client.get(f"{base}/events", headers=headers).json()[0]["id"] == event_id
    )
    assert test_client.get(f"{base}/events").status_code == 401
    assert (
        test_client.post(
            f"{base}/events/{event_id}/reply",
            headers=headers,
            json={"content": "Answer", "version": 1},
        ).status_code
        == 409
    )
    assert (
        test_client.get(
            f"{base}/events/{event_id}/context",
            headers={**headers, "X-Event-Execution-Id": "9999"},
        ).status_code
        == 403
    )
    assert (
        test_client.post(
            f"{base}/events",
            headers=headers,
            json={"title": "Too big", "request_id": "large", "content": "界" * 22000},
        ).status_code
        == 413
    )
