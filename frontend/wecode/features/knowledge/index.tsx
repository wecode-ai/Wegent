// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Wecode knowledge base extensions.
 *
 * Registers the org_department auth section for ERP department-based
 * knowledge base authorization. Imported as a side-effect module.
 */

import { useState } from 'react'
import { Building2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { registerAuthSection } from '@/features/knowledge/document/auth-section-registry'
import { registerPermissionTab } from '@/features/knowledge/permission/permission-tab-registry'
import { DepartmentAuthSearch, AddDepartmentDialog } from '@wecode/components/department-auth'
import { knowledgePermissionExtensionApi } from '@wecode/apis/knowledge-permission-extension'

// Register department auth section in KB creation dialog
registerAuthSection({
  type: 'org_department',
  labelKey: 'document.permission.orgDepartment',
  renderSearch: ({ role, onSelect }) => <DepartmentAuthSearch role={role} onSelect={onSelect} />,
})

function DepartmentAddButton({ kbId, onSuccess }: { kbId: number; onSuccess: () => void }) {
  const { t } = useTranslation('knowledge')
  const [open, setOpen] = useState(false)
  const label = t('document.permission.addDepartmentButton') || '添加部门'
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Building2 className="w-4 h-4 mr-2" />
        {label}
      </Button>
      <AddDepartmentDialog
        open={open}
        onOpenChange={setOpen}
        resourceType="KnowledgeBase"
        resourceId={kbId}
        apiCaller={knowledgePermissionExtensionApi.batchAddDepartmentPermission}
        onSuccess={onSuccess}
      />
    </>
  )
}

// Register department permission tab in KB permission management
registerPermissionTab({
  type: 'org_department',
  labelKey: 'document.permission.orgDepartment',
  icon: <Building2 className="w-4 h-4" />,
  filter: user => user.entity_type === 'org_department',
  renderAddButton: ({ kbId, onSuccess }) => (
    <DepartmentAddButton kbId={kbId} onSuccess={onSuccess} />
  ),
})
