# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Media staging coordinator for multimodal analysis.

Thin facade over a :class:`MediaStagingProvider`. The converter no longer talks
directly to a vendor GCS gateway; instead it delegates upload/delete to the
pluggable provider selected from the task's ``media_staging_config``. This keeps
the converter free of vendor credentials and lets the open-source build ship a
NoOp default while internal deployments inject a concrete provider.

Error classification: provider failures are mapped to the pipeline's
Transient/Permanent categories so the task's retry decision stays uniform.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, Optional

import httpx

from knowledge_doc_converter.services.errors import (
    PermanentError,
    TransientError,
)
from knowledge_doc_converter.services.media_staging import (
    MediaStagingProvider,
    build_staging_provider,
)

logger = logging.getLogger(__name__)


class MultimodalConversionCoordinator:
    """Coordinate media upload/delete via a pluggable staging provider."""

    def upload(
        self,
        *,
        tmp_path: str,
        filename: str,
        content_type: str,
        media_type: str,
        staging_provider: MediaStagingProvider,
        timeout_seconds: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Stage a local media file and return ``{uri, object_name}``.

        Raises :class:`PermanentError` / :class:`TransientError` per the
        provider's failure mode (NoOp raises PermanentError immediately).
        """
        try:
            descriptor = staging_provider.upload(
                local_path=tmp_path,
                mime_type=content_type,
                original_filename=filename,
                media_type=media_type,
                timeout_seconds=timeout_seconds,
            )
        except PermanentError:
            raise
        except TransientError:
            raise
        except Exception as exc:
            # Unknown provider failure → treat as transient (network, gateway
            # hiccup) so the task retries once before failing fast.
            raise TransientError(
                "staging_upload_failed", f"Media staging upload failed: {exc}"
            ) from exc

        uri = descriptor.get("uri")
        object_name = descriptor.get("object_name")
        if not uri or not object_name:
            raise PermanentError(
                "staging_invalid_descriptor",
                f"Staging provider returned an incomplete descriptor: {descriptor!r}",
            )
        return {"gs_url": uri, "object_name": object_name}

    def delete(
        self,
        *,
        staging_provider: MediaStagingProvider,
        object_name: Optional[str],
    ) -> None:
        """Best-effort delete of a staged object. Never raises."""
        if not object_name:
            return
        try:
            staging_provider.delete(object_name=object_name)
        except Exception as exc:  # noqa: BLE001 — cleanup must never raise
            logger.warning(
                "Media staging delete failed object_name=%s error=%s",
                object_name,
                exc,
            )

    def upload_via_proxy(
        self,
        *,
        tmp_path: str,
        filename: str,
        content_type: str,
        gcs_upload_path: str,
        gcs_resumable_base_path: Optional[str] = None,
        timeout_seconds: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Upload a local file to a staging proxy (e.g. backend GCS proxy).

        Routes by file size: ``≤ MULTIMODAL_VIDEO_SIMPLE_UPLOAD_MAX_BYTES`` uses
        the single-request simple upload endpoint; above it uses the resumable
        endpoints (init → chunk loop → done) when ``gcs_resumable_base_path``
        is configured. Used by internal deployments where the converter has no
        direct cloud credentials — it streams the file to a backend internal
        endpoint which proxies the upload to the staging provider (GCS gateway,
        S3, etc.).

        Returns ``{gs_url, object_name}``.
        """
        from knowledge_doc_converter.config import settings

        file_size = os.path.getsize(tmp_path)
        if (
            file_size > settings.MULTIMODAL_VIDEO_SIMPLE_UPLOAD_MAX_BYTES
            and gcs_resumable_base_path
        ):
            return self._upload_via_proxy_resumable(
                tmp_path=tmp_path,
                filename=filename,
                content_type=content_type,
                media_size=file_size,
                gcs_resumable_base_path=gcs_resumable_base_path,
                timeout_seconds=timeout_seconds,
            )

        base_url = settings.BACKEND_BASE_URL
        headers = {
            "Authorization": f"Bearer {settings.BACKEND_INTERNAL_TOKEN}",
        }
        upload_url = f"{base_url}{gcs_upload_path}"
        try:
            with open(tmp_path, "rb") as f:
                resp = httpx.post(
                    upload_url,
                    data={"filename": filename, "content_type": content_type},
                    files={"file": (filename, f, content_type)},
                    headers=headers,
                    timeout=timeout_seconds or 300,
                )
        except httpx.HTTPError as exc:
            raise TransientError(
                "staging_proxy_network",
                f"Staging proxy upload network error: {exc}",
            ) from exc

        self._raise_for_proxy_response(resp)
        data = resp.json()
        gs_url = data.get("gs_url")
        object_name = data.get("object_name")
        if not gs_url or not object_name:
            raise PermanentError(
                "staging_invalid_response",
                f"Staging proxy returned incomplete response: {data!r}",
            )
        return {"gs_url": gs_url, "object_name": object_name}

    def delete_via_proxy(
        self,
        *,
        gcs_delete_path: str,
        object_name: str,
    ) -> None:
        """Best-effort delete of a staged object via a proxy. Never raises."""
        from knowledge_doc_converter.config import settings

        base_url = settings.BACKEND_BASE_URL
        headers = {
            "Authorization": f"Bearer {settings.BACKEND_INTERNAL_TOKEN}",
        }
        delete_url = f"{base_url}{gcs_delete_path}"
        try:
            httpx.post(
                delete_url,
                data={"object_name": object_name},
                headers=headers,
                timeout=30,
            )
        except Exception as exc:  # noqa: BLE001 — cleanup must never raise
            logger.warning(
                "Staging proxy delete failed object_name=%s error=%s",
                object_name,
                exc,
            )

    # ── proxy response classification ─────────────────────────────

    @staticmethod
    def _raise_for_proxy_response(resp: httpx.Response) -> None:
        """Classify a backend proxy response into Permanent/Transient errors.

        Shared by the simple and resumable upload paths.

        - 413 / detail contains ``gcs_file_too_large`` → PermanentError
          (oversized; retrying wastes a Celery slot).
        - 401/403 → PermanentError (auth/permission; never succeeds on retry).
        - 410 → TransientError (session invalid; caller may re-init).
        - 5xx → TransientError (backend/GCS hiccup).
        - other 4xx → TransientError (kept transient for safety; the backend
          is the correctness boundary and a fresh attempt may succeed).
        """
        if resp.status_code < 400:
            return
        detail = resp.text or ""
        if resp.status_code == 413 or _GCS_TOO_LARGE_DETAIL_TOKEN in detail:
            raise PermanentError(
                "staging_file_too_large",
                f"Staging proxy rejected file (too large): "
                f"{resp.status_code} {detail[:200]}",
            )
        if resp.status_code in (401, 403):
            raise PermanentError(
                "staging_auth_error",
                f"Staging proxy auth/permission error (status={resp.status_code})",
            )
        if resp.status_code == 410:
            raise TransientError(
                "staging_session_invalid",
                f"Staging proxy session invalid (status=410) {detail[:200]}",
            )
        if 500 <= resp.status_code < 600:
            raise TransientError(
                "staging_proxy_server",
                f"Staging proxy server error (status={resp.status_code})",
            )
        raise TransientError(
            "staging_proxy_client",
            f"Staging proxy client error (status={resp.status_code})",
        )

    # ── resumable upload (> threshold) ────────────────────────────

    def _upload_via_proxy_resumable(
        self,
        *,
        tmp_path: str,
        filename: str,
        content_type: str,
        media_size: int,
        gcs_resumable_base_path: str,
        timeout_seconds: Optional[int],
    ) -> Dict[str, Any]:
        """Drive a resumable upload via the backend proxy.

        Flow: init → chunk loop (put_chunk × N) → done. Per the GCS gateway
        contract the normal path only needs init + put_chunk — the server's
        chunk response already carries the next offset, so ``query`` is used
        solely on the recovery path to discover the confirmed received offset
        (frequent queries incur extra class_a billing), and ``cancel`` is
        best-effort cleanup on abandon.

        Recovery:
        - ``_ResumableSessionInvalid`` (410): re-init once, re-align offset via
          query, then continue. A second invalidation aborts.
        - ``_ResumableChunkFailed`` (5xx/network): query for the received
          offset and resume from there (no re-upload of confirmed bytes).
        """
        from knowledge_doc_converter.config import settings

        base = f"{settings.BACKEND_BASE_URL.rstrip('/')}{gcs_resumable_base_path}"
        timeout = timeout_seconds or settings.MULTIMODAL_DOWNLOAD_TIMEOUT_SECONDS

        session = self._resumable_init(
            base=base,
            filename=filename,
            content_type=content_type,
            total_size=media_size,
            timeout=timeout,
        )
        session_uri = session["session_uri"]
        object_name = session["object_name"]
        # 8 MiB is 256 KiB-aligned (gateway requirement for mid-chunks); the
        # final chunk may be smaller and is exempt from alignment.
        chunk_size = session.get("chunk_size") or (8 * 1024 * 1024)

        reinit_used = False
        recovery_count = 0
        stall_count = 0
        offset = 0
        chunk_index = 0
        with open(tmp_path, "rb") as f:
            while offset < media_size:
                f.seek(offset)
                chunk = f.read(chunk_size)
                chunk_index += 1
                try:
                    result = self._resumable_put_chunk(
                        base=base,
                        session_uri=session_uri,
                        object_name=object_name,
                        offset=offset,
                        total_size=media_size,
                        chunk=chunk,
                        timeout=timeout,
                    )
                except _ResumableSessionInvalid:
                    if reinit_used:
                        # Second invalidation → surface as transient; looping
                        # further would burn class_a fees for nothing.
                        self._resumable_cancel(base=base, session_uri=session_uri)
                        raise TransientError(
                            "staging_resumable_session_lost",
                            "Resumable session invalidated twice; aborting",
                        )
                    logger.warning(
                        "[MultimodalProxy] resumable session invalid; re-initializing"
                    )
                    reinit_used = True
                    session = self._resumable_init(
                        base=base,
                        filename=filename,
                        content_type=content_type,
                        total_size=media_size,
                        timeout=timeout,
                    )
                    session_uri = session["session_uri"]
                    object_name = session["object_name"]
                    offset = self._resumable_query_offset(
                        base=base,
                        session_uri=session_uri,
                        total_size=media_size,
                        timeout=timeout,
                    )
                    continue
                except _ResumableChunkFailed as exc:
                    recovery_count += 1
                    if recovery_count > _MAX_CHUNK_RECOVERIES:
                        # Persistently failing — abort instead of looping until
                        # the Celery task timeout. Cancel the session for hygiene.
                        self._resumable_cancel(base=base, session_uri=session_uri)
                        raise TransientError(
                            "staging_resumable_too_many_failures",
                            f"Resumable upload aborted after {recovery_count} "
                            f"chunk failures",
                        )
                    logger.warning(
                        "[MultimodalProxy] chunk failed at offset=%d; querying to resume: %s",
                        offset,
                        exc,
                    )
                    prev_offset = offset
                    offset = self._resumable_query_offset(
                        base=base,
                        session_uri=session_uri,
                        total_size=media_size,
                        timeout=timeout,
                    )
                    # Stall detection: if the offset did not advance, the chunk
                    # cannot get through — count it and abort after a few rounds.
                    if offset <= prev_offset:
                        stall_count += 1
                        if stall_count >= _MAX_STALLS:
                            self._resumable_cancel(base=base, session_uri=session_uri)
                            raise TransientError(
                                "staging_resumable_stalled",
                                f"Resumable upload stalled at offset {offset} "
                                f"for {stall_count} consecutive recoveries",
                            )
                    else:
                        stall_count = 0
                    continue

                if chunk_index % 10 == 0:
                    logger.info(
                        "[MultimodalProxy] resumable progress filename=%s chunk=%d offset=%d/%d",
                        filename,
                        chunk_index,
                        offset,
                        media_size,
                    )

                if result.get("status") == "done":
                    gs_url = result.get("gs_url")
                    if not gs_url:
                        break
                    logger.info(
                        "[MultimodalProxy] resumable done filename=%s object_name=%s chunks=%d",
                        filename,
                        object_name,
                        chunk_index,
                    )
                    return {"gs_url": gs_url, "object_name": object_name}
                # status == "continue": advance past this chunk. GCS guarantees
                # a continue response means the full chunk was received.
                offset = min(offset + len(chunk), media_size)

        # All bytes sent but no done status — final query to confirm.
        final = self._resumable_query(
            base=base,
            session_uri=session_uri,
            total_size=media_size,
            timeout=timeout,
        )
        gs_url = final.get("gs_url")
        if not gs_url:
            self._resumable_cancel(base=base, session_uri=session_uri)
            raise TransientError(
                "staging_resumable_incomplete",
                f"Resumable upload finished without gs_url (size={media_size})",
            )
        logger.info(
            "[MultimodalProxy] resumable finalized filename=%s object_name=%s",
            filename,
            object_name,
        )
        return {"gs_url": gs_url, "object_name": object_name}

    def _resumable_init(
        self,
        *,
        base: str,
        filename: str,
        content_type: str,
        total_size: int,
        timeout: int,
    ) -> Dict[str, Any]:
        from knowledge_doc_converter.config import settings

        url = f"{base}/init"
        headers = {
            "Authorization": f"Bearer {settings.BACKEND_INTERNAL_TOKEN}",
            "Content-Type": "application/json",
        }
        payload = {
            "filename": filename,
            "content_type": content_type,
            "total_size": total_size,
        }
        try:
            resp = httpx.post(url, headers=headers, json=payload, timeout=timeout)
        except httpx.HTTPError as exc:
            raise TransientError(
                "staging_proxy_network",
                f"Resumable init network error: {exc}",
            ) from exc
        self._raise_for_proxy_response(resp)
        data = resp.json()
        if not data.get("session_uri"):
            raise TransientError(
                "staging_resumable_init_empty",
                "Resumable init returned no session_uri",
            )
        logger.info(
            "[MultimodalProxy] resumable init filename=%s total_size=%d chunk_size=%s",
            filename,
            total_size,
            data.get("chunk_size"),
        )
        return data

    def _resumable_put_chunk(
        self,
        *,
        base: str,
        session_uri: str,
        object_name: str,
        offset: int,
        total_size: int,
        chunk: bytes,
        timeout: int,
    ) -> Dict[str, Any]:
        from knowledge_doc_converter.config import settings

        url = f"{base}/chunk"
        headers = {"Authorization": f"Bearer {settings.BACKEND_INTERNAL_TOKEN}"}
        data = {
            "session_uri": session_uri,
            "object_name": object_name,
            "offset": str(offset),
            "total_size": str(total_size),
        }
        try:
            resp = httpx.post(
                url,
                headers=headers,
                data=data,
                files={"chunk": ("chunk.bin", chunk, "application/octet-stream")},
                timeout=timeout,
            )
        except httpx.HTTPError as exc:
            raise _ResumableChunkFailed(
                f"put_chunk network error at offset={offset}: {exc}"
            ) from exc

        if resp.status_code == 410:
            raise _ResumableSessionInvalid("put_chunk returned 410")
        if resp.status_code >= 500:
            raise _ResumableChunkFailed(
                f"put_chunk server error {resp.status_code} at offset={offset}"
            )
        if resp.status_code >= 400:
            # 413/401/403/other 4xx — classify via the shared mapping.
            self._raise_for_proxy_response(resp)
        return resp.json()

    def _resumable_query(
        self,
        *,
        base: str,
        session_uri: str,
        total_size: int,
        timeout: int,
    ) -> Dict[str, Any]:
        from knowledge_doc_converter.config import settings

        url = f"{base}/query"
        headers = {
            "Authorization": f"Bearer {settings.BACKEND_INTERNAL_TOKEN}",
            "Content-Type": "application/json",
        }
        payload = {"session_uri": session_uri, "total_size": total_size}
        try:
            resp = httpx.post(url, headers=headers, json=payload, timeout=timeout)
        except httpx.HTTPError as exc:
            raise _ResumableChunkFailed(f"query network error: {exc}") from exc
        if resp.status_code == 410:
            raise _ResumableSessionInvalid("query returned 410")
        if resp.status_code >= 400:
            raise _ResumableChunkFailed(
                f"query error {resp.status_code}: {resp.text[:200]}"
            )
        return resp.json()

    def _resumable_query_offset(
        self,
        *,
        base: str,
        session_uri: str,
        total_size: int,
        timeout: int,
    ) -> int:
        """Return the confirmed received byte offset, or 0 if unknown.

        Used only on the recovery path; a failure here conservatively restarts
        from 0 so bytes are re-sent rather than skipped.
        """
        try:
            data = self._resumable_query(
                base=base,
                session_uri=session_uri,
                total_size=total_size,
                timeout=timeout,
            )
        except _ResumableSessionInvalid:
            raise
        except Exception:
            return 0
        # Prefer next_offset (the gateway's authoritative "where to resume
        # from"). Fall back to received_byte + 1: received_byte is the index of
        # the last received byte (0-based), so +1 is the next byte to send.
        next_offset = data.get("next_offset")
        if isinstance(next_offset, int) and next_offset >= 0:
            return next_offset
        received = data.get("received_byte")
        if isinstance(received, int) and received >= 0:
            return received + 1
        return 0

    def _resumable_cancel(self, *, base: str, session_uri: str) -> None:
        from knowledge_doc_converter.config import settings

        url = f"{base}/cancel"
        headers = {
            "Authorization": f"Bearer {settings.BACKEND_INTERNAL_TOKEN}",
            "Content-Type": "application/json",
        }
        try:
            httpx.post(
                url,
                headers=headers,
                json={"session_uri": session_uri},
                timeout=30,
            )
        except Exception:  # noqa: BLE001 — cleanup must never raise
            pass


# Detail substring the backend embeds when GCS rejects an oversized file
# (GcsGatewayError("gcs_file_too_large")). Used as a fallback signal when the
# HTTP status was collapsed (older backends wrap everything as 502).
_GCS_TOO_LARGE_DETAIL_TOKEN = "gcs_file_too_large"

# Caps on the chunk-failure recovery loop so a persistently-failing upload
# aborts with a coded error instead of retrying until the Celery task timeout.
_MAX_CHUNK_RECOVERIES = 10  # total chunk-failure recoveries before aborting
_MAX_STALLS = 5  # consecutive recoveries with no offset progress before aborting


class _ResumableChunkFailed(Exception):
    """A chunk upload failed transiently; caller should query + resume."""


class _ResumableSessionInvalid(Exception):
    """The resumable session URI expired; caller must re-init."""


# Module-level singleton.
multimodal_conversion_coordinator = MultimodalConversionCoordinator()


def get_staging_provider(
    media_staging_config: Optional[Dict[str, Any]],
) -> MediaStagingProvider:
    """Convenience wrapper around ``build_staging_provider``."""
    return build_staging_provider(media_staging_config)
