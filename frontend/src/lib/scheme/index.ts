// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Scheme URL System - Main Entry Point
 * Provides a unified API for the wegent:// URL scheme system
 */

// Core functionality
export { parseSchemeURL, isValidSchemeURL, buildSchemeURL } from './parser'
export {
  registerScheme,
  unregisterScheme,
  getScheme,
  getAllSchemes,
  findMatchingScheme,
} from './registry'
export { handleSchemeURL, createSchemeLinkHandler } from './handler'
export { checkAuth, withAuth } from './auth'
export { useSchemeURL } from './hooks'
export { useSchemeMessageActions } from './hooks/useSchemeMessageActions'

// Initializers
export { initializeRouteMappings } from './routes'
export { initializeFormMappings } from './forms'
export { initializeActionMappings } from './actions'
export { initializeModalMappings } from './modals'

// Components
export { SchemeLink } from './components/SchemeLink'

// Utilities
export { createSchemeAwareUrlTransform } from './utils/url-transform'

// Types
export type {
  SchemeType,
  ParsedSchemeURL,
  SchemeHandlerContext,
  SchemeHandler,
  SchemeRegistration,
  SchemeRegistry,
  SchemeURL,
  OpenSchemeURL,
  FormSchemeURL,
  ActionSchemeURL,
  ModalSchemeURL,
} from './types'
export type { SchemeMessageActionsConfig } from './hooks/useSchemeMessageActions'
export type { SchemeLinkProps } from './components/SchemeLink'

/**
 * Initializes the entire scheme URL system
 * Call this once during app initialization
 */
export function initializeSchemeSystem(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { initializeRouteMappings } = require('./routes')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { initializeFormMappings } = require('./forms')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { initializeActionMappings } = require('./actions')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { initializeModalMappings } = require('./modals')

  initializeRouteMappings()
  initializeFormMappings()
  initializeActionMappings()
  initializeModalMappings()

  console.log('[SchemeURL] Scheme URL system initialized')
}
