from app.services.execution.schedule_helper import _extract_device_id_from_executor_name


def test_extract_device_id_from_executor_name_returns_device_id() -> None:
    device_id = "91762459-9e54-46b6-a9fa-eca8f30e9d2e"

    result = _extract_device_id_from_executor_name(f"device-{device_id}")

    assert result == device_id


def test_extract_device_id_from_executor_name_ignores_non_device_executor() -> None:
    assert _extract_device_id_from_executor_name("executor-123") is None
    assert _extract_device_id_from_executor_name("") is None
    assert _extract_device_id_from_executor_name(None) is None
