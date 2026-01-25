// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Type definitions for input parameters used in share/rent functionality.
 */

export type InputParameterType = 'text' | 'textarea' | 'select'

export interface InputParameter {
  name: string
  label: string
  type: InputParameterType
  options?: string[] // Only for select type
}

export interface InputParametersResponse {
  parameters: InputParameter[]
}
