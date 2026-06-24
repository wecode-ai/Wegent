// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tag } from '@/components/ui/tag'
import { Textarea } from '@/components/ui/textarea'
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
import UnifiedAddButton from '@/components/common/UnifiedAddButton'
import { adminApis, type AdminSystemPlugin, type PluginRuntime } from '@/apis/admin'
import { Boxes, Loader2, PackageCheck, Pencil, RefreshCw, Trash2 } from 'lucide-react'

type PluginFormData = {
  displayName: string
  description: string
  enabled: boolean
  runtime: PluginRuntime
}

function metadataId(plugin: AdminSystemPlugin): number {
  const rawId = plugin.metadata.id
  return typeof rawId === 'number' ? rawId : Number(rawId)
}

function pluginName(plugin: AdminSystemPlugin): string {
  const rawName = plugin.metadata.name
  return typeof rawName === 'string' ? rawName : String(rawName || '')
}

function componentCount(plugin: AdminSystemPlugin): number {
  const components = plugin.spec.components
  return (
    components.skills.length +
    components.commands.length +
    components.agents.length +
    components.hooks.length +
    components.mcps.length +
    components.lsps.length +
    components.monitors.length +
    components.bins.length
  )
}

const SystemPluginList: React.FC = () => {
  const { t } = useTranslation('admin')
  const { toast } = useToast()
  const [plugins, setPlugins] = useState<AdminSystemPlugin[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [selectedPlugin, setSelectedPlugin] = useState<AdminSystemPlugin | null>(null)
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [isReplaceDialogOpen, setIsReplaceDialogOpen] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [formData, setFormData] = useState<PluginFormData>({
    displayName: '',
    description: '',
    enabled: true,
    runtime: 'claudecode',
  })

  const fetchPlugins = useCallback(async () => {
    setLoading(true)
    try {
      const response = await adminApis.getSystemPlugins()
      setPlugins(response.items)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('system_plugins.errors.load_failed'),
        description: (error as Error).message,
      })
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    fetchPlugins()
  }, [fetchPlugins])

  const selectedPluginId = useMemo(() => {
    return selectedPlugin ? metadataId(selectedPlugin) : null
  }, [selectedPlugin])

  const resetUploadForm = () => {
    setSelectedFile(null)
    setFormData({
      displayName: '',
      description: '',
      enabled: true,
      runtime: 'claudecode',
    })
  }

  const openEditDialog = (plugin: AdminSystemPlugin) => {
    setSelectedPlugin(plugin)
    setFormData({
      displayName: plugin.spec.displayName,
      description: plugin.spec.description,
      enabled: plugin.spec.enabled,
      runtime: plugin.spec.runtime,
    })
    setIsEditDialogOpen(true)
  }

  const openReplaceDialog = (plugin: AdminSystemPlugin) => {
    setSelectedPlugin(plugin)
    setSelectedFile(null)
    setIsReplaceDialogOpen(true)
  }

  const handleUpload = async () => {
    if (!selectedFile) {
      toast({
        variant: 'destructive',
        title: t('system_plugins.errors.file_required'),
      })
      return
    }

    setSaving(true)
    try {
      await adminApis.uploadSystemPlugin(selectedFile, formData.enabled, formData.runtime)
      toast({ title: t('system_plugins.success.uploaded') })
      setIsUploadDialogOpen(false)
      resetUploadForm()
      fetchPlugins()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('system_plugins.errors.upload_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const handleUpdateMetadata = async () => {
    if (!selectedPlugin || selectedPluginId === null) return

    setSaving(true)
    try {
      await adminApis.updateSystemPlugin(selectedPluginId, {
        displayName: formData.displayName.trim(),
        description: formData.description.trim(),
        enabled: formData.enabled,
      })
      toast({ title: t('system_plugins.success.updated') })
      setIsEditDialogOpen(false)
      setSelectedPlugin(null)
      fetchPlugins()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('system_plugins.errors.update_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const handleToggleEnabled = async (plugin: AdminSystemPlugin, enabled: boolean) => {
    const pluginId = metadataId(plugin)
    setSaving(true)
    try {
      await adminApis.updateSystemPlugin(pluginId, { enabled })
      toast({ title: t('system_plugins.success.updated') })
      fetchPlugins()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('system_plugins.errors.update_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const handleReplacePackage = async () => {
    if (!selectedPlugin || selectedPluginId === null || !selectedFile) {
      toast({
        variant: 'destructive',
        title: t('system_plugins.errors.file_required'),
      })
      return
    }

    setSaving(true)
    try {
      await adminApis.replaceSystemPluginPackage(selectedPluginId, selectedFile)
      toast({ title: t('system_plugins.success.replaced') })
      setIsReplaceDialogOpen(false)
      setSelectedPlugin(null)
      setSelectedFile(null)
      fetchPlugins()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('system_plugins.errors.replace_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!selectedPlugin || selectedPluginId === null) return

    setSaving(true)
    try {
      await adminApis.deleteSystemPlugin(selectedPluginId)
      toast({ title: t('system_plugins.success.deleted') })
      setIsDeleteDialogOpen(false)
      setSelectedPlugin(null)
      fetchPlugins()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('system_plugins.errors.delete_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-xl font-semibold text-text-primary mb-1">
          {t('system_plugins.title')}
        </h2>
        <p className="text-sm text-text-muted">{t('system_plugins.description')}</p>
      </div>

      <div className="bg-base border border-border rounded-md p-2 w-full max-h-[70vh] flex flex-col overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
          </div>
        )}

        {!loading && plugins.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Boxes className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('system_plugins.no_plugins')}</p>
          </div>
        )}

        {!loading && plugins.length > 0 && (
          <div className="flex-1 overflow-y-auto space-y-3 p-1">
            {plugins.map(plugin => {
              const pluginId = metadataId(plugin)
              return (
                <Card
                  key={pluginId}
                  className="p-4 bg-base hover:bg-hover transition-colors border-l-2 border-l-primary"
                >
                  <div className="flex items-start justify-between gap-3 min-w-0">
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      <PackageCheck className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0 flex-wrap">
                          <h3 className="text-base font-medium text-text-primary truncate">
                            {plugin.spec.displayName || pluginName(plugin)}
                          </h3>
                          {plugin.spec.enabled ? (
                            <Tag variant="success">{t('system_plugins.status.enabled')}</Tag>
                          ) : (
                            <Tag variant="error">{t('system_plugins.status.disabled')}</Tag>
                          )}
                          <Tag variant="info">
                            {t(`system_plugins.runtime.${plugin.spec.runtime}`)}
                          </Tag>
                          {plugin.spec.version && (
                            <Tag variant="info">
                              {t('system_plugins.version', { version: plugin.spec.version })}
                            </Tag>
                          )}
                        </div>
                        <p className="mt-1 text-sm text-text-secondary line-clamp-2">
                          {plugin.spec.description || t('system_plugins.no_description')}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 mt-2 text-xs text-text-muted">
                          <span>
                            {t('system_plugins.fields.name')}: {pluginName(plugin)}
                          </span>
                          <span>*</span>
                          <span>
                            {t('system_plugins.fields.components')}: {componentCount(plugin)}
                          </span>
                          {plugin.spec.packageRef && (
                            <>
                              <span>*</span>
                              <span>
                                {t('system_plugins.fields.package_size')}:{' '}
                                {Math.ceil(plugin.spec.packageRef.sizeBytes / 1024)} KB
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <Switch
                        checked={plugin.spec.enabled}
                        disabled={saving}
                        onCheckedChange={checked => handleToggleEnabled(plugin, checked)}
                        aria-label={t('system_plugins.actions.toggle')}
                        data-testid={`system-plugin-enabled-${pluginId}`}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => openEditDialog(plugin)}
                        title={t('system_plugins.actions.edit')}
                        data-testid={`system-plugin-edit-${pluginId}`}
                      >
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => openReplaceDialog(plugin)}
                        title={t('system_plugins.actions.replace_package')}
                        data-testid={`system-plugin-replace-${pluginId}`}
                      >
                        <RefreshCw className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 hover:text-error"
                        onClick={() => {
                          setSelectedPlugin(plugin)
                          setIsDeleteDialogOpen(true)
                        }}
                        title={t('system_plugins.actions.delete')}
                        data-testid={`system-plugin-delete-${pluginId}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </Card>
              )
            })}
          </div>
        )}

        {!loading && (
          <div className="border-t border-border pt-3 mt-3 bg-base">
            <div className="flex justify-center">
              <UnifiedAddButton
                onClick={() => {
                  resetUploadForm()
                  setIsUploadDialogOpen(true)
                }}
                data-testid="system-plugin-upload-button"
              >
                {t('system_plugins.actions.upload')}
              </UnifiedAddButton>
            </div>
          </div>
        )}
      </div>

      <Dialog open={isUploadDialogOpen} onOpenChange={setIsUploadDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('system_plugins.upload.title')}</DialogTitle>
            <DialogDescription>{t('system_plugins.upload.description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="system-plugin-file">{t('system_plugins.fields.zip_file')} *</Label>
              <Input
                id="system-plugin-file"
                type="file"
                accept=".zip,application/zip"
                onChange={event => setSelectedFile(event.target.files?.[0] || null)}
                data-testid="system-plugin-file-input"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="system-plugin-runtime">{t('system_plugins.fields.runtime')}</Label>
              <select
                id="system-plugin-runtime"
                value={formData.runtime}
                onChange={event =>
                  setFormData(prev => ({
                    ...prev,
                    runtime: event.target.value as PluginRuntime,
                  }))
                }
                className="h-10 w-full rounded-md border border-border bg-base px-3 text-sm text-text-primary"
                data-testid="system-plugin-runtime-select"
              >
                <option value="claudecode">{t('system_plugins.runtime.claudecode')}</option>
                <option value="codex">{t('system_plugins.runtime.codex')}</option>
              </select>
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="system-plugin-enabled">{t('system_plugins.fields.enabled')}</Label>
              <Switch
                id="system-plugin-enabled"
                checked={formData.enabled}
                onCheckedChange={checked => setFormData(prev => ({ ...prev, enabled: checked }))}
                data-testid="system-plugin-upload-enabled-switch"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsUploadDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={handleUpload}
              disabled={saving}
              data-testid="system-plugin-upload-submit"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {t('system_plugins.actions.upload')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('system_plugins.edit.title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="system-plugin-display-name">
                {t('system_plugins.fields.display_name')}
              </Label>
              <Input
                id="system-plugin-display-name"
                value={formData.displayName}
                onChange={event =>
                  setFormData(prev => ({ ...prev, displayName: event.target.value }))
                }
                data-testid="system-plugin-display-name-input"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="system-plugin-description">
                {t('system_plugins.fields.description')}
              </Label>
              <Textarea
                id="system-plugin-description"
                value={formData.description}
                onChange={event =>
                  setFormData(prev => ({ ...prev, description: event.target.value }))
                }
                className="min-h-[120px]"
                data-testid="system-plugin-description-input"
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="system-plugin-edit-enabled">
                {t('system_plugins.fields.enabled')}
              </Label>
              <Switch
                id="system-plugin-edit-enabled"
                checked={formData.enabled}
                onCheckedChange={checked => setFormData(prev => ({ ...prev, enabled: checked }))}
                data-testid="system-plugin-edit-enabled-switch"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={handleUpdateMetadata}
              disabled={saving}
              data-testid="system-plugin-edit-submit"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isReplaceDialogOpen} onOpenChange={setIsReplaceDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('system_plugins.replace.title')}</DialogTitle>
            <DialogDescription>
              {t('system_plugins.replace.description', {
                name: selectedPlugin
                  ? selectedPlugin.spec.displayName || pluginName(selectedPlugin)
                  : '',
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <Label htmlFor="system-plugin-replace-file">
              {t('system_plugins.fields.zip_file')} *
            </Label>
            <Input
              id="system-plugin-replace-file"
              type="file"
              accept=".zip,application/zip"
              onChange={event => setSelectedFile(event.target.files?.[0] || null)}
              data-testid="system-plugin-replace-file-input"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsReplaceDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={handleReplacePackage}
              disabled={saving}
              data-testid="system-plugin-replace-submit"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {t('system_plugins.actions.replace_package')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('system_plugins.delete.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('system_plugins.delete.description', {
                name: selectedPlugin
                  ? selectedPlugin.spec.displayName || pluginName(selectedPlugin)
                  : '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-error hover:bg-error/90">
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default SystemPluginList
