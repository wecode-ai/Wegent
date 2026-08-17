# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import time
from unittest.mock import AsyncMock

import pytest

from wecode.config.video_image_staging_config import VideoImageStagingSettings
from wecode.service.video_image_staging import OssVideoImageStagingBackend


class _FakeRedisClient:
    def __init__(self, cache):
        self._cache = cache

    async def set(self, key, value, ex=None, nx=False):
        del ex
        if nx and key in self._cache.locks:
            return False
        self._cache.locks[key] = value
        return True

    async def eval(self, script, count, key, token):
        del script, count
        if self._cache.locks.get(key) == token:
            self._cache.locks.pop(key, None)
            return 1
        return 0

    async def aclose(self):
        return None


class _FakeCache:
    def __init__(self):
        self.values = {}
        self.locks = {}
        self.set_calls = 0

    async def get(self, key):
        return self.values.get(key)

    async def set(self, key, value, expire=None):
        del expire
        self.values[key] = value
        self.set_calls += 1
        return True

    async def delete(self, key):
        self.values.pop(key, None)
        return True

    async def _get_client(self):
        return _FakeRedisClient(self)


class _FakeBucket:
    def __init__(self):
        self.objects = {}
        self.put_calls = 0
        self.sign_calls = 0

    def put_object(self, key, data, headers=None):
        self.objects[key] = {"data": data, "headers": headers}
        self.put_calls += 1

    def object_exists(self, key):
        return key in self.objects

    def sign_url(self, method, key, expires):
        self.sign_calls += 1
        return f"https://oss.example.com/{key}?signature={self.sign_calls}&e={expires}"


def _config(**overrides) -> VideoImageStagingSettings:
    values = {
        "VIDEO_MODEL_IMAGE_STAGING_BACKEND": "oss",
        "VIDEO_MODEL_IMAGE_OSS_ENDPOINT": "https://oss-cn-test.aliyuncs.com",
        "VIDEO_MODEL_IMAGE_OSS_ACCESS_KEY_ID": "access-key",
        "VIDEO_MODEL_IMAGE_OSS_ACCESS_KEY_SECRET": "secret-key",
        "VIDEO_MODEL_IMAGE_OSS_BUCKET": "test-bucket",
        "VIDEO_MODEL_IMAGE_OSS_URL_EXPIRES_SECONDS": 86400,
        "VIDEO_MODEL_IMAGE_OSS_CACHE_TTL_SECONDS": 82800,
    }
    values.update(overrides)
    return VideoImageStagingSettings(**values)


@pytest.mark.asyncio
async def test_stages_once_and_resigns_cached_object() -> None:
    cache = _FakeCache()
    upload_bucket = _FakeBucket()
    backend = OssVideoImageStagingBackend(
        _config(
            VIDEO_MODEL_IMAGE_OSS_PUBLIC_ENDPOINT="https://x.com",
        ),
        bucket=upload_bucket,
        cache=cache,
    )
    image = {
        "url": "https://s3.example.com/reference.png",
        "storage_backend": "s3",
        "storage_key": "attachments/reference",
        "updated_at": "2026-08-11T00:00:00",
        "file_extension": ".png",
    }
    backend._read_image = AsyncMock(return_value=(b"image-data", "image/png"))

    first = await backend.stage([image], user_id=1)
    second = await backend.stage([image], user_id=1)

    assert upload_bucket.put_calls == 1
    assert upload_bucket.sign_calls == 0
    assert cache.set_calls == 1
    assert first[0]["url"].startswith("https://x.com/video-image-staging/")
    assert first[0]["url"] == second[0]["url"]
    assert "?" not in first[0]["url"]
    backend._read_image.assert_awaited_once_with(image, 1)


@pytest.mark.asyncio
async def test_reuploads_when_cached_object_is_missing() -> None:
    cache = _FakeCache()
    bucket = _FakeBucket()
    backend = OssVideoImageStagingBackend(
        _config(VIDEO_MODEL_IMAGE_OSS_PUBLIC_ENDPOINT="https://x.com"),
        bucket=bucket,
        cache=cache,
    )
    image = {"url": "data:image/png;base64,aW1hZ2U="}

    first = await backend.stage([image], user_id=1)
    bucket.objects.clear()
    second = await backend.stage([image], user_id=1)

    assert bucket.put_calls == 2
    assert first[0]["url"] != second[0]["url"]


@pytest.mark.asyncio
async def test_missing_oss_configuration_fails_before_upload() -> None:
    backend = OssVideoImageStagingBackend(
        _config(VIDEO_MODEL_IMAGE_OSS_BUCKET=""),
        bucket=_FakeBucket(),
        cache=_FakeCache(),
    )

    with pytest.raises(ValueError, match="VIDEO_MODEL_IMAGE_OSS_BUCKET"):
        await backend.stage(
            [{"url": "data:image/png;base64,aW1hZ2U="}],
            user_id=1,
        )


@pytest.mark.asyncio
async def test_public_endpoint_is_required_before_upload() -> None:
    backend = OssVideoImageStagingBackend(
        _config(VIDEO_MODEL_IMAGE_OSS_PUBLIC_ENDPOINT=""),
        bucket=_FakeBucket(),
        cache=_FakeCache(),
    )

    with pytest.raises(
        ValueError,
        match="VIDEO_MODEL_IMAGE_OSS_PUBLIC_ENDPOINT",
    ):
        await backend.stage(
            [{"url": "data:image/png;base64,aW1hZ2U="}],
            user_id=1,
        )


def test_backend_setting_rejects_unknown_value() -> None:
    with pytest.raises(ValueError, match="direct.*oss"):
        VideoImageStagingSettings(VIDEO_MODEL_IMAGE_STAGING_BACKEND="unknown")


def test_public_endpoint_url_encodes_object_name_without_signing() -> None:
    bucket = _FakeBucket()
    backend = OssVideoImageStagingBackend(
        _config(VIDEO_MODEL_IMAGE_OSS_PUBLIC_ENDPOINT="https://x.com/base/"),
        bucket=bucket,
        cache=_FakeCache(),
    )

    result = backend._with_staged_url(
        {},
        {
            "object_key": "video-image-staging/path/image name.png",
            "expires_at": time.time() + 600,
        },
    )

    assert result["url"] == (
        "https://x.com/base/video-image-staging/path/image%20name.png"
    )
    assert bucket.sign_calls == 0


def test_object_key_uses_random_directory_and_filename() -> None:
    backend = OssVideoImageStagingBackend(
        _config(),
        bucket=_FakeBucket(),
        cache=_FakeCache(),
    )

    object_key = backend._object_key(
        {"file_extension": ".png"},
        "image/png",
    )
    parts = object_key.split("/")

    assert parts[0] == "video-image-staging"
    assert len(parts[1]) == 32
    assert len(parts[2].removesuffix(".png")) == 32
