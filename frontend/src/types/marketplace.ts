// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface MarketplaceTag {
  id: string
  name_zh: string
  name_en: string
  sort: number
  enabled: boolean
}

export interface MarketplaceTagsResponse {
  version: number
  items: MarketplaceTag[]
}

export interface MarketplaceTagsUpdate {
  expected_version: number
  items: MarketplaceTag[]
}
