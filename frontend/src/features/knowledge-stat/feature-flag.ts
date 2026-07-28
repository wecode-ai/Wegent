// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Feature flag for the KB statistics UI.
 *
 * NEXT_PUBLIC_KB_STAT_ENABLED is a build-time switch (inline-replaced by
 * Next.js into the client bundle). It defaults to OFF: the feature is only
 * enabled when the var is explicitly set to "true" or "1" (e.g. in
 * frontend/.env.local). A fresh deployment that does not set the var ships
 * the tab hidden, matching the backend/runtime KB_STAT_ENABLED default of
 * false.
 *
 * Set NEXT_PUBLIC_KB_STAT_ENABLED=false (or leave it unset) to hide the
 * "知识库统计" admin tab and the "statistics" sub-tab on the KB detail
 * panel. The backend/runtime will still 503 the underlying API endpoints
 * when KB_STAT_ENABLED=false on those layers, but hiding the UI avoids
 * sending users into a dead end.
 */
export const isKbStatEnabled = (): boolean => {
  const v = process.env.NEXT_PUBLIC_KB_STAT_ENABLED
  return v === 'true' || v === '1'
}
