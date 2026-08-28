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


def test_open_download_streams_and_closes_object_response(monkeypatch) -> None:
    class ObjectResponse:
        def __init__(self) -> None:
            self.chunks = [b"smart-", b"app", b""]
            self.closed = False
            self.released = False

        def read(self, _chunk_size: int) -> bytes:
            return self.chunks.pop(0)

        def close(self) -> None:
            self.closed = True

        def release_conn(self) -> None:
            self.released = True

    response = ObjectResponse()

    class StorageClient:
        def get_object(self, bucket: str, object_key: str):
            assert bucket == "plugins"
            assert object_key == "smart-apps/releases/1/app.zip"
            return response

    monkeypatch.setattr(
        PluginPackageStorage,
        "client",
        property(lambda _storage: StorageClient()),
    )

    chunks = list(PluginPackageStorage().open_download("smart-apps/releases/1/app.zip"))

    assert chunks == [b"smart-", b"app"]
    assert response.closed is True
    assert response.released is True
