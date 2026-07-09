// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Knowledge video download registry.
 *
 * Internal deployments (e.g. wecode) register a dedicated download handler for
 * knowledge-base video attachments whose binary blob is not stored locally
 * (e.g. Weibo CDN-backed videos streamed through a backend proxy). The
 * open-source core never registers a handler, so video documents fall back to
 * the standard attachment download endpoint.
 *
 * Registration happens as a side effect of loading the KB extension module
 * (see loadKBExtensions in extension-loader.ts), which dynamically imports the
 * internal @wecode/features/knowledge bundle. Open-source builds have no such
 * bundle, so the import fails silently and the registry stays empty.
 */

export type KnowledgeVideoDownloader = (attachmentId: number, filename?: string) => Promise<void>

let videoDownloader: KnowledgeVideoDownloader | null = null

/**
 * Register a knowledge video download handler. Pass null to clear.
 * Call at module load time (top-level side effect) in internal extensions.
 */
export function registerKnowledgeVideoDownloader(
  downloader: KnowledgeVideoDownloader | null
): void {
  videoDownloader = downloader
}

/**
 * Returns the registered video download handler, or null when no internal
 * extension has registered one (open-source default).
 */
export function getKnowledgeVideoDownloader(): KnowledgeVideoDownloader | null {
  return videoDownloader
}
