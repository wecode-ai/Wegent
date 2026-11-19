// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationTranslate } from "../i18n";

type ErrorDetail = {
  reason_code?: unknown;
  message?: unknown;
};

function errorDetail(error: unknown): ErrorDetail | null {
  if (!error || typeof error !== "object") return null;
  const detail = (error as { detail?: unknown }).detail;
  if (detail && typeof detail === "object") return detail as ErrorDetail;
  if (!(error instanceof Error)) return null;
  try {
    const parsed = JSON.parse(error.message) as { detail?: unknown };
    return parsed.detail && typeof parsed.detail === "object"
      ? (parsed.detail as ErrorDetail)
      : null;
  } catch {
    return null;
  }
}

/** Explain stage ownership denials without exposing the provider payload. */
export function stageAssigneeMismatchMessage(
  error: unknown,
  translate: CollaborationTranslate,
): string | null {
  const detail = errorDetail(error);
  const code =
    detail?.reason_code ??
    (error && typeof error === "object"
      ? ((error as { errorCode?: unknown; error_code?: unknown }).errorCode ??
        (error as { error_code?: unknown }).error_code)
      : null);
  if (code !== "stage_assignee_mismatch") return null;
  return translate(
    "todo.stage_assignee_mismatch",
    "The selected assignee does not match the current stage requirement. The saved assignee has been retained.",
  );
}
