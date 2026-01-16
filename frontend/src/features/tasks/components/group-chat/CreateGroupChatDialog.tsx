// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'
import { Team, Task } from '@/types/api'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { teamService } from '@/features/tasks/service/teamService'
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { ModelSelector, type Model } from '@/features/tasks/components/selector'
import { useUser } from '@/features/common/UserContext'

interface CreateGroupChatDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateGroupChatDialog({ open, onOpenChange }: CreateGroupChatDialogProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [selectedTeamId, setSelectedTeamId] = useState<string>('')
  const [isCreating, setIsCreating] = useState(false)
  const [selectedModel, setSelectedModel] = useState<Model | null>(null)
  const [forceOverride, setForceOverride] = useState(false)

  const { teams, isTeamsLoading } = teamService.useTeams()
  const { sendMessage } = useChatStreamContext()
  const { refreshTasks, setSelectedTask } = useTaskContext()
  const { user } = useUser()

  // Filter teams to only show chat-type teams (agent_type === 'chat')
  const chatTeams = useMemo(() => {
    return teams.filter(team => team.agent_type === 'chat')
  }, [teams])

  // Get selected team object
  const selectedTeam = useMemo(() => {
    if (!selectedTeamId) return null
    return chatTeams.find(t => t.id === parseInt(selectedTeamId)) || null
  }, [selectedTeamId, chatTeams])

  // Check if form is valid and ready to submit
  const isFormValid = useMemo(() => {
    return title.trim().length > 0 && selectedTeamId.length > 0 && selectedModel !== null
  }, [title, selectedTeamId, selectedModel])

  const handleCreate = async () => {
    if (!title.trim()) {
      toast({
        title: t('groupChat.create.titleRequired'),
        variant: 'destructive',
      })
      return
    }

    if (!selectedTeamId) {
      toast({
        title: t('groupChat.create.teamRequired'),
        variant: 'destructive',
      })
      return
    }

    setIsCreating(true)

    try {
      if (!selectedTeam) {
        throw new Error('Selected team not found')
      }

      console.log('[CreateGroupChatDialog] Creating group chat with ChatStreamContext', {
        teamId: selectedTeam.id,
        teamName: selectedTeam.name,
        title: title,
        modelName: selectedModel?.name || null,
        forceOverride: forceOverride,
      })

      // Use ChatStreamContext to send the message
      // This ensures the stream is registered globally and the task page can display it
      void sendMessage(
        {
          message: t('groupChat.create.initialMessage'),
          team_id: selectedTeam.id,
          task_id: undefined, // Let streaming API create the task
          title: title, // Pass custom title for the group chat
          model_id:
            selectedModel?.name === '__default__' ? undefined : selectedModel?.name || undefined,
          force_override_bot_model: forceOverride,
          is_group_chat: true, // Mark this as a group chat
        },
        {
          // Don't set pendingUserMessage to avoid showing duplicate messages
          // The USER subtask will be shown from the database after it's created
          pendingUserMessage: undefined,
          pendingAttachment: null,
          immediateTaskId: -Date.now(), // Temporary negative ID for immediate feedback
          // Pass current user information to ensure proper sender display
          currentUserId: user?.id,
          currentUserName: user?.user_name,
          // Called when message is sent successfully with the real task ID
          onMessageSent: (_localMessageId: string, realTaskId: number, _subtaskId: number) => {
            // Close dialog and reset form when task ID is resolved
            onOpenChange(false)
            setTitle('')
            setSelectedTeamId('')
            setSelectedModel(null)
            setForceOverride(false)
            setIsCreating(false)

            // Refresh task list to show the new group chat
            refreshTasks()

            // Set selected task with is_group_chat flag BEFORE navigation
            // This ensures ChatArea receives the correct isGroupChat prop immediately
            setSelectedTask({
              id: realTaskId,
              title: title,
              team_id: selectedTeam?.id || 0,
              is_group_chat: true,
            } as Task)

            // Navigate to the new task to show streaming output
            router.push(`/chat?taskId=${realTaskId}`)

            // Success toast
            toast({
              title: t('groupChat.create.success'),
              description: t('groupChat.create.successDesc'),
            })
          },
          onError: error => {
            toast({
              title: t('groupChat.create.failed'),
              description: error.message || t('groupChat.create.failedDesc'),
              variant: 'destructive',
            })
            setIsCreating(false)
          },
        }
      )
    } catch (error) {
      console.error('[CreateGroupChatDialog] Failed to create group chat:', error)
      toast({
        title: t('groupChat.create.failed'),
        description: error instanceof Error ? error.message : t('groupChat.create.failedDesc'),
        variant: 'destructive',
      })
      setIsCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('groupChat.create.title')}</DialogTitle>
          <DialogDescription>{t('groupChat.create.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="title">{t('groupChat.create.titleLabel')}</Label>
            <Input
              id="title"
              placeholder={t('groupChat.create.titlePlaceholder')}
              value={title}
              onChange={e => setTitle(e.target.value)}
              maxLength={100}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="team">{t('groupChat.create.teamLabel')}</Label>
            <Select value={selectedTeamId} onValueChange={setSelectedTeamId}>
              <SelectTrigger>
                <SelectValue placeholder={t('groupChat.create.teamPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {isTeamsLoading ? (
                  <SelectItem value="loading" disabled>
                    {t('actions.loading')}
                  </SelectItem>
                ) : chatTeams.length === 0 ? (
                  <SelectItem value="no-teams" disabled>
                    {t('groupChat.create.noChatTeams')}
                  </SelectItem>
                ) : (
                  chatTeams.map((team: Team) => (
                    <SelectItem key={team.id} value={String(team.id)}>
                      {team.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Model Selector - only show when a team is selected */}
          {selectedTeam && (
            <div className="space-y-2">
              <Label>{t('models.label')}</Label>
              <ModelSelector
                selectedModel={selectedModel}
                setSelectedModel={setSelectedModel}
                forceOverride={forceOverride}
                setForceOverride={setForceOverride}
                selectedTeam={selectedTeam}
                disabled={isCreating}
                isLoading={false}
              />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isCreating}>
            {t('actions.cancel')}
          </Button>
          <Button onClick={handleCreate} disabled={isCreating || !isFormValid}>
            {isCreating ? t('actions.creating') : t('actions.create')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
