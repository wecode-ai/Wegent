// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import { LayoutTemplate, Loader2 } from 'lucide-react'
import { PencilIcon, TrashIcon } from '@heroicons/react/24/outline'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { adminApis, AdminTemplate } from '@/apis/admin'
import UnifiedAddButton from '@/components/common/UnifiedAddButton'
import TemplateEditDialog from './TemplateEditDialog'

const TemplateList: React.FC = () => {
  const { t } = useTranslation('admin')
  const { toast } = useToast()
  const [templates, setTemplates] = useState<AdminTemplate[]>([])
  const [loading, setLoading] = useState(true)

  // Dialog states
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState<AdminTemplate | null>(null)
  const [deleting, setDeleting] = useState(false)

  const fetchTemplates = useCallback(async () => {
    setLoading(true)
    try {
      const response = await adminApis.getTemplates()
      setTemplates(response.items)
    } catch (_error) {
      toast({
        variant: 'destructive',
        title: t('templates.errors.load_failed'),
      })
    } finally {
      setLoading(false)
    }
  }, [toast, t])

  useEffect(() => {
    fetchTemplates()
  }, [fetchTemplates])

  const handleDeleteTemplate = async () => {
    if (!selectedTemplate) return

    setDeleting(true)
    try {
      await adminApis.deleteTemplate(selectedTemplate.id)
      toast({ title: t('templates.success.deleted') })
      setIsDeleteDialogOpen(false)
      setSelectedTemplate(null)
      fetchTemplates()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('templates.errors.delete_failed'),
        description: (error as Error).message,
      })
    } finally {
      setDeleting(false)
    }
  }

  const openCreateDialog = () => {
    setSelectedTemplate(null)
    setIsEditDialogOpen(true)
  }

  const openEditDialog = (template: AdminTemplate) => {
    setSelectedTemplate(template)
    setIsEditDialogOpen(true)
  }

  const handleDialogClose = () => {
    setIsEditDialogOpen(false)
    setSelectedTemplate(null)
  }

  const handleDialogSuccess = () => {
    fetchTemplates()
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-text-primary mb-1">{t('templates.title')}</h2>
        <p className="text-sm text-text-muted">{t('templates.description')}</p>
      </div>

      {/* Content Container */}
      <div className="bg-base border border-border rounded-md p-2 w-full max-h-[70vh] flex flex-col overflow-y-auto">
        {/* Loading State */}
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
          </div>
        )}

        {/* Empty State */}
        {!loading && templates.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <LayoutTemplate className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('templates.no_templates')}</p>
          </div>
        )}

        {/* Template List */}
        {!loading && templates.length > 0 && (
          <div className="flex-1 overflow-y-auto space-y-3 p-1">
            {templates.map(template => (
              <Card
                key={template.id}
                className="p-4 bg-base hover:bg-hover transition-colors border-l-2 border-l-primary"
              >
                <div className="flex items-center justify-between min-w-0">
                  <div className="flex items-center space-x-3 min-w-0 flex-1">
                    {/* Icon */}
                    <div className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-md bg-primary/10 text-xl">
                      {template.icon ? (
                        <span>{template.icon}</span>
                      ) : (
                        <LayoutTemplate className="w-5 h-5 text-primary" />
                      )}
                    </div>

                    <div className="flex flex-col justify-center min-w-0 flex-1">
                      <div className="flex items-center space-x-2 min-w-0 flex-wrap gap-y-1">
                        <h3 className="text-base font-medium text-text-primary truncate">
                          {template.displayName}
                        </h3>
                        <Tag variant="default">{template.category}</Tag>
                        {template.tags.map(tag => (
                          <Tag key={tag} variant="info">
                            {tag}
                          </Tag>
                        ))}
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-text-muted">
                        <span>
                          {t('templates.form.name')}: {template.name}
                        </span>
                        {template.description && (
                          <>
                            <span>·</span>
                            <span className="truncate max-w-[300px]">{template.description}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div className="flex items-center gap-1 flex-shrink-0 ml-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => openEditDialog(template)}
                      title={t('templates.edit_template')}
                      data-testid={`edit-template-${template.id}`}
                    >
                      <PencilIcon className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 hover:text-error"
                      onClick={() => {
                        setSelectedTemplate(template)
                        setIsDeleteDialogOpen(true)
                      }}
                      title={t('templates.delete_template')}
                      data-testid={`delete-template-${template.id}`}
                    >
                      <TrashIcon className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        {/* Add Button */}
        {!loading && (
          <div className="border-t border-border pt-3 mt-3 bg-base">
            <div className="flex justify-center">
              <UnifiedAddButton onClick={openCreateDialog} data-testid="create-template-button">
                {t('templates.create_template')}
              </UnifiedAddButton>
            </div>
          </div>
        )}
      </div>

      {/* Create/Edit Template Dialog */}
      <TemplateEditDialog
        open={isEditDialogOpen}
        onClose={handleDialogClose}
        editingTemplate={selectedTemplate}
        onSuccess={handleDialogSuccess}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('templates.confirm.delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('templates.confirm.delete_message', {
                name: selectedTemplate?.displayName ?? selectedTemplate?.name,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteTemplate}
              className="bg-error hover:bg-error/90"
              data-testid="confirm-delete-button"
            >
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default TemplateList
