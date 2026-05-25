// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { GroupExtensionConfig } from '@/features/groups/extension-loader'
import { AddDepartmentForm } from './components/AddDepartmentForm'
import { DepartmentEntityList } from './components/DepartmentEntityList'

const groupExtensionConfig: GroupExtensionConfig = {
  listTabLabel: '部门',
  addTabLabel: '添加部门',
  addForm: AddDepartmentForm,
  listView: DepartmentEntityList,
}

export default groupExtensionConfig

// Also export named exports for OSS contract compatibility
export const { listTabLabel, addTabLabel, addForm, listView } = groupExtensionConfig
