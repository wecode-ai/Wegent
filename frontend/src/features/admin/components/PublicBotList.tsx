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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Bot, Loader2 } from 'lucide-react'
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
  AdminPublicBot,
  AdminPublicBotCreate,
  AdminPublicBotUpdate,
  AdminPublicGhost,
  AdminPublicShell,
  AdminPublicModel,
} from '@/apis/admin'
import UnifiedAddButton from '@/components/common/UnifiedAddButton'

// Special value for "None" selection
const NONE_VALUE = '__none__'

const PublicBotList: React.FC = () => {
  const { t } = useTranslation('admin')
  const { toast } = useToast()
  const [bots, setBots] = useState<AdminPublicBot[]>([])
  const [_total, setTotal] = useState(0)
  const [page, _setPage] = useState(1)
  const [loading, setLoading] = useState(true)

  // Available resources for selection
  const [ghosts, setGhosts] = useState<AdminPublicGhost[]>([])
  const [shells, setShells] = useState<AdminPublicShell[]>([])
  const [models, setModels] = useState<AdminPublicModel[]>([])
  const [loadingResources, setLoadingResources] = useState(false)

  // Dialog states
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [selectedBot, setSelectedBot] = useState<AdminPublicBot | null>(null)

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

  const fetchBots = useCallback(async () => {
    setLoading(true)
    try {
      const response = await adminApis.getPublicBots(page, 100)
      setBots(response.items)
      setTotal(response.total)
    } catch (_error) {
      toast({
        variant: 'destructive',
        title: t('public_bots.errors.load_failed'),
      })
    } finally {
      setLoading(false)
    }
  }, [page, toast, t])

  // Fetch available resources (ghosts, shells, models)
  const fetchResources = useCallback(async () => {
    setLoadingResources(true)
    try {
      const [ghostsRes, shellsRes, modelsRes] = await Promise.all([
        adminApis.getPublicGhosts(1, 100),
        adminApis.getPublicShells(1, 100),
        adminApis.getPublicModels(1, 100),
      ])
      // Only show active resources
      setGhosts(ghostsRes.items.filter(g => g.is_active))
      setShells(shellsRes.items.filter(s => s.is_active))
      setModels(modelsRes.items.filter(m => m.is_active))
    } catch (_error) {
      // Silently fail - resources are optional
      console.error('Failed to load resources:', _error)
    } finally {
      setLoadingResources(false)
    }
  }, [])

  useEffect(() => {
    fetchBots()
  }, [fetchBots])

  // Load resources when dialog opens
  useEffect(() => {
    if (isCreateDialogOpen || isEditDialogOpen) {
      fetchResources()
    }
  }, [isCreateDialogOpen, isEditDialogOpen, fetchResources])

  const validateConfig = (value: string): Record<string, unknown> | null => {
    if (!value.trim()) {
      setConfigError(t('public_bots.errors.config_required'))
      return null
    }
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setConfigError(t('public_bots.errors.config_invalid_json'))
        return null
      }
      setConfigError('')
      return parsed as Record<string, unknown>
    } catch {
      setConfigError(t('public_bots.errors.config_invalid_json'))
      return null
    }
  }

  // Extract refs from config
  const extractRefsFromConfig = (
    configStr: string
  ): { ghostRef: string; shellRef: string; modelRef: string } => {
    try {
      const config = JSON.parse(configStr)
      const spec = (config.spec as Record<string, unknown>) || {}
      return {
        ghostRef: (spec.ghostRef as string) || '',
        shellRef: (spec.shellRef as string) || '',
        modelRef: (spec.modelRef as string) || '',
      }
    } catch {
      return { ghostRef: '', shellRef: '', modelRef: '' }
    }
  }

  // Update config with new ref value
  const updateConfigWithRef = (
    configStr: string,
    refKey: 'ghostRef' | 'shellRef' | 'modelRef',
    refValue: string
  ): string => {
    try {
      const config = JSON.parse(configStr)
      if (!config.spec || typeof config.spec !== 'object') {
        config.spec = {}
      }
      if (refValue && refValue !== NONE_VALUE) {
        config.spec[refKey] = refValue
      } else {
        delete config.spec[refKey]
      }
      return JSON.stringify(config, null, 2)
    } catch {
      // If config is invalid, return as-is
      return configStr
    }
  }

  // Handle selector change - update config
  const handleRefChange = (refKey: 'ghostRef' | 'shellRef' | 'modelRef', value: string) => {
    const newConfig = updateConfigWithRef(
      formData.config,
      refKey,
      value === NONE_VALUE ? '' : value
    )
    setFormData({ ...formData, config: newConfig })
    validateConfig(newConfig)
  }

  const handleCreateBot = async () => {
    if (!formData.name.trim()) {
      toast({
        variant: 'destructive',
        title: t('public_bots.errors.name_required'),
      })
      return
    }

    const config = validateConfig(formData.config)
    if (!config) {
      toast({
        variant: 'destructive',
        title: t('public_bots.errors.config_invalid_json'),
      })
      return
    }

    setSaving(true)
    try {
      const createData: AdminPublicBotCreate = {
        name: formData.name.trim(),
        namespace: formData.namespace.trim() || 'default',
        json: config,
      }
      await adminApis.createPublicBot(createData)
      toast({ title: t('public_bots.success.created') })
      setIsCreateDialogOpen(false)
      resetForm()
      fetchBots()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('public_bots.errors.create_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const handleUpdateBot = async () => {
    if (!selectedBot) return

    // Trim and validate name
    const trimmedName = formData.name.trim()
    const trimmedNamespace = formData.namespace.trim()

    if (!trimmedName) {
      toast({
        variant: 'destructive',
        title: t('public_bots.errors.name_required'),
      })
      return
    }

    const config = validateConfig(formData.config)
    if (!config) {
      toast({
        variant: 'destructive',
        title: t('public_bots.errors.config_invalid_json'),
      })
      return
    }

    setSaving(true)
    try {
      const updateData: AdminPublicBotUpdate = {}
      if (trimmedName !== selectedBot.name) {
        updateData.name = trimmedName
      }
      if (trimmedNamespace !== selectedBot.namespace) {
        updateData.namespace = trimmedNamespace || 'default'
      }
      updateData.json = config
      if (formData.is_active !== selectedBot.is_active) {
        updateData.is_active = formData.is_active
      }

      await adminApis.updatePublicBot(selectedBot.id, updateData)
      toast({ title: t('public_bots.success.updated') })
      setIsEditDialogOpen(false)
      resetForm()
      fetchBots()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('public_bots.errors.update_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteBot = async () => {
    if (!selectedBot) return

    setSaving(true)
    try {
      await adminApis.deletePublicBot(selectedBot.id)
      toast({ title: t('public_bots.success.deleted') })
      setIsDeleteDialogOpen(false)
      setSelectedBot(null)
      fetchBots()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('public_bots.errors.delete_failed'),
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
    setSelectedBot(null)
  }

  const openEditDialog = (bot: AdminPublicBot) => {
    setSelectedBot(bot)
    setFormData({
      name: bot.name,
      namespace: bot.namespace,
      config: JSON.stringify(bot.json, null, 2),
      is_active: bot.is_active,
    })
    setIsEditDialogOpen(true)
  }

  const getDisplayName = (bot: AdminPublicBot): string => {
    return bot.display_name || bot.name
  }

  // Get current refs from config for selector display
  const currentRefs = extractRefsFromConfig(formData.config)

  // Render the resource selector
  const renderResourceSelector = (
    id: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
    options: { name: string; display_name: string | null; namespace: string }[],
    placeholder: string,
    noneLabel: string
  ) => (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value || NONE_VALUE} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE_VALUE}>{noneLabel}</SelectItem>
          {options.map(option => (
            <SelectItem key={option.name} value={option.name}>
              {option.display_name || option.name}
              {option.namespace !== 'default' && (
                <span className="text-text-muted ml-1">({option.namespace})</span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  return (
    <div className="space-y-3">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-text-primary mb-1">{t('public_bots.title')}</h2>
        <p className="text-sm text-text-muted">{t('public_bots.description')}</p>
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
        {!loading && bots.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Bot className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('public_bots.no_bots')}</p>
          </div>
        )}

        {/* Bot List */}
        {!loading && bots.length > 0 && (
          <div className="flex-1 overflow-y-auto space-y-3 p-1">
            {bots.map(bot => (
              <Card
                key={bot.id}
                className="p-4 bg-base hover:bg-hover transition-colors border-l-2 border-l-primary"
              >
                <div className="flex items-center justify-between min-w-0">
                  <div className="flex items-center space-x-3 min-w-0 flex-1">
                    <GlobeAltIcon className="w-5 h-5 text-primary flex-shrink-0" />
                    <div className="flex flex-col justify-center min-w-0 flex-1">
                      <div className="flex items-center space-x-2 min-w-0">
                        <h3 className="text-base font-medium text-text-primary truncate">
                          {getDisplayName(bot)}
                        </h3>
                        {bot.is_active ? (
                          <Tag variant="success">{t('public_bots.status.active')}</Tag>
                        ) : (
                          <Tag variant="error">{t('public_bots.status.inactive')}</Tag>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-text-muted flex-wrap">
                        <span>
                          {t('public_bots.form.name')}: {bot.name}
                        </span>
                        {bot.ghost_name && (
                          <>
                            <span>*</span>
                            <span>Ghost: {bot.ghost_name}</span>
                          </>
                        )}
                        {bot.shell_name && (
                          <>
                            <span>*</span>
                            <span>Shell: {bot.shell_name}</span>
                          </>
                        )}
                        {bot.model_name && (
                          <>
                            <span>*</span>
                            <span>Model: {bot.model_name}</span>
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
                      onClick={() => openEditDialog(bot)}
                      title={t('public_bots.edit_bot')}
                    >
                      <PencilIcon className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 hover:text-error"
                      onClick={() => {
                        setSelectedBot(bot)
                        setIsDeleteDialogOpen(true)
                      }}
                      title={t('public_bots.delete_bot')}
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
                {t('public_bots.create_bot')}
              </UnifiedAddButton>
            </div>
          </div>
        )}
      </div>

      {/* Create Bot Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('public_bots.create_bot')}</DialogTitle>
            <DialogDescription>{t('public_bots.create_description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('public_bots.form.name')} *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={e => setFormData({ ...formData, name: e.target.value })}
                placeholder={t('public_bots.form.name_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="namespace">{t('public_bots.form.namespace')}</Label>
              <Input
                id="namespace"
                value={formData.namespace}
                onChange={e => setFormData({ ...formData, namespace: e.target.value })}
                placeholder={t('public_bots.form.namespace_placeholder')}
              />
            </div>

            {/* Resource Selectors */}
            {loadingResources ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                <span className="text-sm text-text-muted">{t('common.loading')}</span>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {renderResourceSelector(
                  'ghost',
                  t('public_bots.form.ghost'),
                  currentRefs.ghostRef,
                  value => handleRefChange('ghostRef', value),
                  ghosts,
                  t('public_bots.form.ghost_placeholder'),
                  t('public_bots.form.ghost_none')
                )}
                {renderResourceSelector(
                  'shell',
                  t('public_bots.form.shell'),
                  currentRefs.shellRef,
                  value => handleRefChange('shellRef', value),
                  shells,
                  t('public_bots.form.shell_placeholder'),
                  t('public_bots.form.shell_none')
                )}
                {renderResourceSelector(
                  'model',
                  t('public_bots.form.model'),
                  currentRefs.modelRef,
                  value => handleRefChange('modelRef', value),
                  models,
                  t('public_bots.form.model_placeholder'),
                  t('public_bots.form.model_none')
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="config">{t('public_bots.form.config')} *</Label>
              <Textarea
                id="config"
                value={formData.config}
                onChange={e => {
                  setFormData({ ...formData, config: e.target.value })
                  validateConfig(e.target.value)
                }}
                placeholder={t('public_bots.form.config_placeholder')}
                className={`font-mono text-sm min-h-[200px] ${configError ? 'border-error' : ''}`}
              />
              {configError && <p className="text-xs text-error">{configError}</p>}
              <p className="text-xs text-text-muted">{t('public_bots.form.config_hint')}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleCreateBot} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Bot Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('public_bots.edit_bot')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">{t('public_bots.form.name')}</Label>
              <Input
                id="edit-name"
                value={formData.name}
                onChange={e => setFormData({ ...formData, name: e.target.value })}
                placeholder={t('public_bots.form.name_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-namespace">{t('public_bots.form.namespace')}</Label>
              <Input
                id="edit-namespace"
                value={formData.namespace}
                onChange={e => setFormData({ ...formData, namespace: e.target.value })}
                placeholder={t('public_bots.form.namespace_placeholder')}
              />
            </div>

            {/* Resource Selectors */}
            {loadingResources ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                <span className="text-sm text-text-muted">{t('common.loading')}</span>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {renderResourceSelector(
                  'edit-ghost',
                  t('public_bots.form.ghost'),
                  currentRefs.ghostRef,
                  value => handleRefChange('ghostRef', value),
                  ghosts,
                  t('public_bots.form.ghost_placeholder'),
                  t('public_bots.form.ghost_none')
                )}
                {renderResourceSelector(
                  'edit-shell',
                  t('public_bots.form.shell'),
                  currentRefs.shellRef,
                  value => handleRefChange('shellRef', value),
                  shells,
                  t('public_bots.form.shell_placeholder'),
                  t('public_bots.form.shell_none')
                )}
                {renderResourceSelector(
                  'edit-model',
                  t('public_bots.form.model'),
                  currentRefs.modelRef,
                  value => handleRefChange('modelRef', value),
                  models,
                  t('public_bots.form.model_placeholder'),
                  t('public_bots.form.model_none')
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="edit-config">{t('public_bots.form.config')}</Label>
              <Textarea
                id="edit-config"
                value={formData.config}
                onChange={e => {
                  setFormData({ ...formData, config: e.target.value })
                  validateConfig(e.target.value)
                }}
                placeholder={t('public_bots.form.config_placeholder')}
                className={`font-mono text-sm min-h-[200px] ${configError ? 'border-error' : ''}`}
              />
              {configError && <p className="text-xs text-error">{configError}</p>}
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-is-active">{t('public_bots.columns.status')}</Label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-muted">
                  {formData.is_active
                    ? t('public_bots.status.active')
                    : t('public_bots.status.inactive')}
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
            <Button onClick={handleUpdateBot} disabled={saving}>
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
            <AlertDialogTitle>{t('public_bots.confirm.delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('public_bots.confirm.delete_message', { name: selectedBot?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteBot} className="bg-error hover:bg-error/90">
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default PublicBotList
