from app.services.execution import TaskRequestBuilder


def test_project_plugin_ids_are_collected_from_all_bot_capabilities() -> None:
    plugin_ids = TaskRequestBuilder._project_plugin_ids(
        [
            {
                "plugins": [
                    {"id": "quality-gate@team-market"},
                    {"id": "shared-tool@official"},
                ]
            },
            {
                "plugins": [
                    {"id": "shared-tool@official"},
                    {"id": "  review-helper@personal  "},
                    {"displayName": "Missing id"},
                ]
            },
        ]
    )

    assert plugin_ids == [
        "quality-gate@team-market",
        "review-helper@personal",
        "shared-tool@official",
    ]
