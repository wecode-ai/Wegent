# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from urllib3.exceptions import HTTPError

from app.services.plugin_package_storage import (
    PluginPackageStorage,
    PluginPackageStorageError,
)


def test_put_wraps_object_storage_connection_errors(monkeypatch) -> None:
    class UnavailableClient:
        def bucket_exists(self, _bucket: str) -> bool:
            raise HTTPError("object storage unavailable")

    monkeypatch.setattr(
        PluginPackageStorage,
        "client",
        property(lambda _storage: UnavailableClient()),
    )

    with pytest.raises(PluginPackageStorageError, match="object storage unavailable"):
        PluginPackageStorage().put("staging/app.zip", b"package")
