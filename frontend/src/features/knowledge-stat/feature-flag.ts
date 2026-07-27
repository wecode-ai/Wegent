// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Feature flag for the KB statistics UI.
 *
 * NEXT_PUBLIC_KB_STAT_ENABLED is a build-time switch (inline-replaced by
 * Next.js into the client bundle). When unset the feature is considered
 * on — this preserves the pre-existing behaviour and avoids hiding the
 * tab on deployments that haven't learned about the switch yet.
 *
 * Set NEXT_PUBLIC_KB_STAT_ENABLED=false in frontend/.env.local (or the
 * build environment) to hide the "知识库统计" admin tab and the
 * "statistics" sub-tab on the KB detail panel. The backend/runtime will
 * still 503 the underlying API endpoints when KB_STAT_ENABLED=false on
 * those layers, but hiding the UI avoids sending users into a dead end.
 */
export const isKbStatEnabled = (): boolean => {
  const v = process.env.NEXT_PUBLIC_KB_STAT_ENABLED
  return v === undefined ? true : v !== 'false' && v !== '0'
}
