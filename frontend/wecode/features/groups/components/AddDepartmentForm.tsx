// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { AddDepartmentForm as GenericAddDepartmentForm } from '@wecode/components/department-auth'
import { groupPermissionExtensionApi } from '@wecode/apis/group-permission-extension'
import type { GroupExtensionProps } from '@/features/groups/extension-loader'

export function AddDepartmentForm({ groupName, onSuccess, onCancel, userRole }: GroupExtensionProps) {
  return (
    <GenericAddDepartmentForm
      onSubmit={async (departments, role) => {
        return groupPermissionExtensionApi.batchAddGroupDepartmentPermission(
          groupName,
          departments,
          role
        )
      }}
      onSuccess={onSuccess}
      onCancel={onCancel}
      userRole={userRole}
    />
  )
}
