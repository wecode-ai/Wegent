// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Module-level active video player store.
 *
 * Ensures at most one video element is mounted across all source references
 * in the page. Uses player instance IDs (not document IDs) so the same video
 * appearing in multiple messages does not conflict.
 *
 * Consumed via `useSyncExternalStore` — no React context needed, works across
 * independently rendered SourceReferenceItem instances.
 */

let activePlayerId: string | null = null
const listeners = new Set<() => void>()

export function getActivePlayerId(): string | null {
  return activePlayerId
}

export function subscribeActivePlayer(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function activatePlayer(playerId: string | null): void {
  if (activePlayerId === playerId) return
  activePlayerId = playerId
  listeners.forEach(listener => listener())
}
