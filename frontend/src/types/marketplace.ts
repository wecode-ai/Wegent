// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// Marketplace types for Agent Marketplace feature

export type MarketplaceCategory =
  | 'development'
  | 'office'
  | 'creative'
  | 'data_analysis'
  | 'education'
  | 'other'

export type InstallMode = 'reference' | 'copy'

// Marketplace team list item
export interface MarketplaceTeam {
  id: number
  team_id: number
  name: string
  category: string
  description: string | null
  icon: string | null
  allow_reference: boolean
  allow_copy: boolean
  install_count: number
  is_active: boolean
  published_at: string | null
  bind_mode: ('chat' | 'code')[] | null
  agent_type: string | null
  bots_count: number
  is_installed: boolean
  installed_mode: InstallMode | null
}

// Marketplace team detail
export interface MarketplaceTeamDetail extends MarketplaceTeam {
  team_data: Record<string, unknown> | null
  bots:
    | {
        id: number
        name: string
        role: string
        prompt: string
      }[]
    | null
}

// Category item
export interface CategoryItem {
  value: string
  label: string
  count: number
}

// Installed team record
export interface InstalledTeam {
  id: number
  user_id: number
  marketplace_team_id: number
  install_mode: InstallMode
  copied_team_id: number | null
  is_active: boolean
  installed_at: string
  uninstalled_at: string | null
  marketplace_team: MarketplaceTeam | null
}

// API Response types
export interface MarketplaceTeamListResponse {
  total: number
  items: MarketplaceTeam[]
}

export interface CategoryListResponse {
  categories: CategoryItem[]
}

export interface InstalledTeamListResponse {
  total: number
  items: InstalledTeam[]
}

export interface InstallTeamRequest {
  mode: InstallMode
}

export interface InstallTeamResponse {
  success: boolean
  message: string
  installed_team_id: number
  install_mode: InstallMode
  copied_team_id: number | null
}

export interface UninstallTeamResponse {
  success: boolean
  message: string
}
