# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import os

from app.core import embedded_celery


def test_prepare_embedded_worker_environment_disables_celery_dummy_proxy(
    monkeypatch,
) -> None:
    monkeypatch.setattr(embedded_celery.sys, "platform", "darwin")
    monkeypatch.setenv("celery_dummy_proxy", "set_by_celeryd")

    embedded_celery._prepare_embedded_worker_environment()

    assert os.environ["celery_dummy_proxy"] == ""


def test_prepare_embedded_worker_environment_preserves_other_platforms(
    monkeypatch,
) -> None:
    monkeypatch.setattr(embedded_celery.sys, "platform", "linux")
    monkeypatch.setenv("celery_dummy_proxy", "existing")

    embedded_celery._prepare_embedded_worker_environment()

    assert os.environ["celery_dummy_proxy"] == "existing"
