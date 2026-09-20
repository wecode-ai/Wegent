# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Signed OpenCut callbacks for voiceover generation and polling."""

from typing import Any, Optional
from urllib.parse import quote

from fastapi import APIRouter, HTTPException

from shared.telemetry.decorators import trace_async

from .opencut import _request_aigc_json
from .opencut_urls import verify_opencut_token

router = APIRouter()


def _voiceover_payload(
    payload: dict[str, Any], *, key: str, session_id: str
) -> dict[str, Any]:
    value = payload.get(key)
    if not isinstance(value, dict) or not value:
        raise HTTPException(status_code=400, detail=f"{key} is required")
    requested_session = str(value.get("session_id") or "").strip()
    if requested_session and requested_session != session_id:
        raise HTTPException(status_code=400, detail=f"{key} session mismatch")
    if not str(value.get("task_id") or "").strip():
        raise HTTPException(status_code=400, detail=f"{key} missing task_id")
    return {**value, "session_id": session_id}


@router.post("/material-video/opencut/voiceover/{session_id}")
@trace_async(span_name="opencut.voiceover.generate", tracer_name=__name__)
async def generate_opencut_voiceover(
    session_id: str, token: str, payload: dict[str, Any]
) -> dict[str, Any]:
    """Sync script before generating speech, using the signed user's identity."""
    identity = verify_opencut_token(token, session_id)
    script_payload = _voiceover_payload(
        payload, key="updateScriptPayload", session_id=session_id
    )
    voiceover_payload = _voiceover_payload(
        payload, key="generateVoiceoverPayload", session_id=session_id
    )
    uid = str(identity["uid"])
    script = await _request_aigc_json(
        method="POST",
        path="v2/material-video/update-script",
        uid=uid,
        payload=script_payload,
    )
    voiceover = await _request_aigc_json(
        method="POST",
        path="v2/material-video/generate-voiceover",
        uid=uid,
        payload=voiceover_payload,
    )
    return {"script": script, "voiceover": voiceover}


@router.get("/material-video/opencut/voiceover/{session_id}")
@trace_async(span_name="opencut.voiceover.poll", tracer_name=__name__)
async def get_opencut_voiceover(
    session_id: str,
    token: str,
    task_id: str,
    group_id: Optional[str] = None,
) -> dict[str, Any]:
    """Return the requested group's result without requiring browser login."""
    identity = verify_opencut_token(token, session_id)
    if not task_id.strip():
        raise HTTPException(status_code=400, detail="task_id is required")
    params = {"task_id": task_id}
    if group_id:
        params["group_id"] = group_id
    result = await _request_aigc_json(
        method="GET",
        path=f"v2/material-video/generate-voiceover/{quote(session_id, safe='')}",
        uid=str(identity["uid"]),
        params=params,
    )
    if group_id and isinstance(result.get("voiceovers"), list):
        voiceovers = [
            item
            for item in result["voiceovers"]
            if isinstance(item, dict) and item.get("group_id") == group_id
        ]
        return {**result, "voiceovers": voiceovers, "total": len(voiceovers)}
    return result
