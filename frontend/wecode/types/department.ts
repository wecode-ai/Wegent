// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface Department {
  id: string
  name: string
  label?: string
  oid?: string
  parent_oid?: string
  supervisor?: string
  supervisor_name?: string
  employee_count?: number
}
