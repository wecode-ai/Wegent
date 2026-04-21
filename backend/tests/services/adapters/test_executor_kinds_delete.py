from unittest.mock import Mock, patch

import pytest
from fastapi import HTTPException

from app.services.adapters.executor_kinds import ExecutorKindsService


@pytest.mark.unit
def test_delete_executor_task_sync_raises_on_failed_response():
    service = ExecutorKindsService(Mock())
    response = Mock()
    response.raise_for_status.return_value = None
    response.json.return_value = {"status": "failed", "error_msg": "delete failed"}

    with patch("requests.post", return_value=response):
        with pytest.raises(HTTPException, match="delete failed"):
            service.delete_executor_task_sync("executor-1", "wb-plat-ide")
