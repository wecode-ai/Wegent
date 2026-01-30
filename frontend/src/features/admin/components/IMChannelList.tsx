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
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  ChatBubbleLeftRightIcon,
  PencilIcon,
  TrashIcon,
  ArrowPathIcon,
  SignalIcon,
  SignalSlashIcon,
} from '@heroicons/react/24/outline'
import { Loader2 } from 'lucide-react'
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
  IMChannel,
  IMChannelCreate,
  IMChannelUpdate,
  IMChannelType,
  IMChannelStatus,
  AdminPublicTeam,
  AdminPublicModel,
  AdminPublicBot,
} from '@/apis/admin'
import UnifiedAddButton from '@/components/common/UnifiedAddButton'

const IMChannelList: React.FC = () => {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [channels, setChannels] = useState<IMChannel[]>([])
  const [teams, setTeams] = useState<AdminPublicTeam[]>([])
  const [models, setModels] = useState<AdminPublicModel[]>([])
  const [bots, setBots] = useState<AdminPublicBot[]>([])
  const [_total, setTotal] = useState(0)
  const [page, _setPage] = useState(1)
  const [loading, setLoading] = useState(true)

  // Status tracking for each channel
  const [channelStatuses, setChannelStatuses] = useState<Record<number, IMChannelStatus>>({})

  // Dialog states
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [selectedChannel, setSelectedChannel] = useState<IMChannel | null>(null)

  // Form states
  const [formData, setFormData] = useState<{
    name: string
    channel_type: IMChannelType
    is_enabled: boolean
    default_team_id: number
    default_model_name: string
    client_id: string
    client_secret: string
  }>({
    name: '',
    channel_type: 'dingtalk',
    is_enabled: true,
    default_team_id: 0,
    default_model_name: '',
    client_id: '',
    client_secret: '',
  })
  const [saving, setSaving] = useState(false)

  const fetchChannels = useCallback(async () => {
    setLoading(true)
    try {
      const response = await adminApis.getIMChannels(page, 100)
      setChannels(response.items)
      setTotal(response.total)

      // Fetch status for enabled channels
      const statusPromises = response.items
        .filter(ch => ch.is_enabled)
        .map(async ch => {
          try {
            const status = await adminApis.getIMChannelStatus(ch.id)
            return { id: ch.id, status }
          } catch {
            return {
              id: ch.id,
              status: {
                id: ch.id,
                name: ch.name,
                channel_type: ch.channel_type,
                is_enabled: ch.is_enabled,
                is_connected: false,
                last_error: 'Failed to get status',
                uptime_seconds: null,
                extra_info: null,
              } as IMChannelStatus,
            }
          }
        })

      const statuses = await Promise.all(statusPromises)
      const statusMap: Record<number, IMChannelStatus> = {}
      statuses.forEach(s => {
        statusMap[s.id] = s.status
      })
      setChannelStatuses(statusMap)
    } catch (_error) {
      toast({
        variant: 'destructive',
        title: t('admin:im_channels.errors.load_failed'),
      })
    } finally {
      setLoading(false)
    }
  }, [page, toast, t])

  const fetchTeams = useCallback(async () => {
    try {
      // Only fetch chat-type teams for IM channel selection
      const response = await adminApis.getPublicTeams(1, 100, true)
      setTeams(response.items.filter(team => team.is_active))
    } catch {
      // Silently fail, teams are optional
    }
  }, [])

  const fetchModels = useCallback(async () => {
    try {
      const response = await adminApis.getPublicModels(1, 100)
      setModels(response.items.filter(model => model.is_active))
    } catch {
      // Silently fail, models are optional
    }
  }, [])

  const fetchBots = useCallback(async () => {
    try {
      const response = await adminApis.getPublicBots(1, 100)
      setBots(response.items.filter(bot => bot.is_active))
    } catch {
      // Silently fail, bots are optional
    }
  }, [])

  // Check if a team has any bot with model configured
  const teamHasModel = useCallback(
    (teamId: number): boolean => {
      const team = teams.find(t => t.id === teamId)
      if (!team) return false

      // Get member bot refs from team's json spec
      // botRef is an object: { name: string, namespace: string }
      type BotRef = { name: string; namespace?: string }
      type TeamMember = { botRef?: BotRef }
      type TeamSpec = { members?: TeamMember[] }
      const teamSpec = (team.json as { spec?: TeamSpec })?.spec
      const memberBotRefs =
        (teamSpec?.members?.map(m => m.botRef).filter(Boolean) as BotRef[]) || []

      // Check if any referenced bot has a model
      for (const botRef of memberBotRefs) {
        const bot = bots.find(
          b =>
            b.name === botRef.name &&
            (b.namespace === botRef.namespace || botRef.namespace === 'default')
        )
        if (bot?.model_name) {
          return true
        }
      }

      return false
    },
    [teams, bots]
  )

  useEffect(() => {
    fetchChannels()
    fetchTeams()
    fetchModels()
    fetchBots()
  }, [fetchChannels, fetchTeams, fetchModels, fetchBots])

  const handleCreateChannel = async () => {
    if (!formData.name.trim()) {
      toast({
        variant: 'destructive',
        title: t('admin:im_channels.errors.name_required'),
      })
      return
    }

    if (!formData.client_id.trim() || !formData.client_secret.trim()) {
      toast({
        variant: 'destructive',
        title: t('admin:im_channels.errors.config_required'),
      })
      return
    }

    // Validate: default team is required
    if (!formData.default_team_id) {
      toast({
        variant: 'destructive',
        title: t('admin:im_channels.errors.team_required'),
      })
      return
    }

    // Validate: if team has no model, must select a default model
    if (!teamHasModel(formData.default_team_id) && !formData.default_model_name) {
      toast({
        variant: 'destructive',
        title: t('admin:im_channels.errors.model_required_for_team'),
      })
      return
    }

    setSaving(true)
    try {
      const createData: IMChannelCreate = {
        name: formData.name.trim(),
        channel_type: formData.channel_type,
        is_enabled: formData.is_enabled,
        default_team_id: formData.default_team_id,
        default_model_name: formData.default_model_name || undefined,
        config: {
          client_id: formData.client_id.trim(),
          client_secret: formData.client_secret.trim(),
        },
      }
      await adminApis.createIMChannel(createData)
      toast({ title: t('admin:im_channels.success.created') })
      setIsCreateDialogOpen(false)
      resetForm()
      fetchChannels()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('admin:im_channels.errors.create_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const handleUpdateChannel = async () => {
    if (!selectedChannel) return

    // Validate: default team is required
    if (!formData.default_team_id) {
      toast({
        variant: 'destructive',
        title: t('admin:im_channels.errors.team_required'),
      })
      return
    }

    // Validate: if team has no model, must select a default model
    if (!teamHasModel(formData.default_team_id) && !formData.default_model_name) {
      toast({
        variant: 'destructive',
        title: t('admin:im_channels.errors.model_required_for_team'),
      })
      return
    }

    setSaving(true)
    try {
      const updateData: IMChannelUpdate = {}
      if (formData.name !== selectedChannel.name) {
        updateData.name = formData.name
      }
      if (formData.is_enabled !== selectedChannel.is_enabled) {
        updateData.is_enabled = formData.is_enabled
      }
      if (formData.default_team_id !== selectedChannel.default_team_id) {
        updateData.default_team_id = formData.default_team_id
      }
      if (formData.default_model_name !== (selectedChannel.default_model_name || '')) {
        updateData.default_model_name = formData.default_model_name
      }

      // Update config if any field changed
      const newConfig: Record<string, unknown> = {}
      if (formData.client_id.trim()) {
        newConfig.client_id = formData.client_id.trim()
      }
      if (formData.client_secret.trim()) {
        newConfig.client_secret = formData.client_secret.trim()
      }

      if (Object.keys(newConfig).length > 0) {
        updateData.config = newConfig
      }

      await adminApis.updateIMChannel(selectedChannel.id, updateData)
      toast({ title: t('admin:im_channels.success.updated') })
      setIsEditDialogOpen(false)
      resetForm()
      fetchChannels()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('admin:im_channels.errors.update_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteChannel = async () => {
    if (!selectedChannel) return

    setSaving(true)
    try {
      await adminApis.deleteIMChannel(selectedChannel.id)
      toast({ title: t('admin:im_channels.success.deleted') })
      setIsDeleteDialogOpen(false)
      setSelectedChannel(null)
      fetchChannels()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('admin:im_channels.errors.delete_failed'),
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const _handleToggleChannel = async (channel: IMChannel) => {
    try {
      await adminApis.toggleIMChannel(channel.id)
      toast({
        title: channel.is_enabled
          ? t('admin:im_channels.success.disabled')
          : t('admin:im_channels.success.enabled'),
      })
      fetchChannels()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('admin:im_channels.errors.toggle_failed'),
        description: (error as Error).message,
      })
    }
  }

  const handleRestartChannel = async (channel: IMChannel) => {
    try {
      const status = await adminApis.restartIMChannel(channel.id)
      setChannelStatuses(prev => ({ ...prev, [channel.id]: status }))
      toast({ title: t('admin:im_channels.success.restarted') })
    } catch (error) {
      toast({
        variant: 'destructive',
        title: t('admin:im_channels.errors.restart_failed'),
        description: (error as Error).message,
      })
    }
  }

  const resetForm = () => {
    setFormData({
      name: '',
      channel_type: 'dingtalk',
      is_enabled: true,
      default_team_id: 0,
      default_model_name: '',
      client_id: '',
      client_secret: '',
    })
    setSelectedChannel(null)
  }

  const openEditDialog = (channel: IMChannel) => {
    setSelectedChannel(channel)
    setFormData({
      name: channel.name,
      channel_type: channel.channel_type,
      is_enabled: channel.is_enabled,
      default_team_id: channel.default_team_id || 0,
      default_model_name: channel.default_model_name || '',
      client_id: (channel.config?.client_id as string) || '',
      client_secret: '', // Don't show existing secret
    })
    setIsEditDialogOpen(true)
  }

  const getChannelTypeLabel = (type: IMChannelType): string => {
    switch (type) {
      case 'dingtalk':
        return t('admin:im_channels.types.dingtalk')
      case 'feishu':
        return t('admin:im_channels.types.feishu')
      case 'wechat':
        return t('admin:im_channels.types.wechat')
      default:
        return type
    }
  }

  const getTeamName = (teamId: number | null): string => {
    if (!teamId) return t('admin:im_channels.no_default_team')
    const team = teams.find(t => t.id === teamId)
    return team?.display_name || team?.name || `Team #${teamId}`
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-text-primary mb-1">
          {t('admin:im_channels.title')}
        </h2>
        <p className="text-sm text-text-muted">{t('admin:im_channels.description')}</p>
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
        {!loading && channels.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <ChatBubbleLeftRightIcon className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('admin:im_channels.no_channels')}</p>
          </div>
        )}

        {/* Channel List */}
        {!loading && channels.length > 0 && (
          <div className="flex-1 overflow-y-auto space-y-3 p-1">
            {channels.map(channel => {
              const status = channelStatuses[channel.id]
              const isConnected = status?.is_connected ?? false

              return (
                <Card
                  key={channel.id}
                  className="p-4 bg-base hover:bg-hover transition-colors border-l-2 border-l-primary"
                >
                  <div className="flex items-center justify-between min-w-0">
                    <div className="flex items-center space-x-3 min-w-0 flex-1">
                      <ChatBubbleLeftRightIcon className="w-5 h-5 text-primary flex-shrink-0" />
                      <div className="flex flex-col justify-center min-w-0 flex-1">
                        <div className="flex items-center space-x-2 min-w-0">
                          <h3 className="text-base font-medium text-text-primary truncate">
                            {channel.name}
                          </h3>
                          <Tag variant="info">{getChannelTypeLabel(channel.channel_type)}</Tag>
                          {channel.is_enabled ? (
                            <Tag variant="success">{t('admin:im_channels.status.enabled')}</Tag>
                          ) : (
                            <Tag variant="error">{t('admin:im_channels.status.disabled')}</Tag>
                          )}
                          {channel.is_enabled && (
                            <span
                              className={`flex items-center gap-1 text-xs ${isConnected ? 'text-success' : 'text-error'}`}
                            >
                              {isConnected ? (
                                <>
                                  <SignalIcon className="w-3 h-3" />
                                  {t('admin:im_channels.connection.connected')}
                                </>
                              ) : (
                                <>
                                  <SignalSlashIcon className="w-3 h-3" />
                                  {t('admin:im_channels.connection.disconnected')}
                                </>
                              )}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-1 text-xs text-text-muted">
                          <span>
                            {t('admin:im_channels.default_team')}:{' '}
                            {getTeamName(channel.default_team_id)}
                          </span>
                          {status?.last_error && (
                            <>
                              <span>•</span>
                              <span
                                className="text-error truncate max-w-xs"
                                title={status.last_error}
                              >
                                {status.last_error}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0 ml-3">
                      {channel.is_enabled && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => handleRestartChannel(channel)}
                          title={t('admin:im_channels.restart_channel')}
                        >
                          <ArrowPathIcon className="w-4 h-4" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => openEditDialog(channel)}
                        title={t('admin:im_channels.edit_channel')}
                      >
                        <PencilIcon className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 hover:text-error"
                        onClick={() => {
                          setSelectedChannel(channel)
                          setIsDeleteDialogOpen(true)
                        }}
                        title={t('admin:im_channels.delete_channel')}
                      >
                        <TrashIcon className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </Card>
              )
            })}
          </div>
        )}

        {/* Add Button */}
        {!loading && (
          <div className="border-t border-border pt-3 mt-3 bg-base">
            <div className="flex justify-center">
              <UnifiedAddButton onClick={() => setIsCreateDialogOpen(true)}>
                {t('admin:im_channels.create_channel')}
              </UnifiedAddButton>
            </div>
          </div>
        )}
      </div>

      {/* Create Channel Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('admin:im_channels.create_channel')}</DialogTitle>
            <DialogDescription>{t('admin:im_channels.create_description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('admin:im_channels.form.name')} *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={e => setFormData({ ...formData, name: e.target.value })}
                placeholder={t('admin:im_channels.form.name_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="channel_type">{t('admin:im_channels.form.channel_type')} *</Label>
              <Select
                value={formData.channel_type}
                onValueChange={value =>
                  setFormData({ ...formData, channel_type: value as IMChannelType })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dingtalk">{t('admin:im_channels.types.dingtalk')}</SelectItem>
                  <SelectItem value="feishu" disabled>
                    {t('admin:im_channels.types.feishu')} (
                    {t('admin:im_channels.types.not_supported')})
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="client_id">{t('admin:im_channels.form.client_id')} *</Label>
              <Input
                id="client_id"
                value={formData.client_id}
                onChange={e => setFormData({ ...formData, client_id: e.target.value })}
                placeholder={t('admin:im_channels.form.client_id_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="client_secret">{t('admin:im_channels.form.client_secret')} *</Label>
              <Input
                id="client_secret"
                type="password"
                value={formData.client_secret}
                onChange={e => setFormData({ ...formData, client_secret: e.target.value })}
                placeholder={t('admin:im_channels.form.client_secret_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="default_team">{t('admin:im_channels.form.default_team')} *</Label>
              <Select
                value={formData.default_team_id ? formData.default_team_id.toString() : ''}
                onValueChange={value =>
                  setFormData({ ...formData, default_team_id: parseInt(value) })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('admin:im_channels.form.default_team_placeholder')} />
                </SelectTrigger>
                <SelectContent>
                  {teams.map(team => (
                    <SelectItem key={team.id} value={team.id.toString()}>
                      {team.display_name || team.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {formData.default_team_id > 0 && !teamHasModel(formData.default_team_id) && (
                <p className="text-xs text-amber-600">
                  {t('admin:im_channels.form.team_no_model_warning')}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="default_model">
                {t('admin:im_channels.form.default_model')}
                {formData.default_team_id > 0 && !teamHasModel(formData.default_team_id) && (
                  <span className="text-red-500 ml-1">*</span>
                )}
              </Label>
              <Select
                value={formData.default_model_name || '__none__'}
                onValueChange={value =>
                  setFormData({
                    ...formData,
                    default_model_name: value === '__none__' ? '' : value,
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={t('admin:im_channels.form.default_model_placeholder')}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">
                    {t('admin:im_channels.form.no_default_model')}
                  </SelectItem>
                  {models.map(model => (
                    <SelectItem key={model.id} value={model.name}>
                      {model.display_name || model.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="is_enabled">{t('admin:im_channels.form.is_enabled')}</Label>
              <Switch
                id="is_enabled"
                checked={formData.is_enabled}
                onCheckedChange={checked => setFormData({ ...formData, is_enabled: checked })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
              {t('admin:common.cancel')}
            </Button>
            <Button onClick={handleCreateChannel} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('admin:common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Channel Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('admin:im_channels.edit_channel')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">{t('admin:im_channels.form.name')}</Label>
              <Input
                id="edit-name"
                value={formData.name}
                onChange={e => setFormData({ ...formData, name: e.target.value })}
                placeholder={t('admin:im_channels.form.name_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('admin:im_channels.form.channel_type')}</Label>
              <Input
                value={getChannelTypeLabel(formData.channel_type)}
                disabled
                className="bg-muted"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-client_id">{t('admin:im_channels.form.client_id')}</Label>
              <Input
                id="edit-client_id"
                value={formData.client_id}
                onChange={e => setFormData({ ...formData, client_id: e.target.value })}
                placeholder={t('admin:im_channels.form.client_id_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-client_secret">
                {t('admin:im_channels.form.client_secret')}
                <span className="text-xs text-text-muted ml-2">
                  ({t('admin:im_channels.form.leave_empty_to_keep')})
                </span>
              </Label>
              <Input
                id="edit-client_secret"
                type="password"
                value={formData.client_secret}
                onChange={e => setFormData({ ...formData, client_secret: e.target.value })}
                placeholder={t('admin:im_channels.form.client_secret_edit_placeholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-default_team">
                {t('admin:im_channels.form.default_team')} *
              </Label>
              <Select
                value={formData.default_team_id ? formData.default_team_id.toString() : ''}
                onValueChange={value =>
                  setFormData({ ...formData, default_team_id: parseInt(value) })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('admin:im_channels.form.default_team_placeholder')} />
                </SelectTrigger>
                <SelectContent>
                  {teams.map(team => (
                    <SelectItem key={team.id} value={team.id.toString()}>
                      {team.display_name || team.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {formData.default_team_id > 0 && !teamHasModel(formData.default_team_id) && (
                <p className="text-xs text-amber-600">
                  {t('admin:im_channels.form.team_no_model_warning')}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-default_model">
                {t('admin:im_channels.form.default_model')}
                {formData.default_team_id > 0 && !teamHasModel(formData.default_team_id) && (
                  <span className="text-red-500 ml-1">*</span>
                )}
              </Label>
              <Select
                value={formData.default_model_name || '__none__'}
                onValueChange={value =>
                  setFormData({
                    ...formData,
                    default_model_name: value === '__none__' ? '' : value,
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={t('admin:im_channels.form.default_model_placeholder')}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">
                    {t('admin:im_channels.form.no_default_model')}
                  </SelectItem>
                  {models.map(model => (
                    <SelectItem key={model.id} value={model.name}>
                      {model.display_name || model.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-is_enabled">{t('admin:im_channels.form.is_enabled')}</Label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-muted">
                  {formData.is_enabled
                    ? t('admin:im_channels.status.enabled')
                    : t('admin:im_channels.status.disabled')}
                </span>
                <Switch
                  id="edit-is_enabled"
                  checked={formData.is_enabled}
                  onCheckedChange={checked => setFormData({ ...formData, is_enabled: checked })}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              {t('admin:common.cancel')}
            </Button>
            <Button onClick={handleUpdateChannel} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('admin:common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin:im_channels.confirm.delete_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin:im_channels.confirm.delete_message', { name: selectedChannel?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('admin:common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteChannel} className="bg-error hover:bg-error/90">
              {t('admin:common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default IMChannelList
