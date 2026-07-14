# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Monkey-patch OutboundTokenService to inject the employee_id (工号) claim.

Internal-only. When a token issue request sets ``include_employee_id``, look
up the user's 工号 from ``wecode_erp_user`` and add it as an ``employee_id``
claim on the signed token. Reads a single local DB row; no network I/O. A
missing/empty 工号 -- or a DB read failure -- yields no claim (silent,
backward-compatible) rather than failing the whole token issuance.
"""

import logging

from sqlalchemy.exc import SQLAlchemyError

from app.services.auth.outbound_token_service import OutboundTokenService
from wecode.models.erp_user import WecodeErpUser

logger = logging.getLogger(__name__)


def apply_patch() -> None:
    def patched_collect_extra_claims(self, db, *, user, issuer, request=None) -> dict:
        if request is None:
            return {}

        claims: dict = {}

        # Each opt-in request flag independently contributes its claim(s).
        # Add future flags as additional blocks below.
        if getattr(request, "include_employee_id", None):
            # The employee_id claim is optional and tolerated-if-absent, so a
            # DB read failure degrades gracefully: log and issue the token
            # without the claim rather than failing the whole request. Only
            # SQLAlchemyError is swallowed; other errors (e.g. bugs) propagate.
            try:
                row = (
                    db.query(WecodeErpUser)
                    .filter(WecodeErpUser.user_id == user.id)
                    .first()
                )
            except SQLAlchemyError:
                logger.warning(
                    "Failed to read employee_id for user_id=%s; "
                    "issuing token without the claim",
                    user.id,
                    exc_info=True,
                )
                row = None
            if row and row.employee_id:
                claims["employee_id"] = row.employee_id

        return claims

    OutboundTokenService._collect_extra_claims = patched_collect_extra_claims  # type: ignore[assignment]
    logger.info("Patched OutboundTokenService to inject employee_id claim")


# Auto apply
apply_patch()
