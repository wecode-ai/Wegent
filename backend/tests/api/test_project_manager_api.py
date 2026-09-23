"""Project AI manager API keeps configuration scoped to its project."""

from app.models.delivery import CloudProject


def test_project_manager_configuration_round_trip(
    test_client, test_db, test_user, test_token
) -> None:
    project = CloudProject(
        project_key="MANAGERAPI",
        name="Manager API project",
        created_by_user_id=test_user.id,
        storage_prefix="projects/manager-api",
    )
    test_db.add(project)
    test_db.commit()
    headers = {"Authorization": f"Bearer {test_token}"}

    initial = test_client.get(
        f"/api/v1/cloud-projects/{project.id}/project-manager", headers=headers
    )
    assert initial.status_code == 200
    assert initial.json()["enabled"] is False

    saved = test_client.put(
        f"/api/v1/cloud-projects/{project.id}/project-manager",
        headers=headers,
        json={
            "version": initial.json()["version"],
            "enabled": False,
            "agentId": "",
            "prompt": "Coordinate Issues",
            "triggers": [],
        },
    )
    assert saved.status_code == 200
    assert saved.json()["prompt"] == "Coordinate Issues"
    assert saved.json()["version"] == initial.json()["version"] + 1
