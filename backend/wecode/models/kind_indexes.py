# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Indexes on shared Kind resources used by internal WeCode APIs."""

from sqlalchemy import Index

from app.models.kind import Kind

CLOUD_DEVICE_NAME_LOOKUP_INDEX = Index(
    "ix_kinds_name_kind_ns_active",
    Kind.__table__.c.name,
    Kind.__table__.c.kind,
    Kind.__table__.c.namespace,
    Kind.__table__.c.is_active,
)
