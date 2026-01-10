// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Unified form submission components.
 */

export { default as GenericForm } from './GenericForm'
export { default as FormFieldRenderer } from './FormFieldRenderer'
export * from './fields'

// Re-export hooks if needed
export { useFormSubmission } from './hooks/useFormSubmission'
