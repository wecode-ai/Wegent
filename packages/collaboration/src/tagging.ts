// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

export const MAX_TAG_LENGTH = 32
export const MAX_TAGS_PER_ITEM = 20

export function hasTooManyTags(tags: string[]): boolean {
  return new Set(tags).size > MAX_TAGS_PER_ITEM
}

// Count Unicode code points, matching Python len() and Rust chars().count().
export function isTagNameTooLong(value: string): boolean {
  return Array.from(value.trim()).length > MAX_TAG_LENGTH
}
