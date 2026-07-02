// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export const INTERACTIVE_FORM_TYPE = 'interactive_form_question'
export const REQUEST_USER_INPUT_KIND = 'request_user_input'

const INTERACTIVE_FORM_TOOL_MARKERS = [
  INTERACTIVE_FORM_TYPE,
  'ask_user_question',
  REQUEST_USER_INPUT_KIND,
]

const INTERACTIVE_FORM_TOOL_COMPACT_MARKERS = [
  'interactiveformquestion',
  'askuserquestion',
  'requestuserinput',
]

export const isInteractiveFormToolName = (value: unknown): boolean => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!normalized) return false

  if (INTERACTIVE_FORM_TOOL_MARKERS.some(marker => normalized.includes(marker))) {
    return true
  }

  const compact = normalized.replace(/[^a-z0-9]+/g, '')
  return INTERACTIVE_FORM_TOOL_COMPACT_MARKERS.some(marker => compact.includes(marker))
}
