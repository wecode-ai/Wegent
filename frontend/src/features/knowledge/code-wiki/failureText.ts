// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Codes the server states in its own words; anything else is external text. */
const TRANSLATABLE = new Set([
  'task_ended_without_report',
  'task_not_created',
  'worker_abandoned',
  'publish_refused',
])

/**
 * Why a run failed, in the reader's language where that is possible.
 *
 * Two kinds of reason arrive here and they must not be treated alike. One the server
 * invented — "the task ended without reporting" — and showing that English sentence
 * beside translated UI reads as a bug rather than as a diagnostic. The other came
 * from outside: git's output, the agent's own message, an exception. Translating
 * that is not an option, and paraphrasing it would destroy the only detail there is.
 *
 * So a code is translated and any external text is appended after it, rather than
 * one replacing the other: a task that both failed and said why should show both.
 */
export function failureText(
  failureCode: string,
  errorMessage: string,
  // Resolved in the caller's namespace, so this is only usable from a component whose
  // primary namespace is `knowledge`. Both callers are in this directory and every
  // component here declares it.
  t: (key: string) => string
): string {
  const known = failureCode && TRANSLATABLE.has(failureCode)
  const headline = known ? t(`codeWiki.failure.${failureCode}`) : ''

  if (headline && errorMessage) return `${headline}: ${errorMessage}`
  return headline || errorMessage
}
