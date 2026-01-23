// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime'

/**
 * Scheme URL Types
 * Type definitions for the wegent:// URL scheme system
 */

export type SchemeType = 'open' | 'action' | 'form' | 'modal'

export interface ParsedSchemeURL {
  scheme: string // e.g., 'wegent'
  type: SchemeType // e.g., 'open', 'action', 'form', 'modal'
  path: string // e.g., 'chat', 'send-message', 'create-task'
  params: Record<string, string | string[]>
}

export interface SchemeHandlerContext {
  url: string
  parsed: ParsedSchemeURL
  params: Record<string, string | string[]> // Shortcut for parsed.params
  router: AppRouterInstance // Next.js router
  user?: unknown // User context if authenticated
}

export type SchemeHandler = (context: SchemeHandlerContext) => Promise<void> | void

export interface SchemeRegistration {
  pattern: string // e.g., 'wegent://open/{page}'
  handler: SchemeHandler
  requireAuth?: boolean
  description?: string
  examples?: string[]
}

export interface SchemeRegistry {
  [key: string]: SchemeRegistration
}

// Scheme URL type definitions for TypeScript autocompletion
export type OpenSchemeURL =
  | 'wegent://open/chat'
  | `wegent://open/chat?team=${string}`
  | 'wegent://open/code'
  | `wegent://open/code?team=${string}`
  | 'wegent://open/settings'
  | `wegent://open/settings?tab=${string}`
  | 'wegent://open/knowledge'
  | `wegent://open/knowledge/${string}`
  | 'wegent://open/feed'
  | 'wegent://open/feedback'

export type FormSchemeURL =
  | 'wegent://form/create-task'
  | `wegent://form/create-task?${string}`
  | 'wegent://form/create-team'
  | 'wegent://form/create-bot'
  | 'wegent://form/add-repository'
  | 'wegent://form/create-subscription'
  | `wegent://form/create-subscription?data=${string}`

export type ActionSchemeURL =
  | `wegent://action/send-message?text=${string}&team=${string}`
  | `wegent://action/prefill-message?text=${string}`
  | `wegent://action/prefill-message?text=${string}&team=${string}`
  | `wegent://action/share?type=${string}&id=${string}`
  | `wegent://action/export-chat?taskId=${string}`
  | `wegent://action/export-task?taskId=${string}`
  | `wegent://action/export-code?taskId=${string}&fileId=${string}`

export type ModalSchemeURL =
  | 'wegent://modal/model-selector'
  | 'wegent://modal/team-selector'
  | 'wegent://modal/repository-selector'

export type SchemeURL = OpenSchemeURL | FormSchemeURL | ActionSchemeURL | ModalSchemeURL
