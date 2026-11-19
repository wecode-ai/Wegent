# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Template import operations stored in the existing unified node table."""

from app.models.delivery import LoopNode

TEMPLATE_IMPORT_RESOURCE_TYPE = "template_import"
TEMPLATE_IMPORT_KIND = "template_import_operation"


class TemplateImportOperation(LoopNode):
    """Project-scoped durable operation with receipts in ``metadata_json``."""

    __mapper_args__ = {"polymorphic_identity": TEMPLATE_IMPORT_RESOURCE_TYPE}
