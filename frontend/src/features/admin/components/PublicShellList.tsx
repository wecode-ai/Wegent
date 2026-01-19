// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Terminal, Loader2 } from 'lucide-react'
import { PencilIcon, TrashIcon, GlobeAltIcon } from '@heroicons/react/24/outline'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  adminApis,
  AdminPublicShell,
  AdminPublicShellCreate,
  AdminPublicShellUpdate,
} from '@/apis/admin'
import UnifiedAddButton from '@/components/common/UnifiedAddButton'

const PublicShellList: React.FC = () => {
  const { t } = useTranslation('admin')
  const { toast } = useToast()
  const [shells, setShells] = useState<AdminPublicShell[]>([])
  const [_total, setTotal] = useState(0)
  const [page, _setPage] = useState(1)
  const [loading, setLoading] = useState(true)

  // Dialog states
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [selectedShell, setSelectedShell] = useState<AdminPublicShell | null>(null)

  // Form states
  const [formData, setFormData] = useState<{
    name: string
    namespace: string
    config: string
    is_active: boolean
  }>({
    name: '',
    namespace: 'default',
    config: '{}',
    is_active: true,
  })
  const [configError, setConfigError] = useState('')
  const [saving, setSaving] = useState(false)

  const fetchShells = useCallback(async () => {
    setLoading(true)
    try {
      const response = await adminApis.getPublicShells(page, 100)
      setShells(response.items)
      setTotal(response.total)
    } catch (_error) {
      toast({
        variant: 'destructive',
        title: t('public_shells.errors.load_failed'),
      })
    } finally {
      setLoading(false)
    }
  }, [page, toast, t])

  useEffect(() => {
    fetchShells()
  }, [fetchShells])

  const validateConfig = (value: string): Record<string, unknown> | null => {
    if (!value.trim()) {
      setConfigError(t('public_shells.errors.config_required'))
      return null
    }
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setConfigError(t('public_shells.errors.config_invalid_json'))
        return null
      }
      setConfigError('')
      return parsed as Record<string, unknown>
    } catch {
      setConfigError(t('public_shells.errors.config_invalid_json'))
      return null
    }
  }

  const handleCreateShell = async () => {
    if (!formData.name.trim()) {
      toast({
        variant: 'destructive',
        title: t('public_shells.errors.name_required'),
      })
      return
    }

    const config = validateConfig(formData.config)
    if (!config) {
      toast({
        variant: 'destructive',
        title: t('public_shells.errors.config_invalid_json'),
      })
      return
    }

    setSaving(true)
    try {
      const createData: AdminPublicShellCreate = {
        name: formData.name.trim(),
        namespace: formData.namespace.trim() || 'default',
        json: config,
      }
      await adminApis.createPublicShell(createData)
      toast({ title: t('public_shells.success.created') })
      setIsCreateDialogOpen(false)
      resetForm()
      fetchShells()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('public_shells.errors.create_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const handleUpdateShell = async () => {
    if (!selectedShell) return

    // Trim and validate name
    const trimmedName = formData.name.trim()
    const trimmedNamespace = formData.namespace.trim()

    if (!trimmedName) {
      toast({
        variant: 'destructive',
        title: t('public_shells.errors.name_required'),
      })
      return
    }

    const config = validateConfig(formData.config)
    if (!config) {
      toast({
        variant: 'destructive',
        title: t('public_shells.errors.config_invalid_json'),
      })
      return
    }

    setSaving(true)
    try {
      const updateData: AdminPublicShellUpdate = {}
      if (trimmedName !== selectedShell.name) {
        updateData.name = trimmedName
      }
      if (trimmedNamespace !== selectedShell.namespace) {
        updateData.namespace = trimmedNamespace || 'default'
      }
      updateData.json = config
      if (formData.is_active !== selectedShell.is_active) {
        updateData.is_active = formData.is_active
      }

      await adminApis.updatePublicShell(selectedShell.id, updateData)
      toast({ title: t('public_shells.success.updated') })
      setIsEditDialogOpen(false)
      resetForm()
      fetchShells()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('public_shells.errors.update_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteShell = async () => {
    if (!selectedShell) return

    setSaving(true)
    try {
      await adminApis.deletePublicShell(selectedShell.id)
      toast({ title: t('public_shells.success.deleted') })
      setIsDeleteDialogOpen(false)
      setSelectedShell(null)
      fetchShells()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('public_shells.errors.delete_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const resetForm = () => {
    setFormData({
      name: '',
      namespace: 'default',
      config: '{}',
      is_active: true,
    })
    setConfigError('')
    setSelectedShell(null)
  }

  const openEditDialog = (shell: AdminPublicShell) => {
    setSelectedShell(shell)
    setFormData({
      name: shell.name,
      namespace: shell.namespace,
      config: JSON.stringify(shell.json, null, 2),
      is_active: shell.is_active,
    })
    setIsEditDialogOpen(true)
  }

  const getDisplayName = (shell: AdminPublicShell): string => {
    return shell.display_name || shell.name
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-text-primary mb-1">{t('public_shells.title')}</h2>
        <p className="text-sm text-text-muted">{t('public_shells.description')}</p>
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
        {!loading && shells.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Terminal className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('public_shells.no_shells')}</p>
          </div>
        )}

        {/* Shell List */}
        {!loading && shells.length > 0 && (
          <div className="flex-1 overflow-y-auto space-y-3 p-1">
            {shells.map(shell => (
              <Card
                key={shell.id}
                className="p-4 bg-base hover:bg-hover transition-colors border-l-2 border-l-primary"
              >
                <div className="flex items-center justify-between min-w-0">
                  <div className="flex items-center space-x-3 min-w-0 flex-1">
                    <GlobeAltIcon className="w-5 h-5 text-primary flex-shrink-0" />
                    <div className="flex flex-col justify-center min-w-0 flex-1">
                      <div className="flex items-center space-x-2 min-w-0">
                        <h3 className="text-base font-medium text-text-primary truncate">
                          {getDisplayName(shell)}
                        </h3>
                        {shell.is_active ? (
                          <Tag variant="success">{t('public_shells.status.active')}</Tag>
                        ) : (
                          <Tag variant="error">{t('public_shells.status.inactive')}</Tag>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-text-muted flex-wrap">
                        <span>
                          {t('public_shells.form.name')}: {shell.name}
                        </span>
                        {shell.shell_type && (
                          <>
                            <span>*</span>
                            <span>Type: {shell.shell_type}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0 ml-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => openEditDialog(shell)}
                      title={t('public_shells.edit_shell')}
                    >
                      <PencilIcon className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 hover:text-error"
                      onClick={() => {
                        setSelectedShell(shell)
                        setIsDeleteDialogOpen(true)
                      }}
                      title={t('public_shells.delete_shell')}
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
              <UnifiedAddButton onClick={() => setIsCreateDialogOpen(true)}>
                {t('public_shells.create_shell')}
              </UnifiedAddButton>
            </div>
          </div>
        )}
      </div>

      {/* Create Shell Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('public_shells.create_shell')}</DialogTitle>
            <DialogDescription>{t('public_shells.create_description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('public_shells.form.name')} *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={e => setFormData({ ...formData, name: e.target.value })}
                placeholder={t('public_shells.form.name_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="namespace">{t('public_shells.form.namespace')}</Label>
              <Input
                id="namespace"
                value={formData.namespace}
                onChange={e => setFormData({ ...formData, namespace: e.target.value })}
                placeholder={t('public_shells.form.namespace_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="config">{t('public_shells.form.config')} *</Label>
              <Textarea
                id="config"
                value={formData.config}
                onChange={e => {
                  setFormData({ ...formData, config: e.target.value })
                  validateConfig(e.target.value)
                }}
                placeholder={t('public_shells.form.config_placeholder')}
                className={`font-mono text-sm min-h-[200px] ${configError ? 'border-error' : ''}`}
              />
              {configError && <p className="text-xs text-error">{configError}</p>}
              <p className="text-xs text-text-muted">{t('public_shells.form.config_hint')}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleCreateShell} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Shell Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('public_shells.edit_shell')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">{t('public_shells.form.name')}</Label>
              <Input
                id="edit-name"
                value={formData.name}
                onChange={e => setFormData({ ...formData, name: e.target.value })}
                placeholder={t('public_shells.form.name_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-namespace">{t('public_shells.form.namespace')}</Label>
              <Input
                id="edit-namespace"
                value={formData.namespace}
                onChange={e => setFormData({ ...formData, namespace: e.target.value })}
                placeholder={t('public_shells.form.namespace_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-config">{t('public_shells.form.config')}</Label>
              <Textarea
                id="edit-config"
                value={formData.config}
                onChange={e => {
                  setFormData({ ...formData, config: e.target.value })
                  validateConfig(e.target.value)
                }}
                placeholder={t('public_shells.form.config_placeholder')}
                className={`font-mono text-sm min-h-[200px] ${configError ? 'border-error' : ''}`}
              />
              {configError && <p className="text-xs text-error">{configError}</p>}
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-is-active">{t('public_shells.columns.status')}</Label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-muted">
                  {formData.is_active
                    ? t('public_shells.status.active')
                    : t('public_shells.status.inactive')}
                </span>
                <Switch
                  id="edit-is-active"
                  checked={formData.is_active}
                  onCheckedChange={checked => setFormData({ ...formData, is_active: checked })}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleUpdateShell} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('public_shells.confirm.delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('public_shells.confirm.delete_message', { name: selectedShell?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteShell} className="bg-error hover:bg-error/90">
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default PublicShellList
