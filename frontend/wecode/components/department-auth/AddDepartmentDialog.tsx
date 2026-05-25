// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { Building2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/hooks/useTranslation'
import {
  AddDepartmentForm,
  type DepartmentBatchInput,
  type DepartmentBatchResponse,
} from './AddDepartmentForm'

export type {
  DepartmentBatchInput,
  DepartmentBatchFailed,
  DepartmentBatchResponse,
} from './AddDepartmentForm'

interface AddDepartmentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  resourceType: 'KnowledgeBase' | 'Namespace' | 'Team'
  resourceId: number
  apiCaller: (
    resourceId: number,
    departments: DepartmentBatchInput[],
    role: string
  ) => Promise<DepartmentBatchResponse>
  onSuccess?: () => void
}

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  KnowledgeBase: 'document.permission.addDepartment',
  Namespace: 'groups:groups.actions.addDepartment',
  Team: 'document.permission.addDepartment',
}

export function AddDepartmentDialog({
  open,
  onOpenChange,
  resourceType,
  resourceId,
  apiCaller,
  onSuccess,
}: AddDepartmentDialogProps) {
  const { t } = useTranslation('knowledge')
  const [loading, setLoading] = useState(false)

  const titleKey = RESOURCE_TYPE_LABELS[resourceType] || 'document.permission.addDepartment'

  const handleSubmit = async (
    departments: DepartmentBatchInput[],
    role: string
  ): Promise<DepartmentBatchResponse> => {
    setLoading(true)
    try {
      return await apiCaller(resourceId, departments, role)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (loading && !next) return
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="w-5 h-5" />
            {t(titleKey)}
          </DialogTitle>
        </DialogHeader>

        <AddDepartmentForm
          onSubmit={handleSubmit}
          onSuccess={() => {
            onSuccess?.()
            onOpenChange(false)
          }}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
