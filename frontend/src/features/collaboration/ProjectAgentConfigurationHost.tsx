// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react'
import type { ProjectAgentConfigurationHost } from '@wegent/collaboration'
import { Bot, Plus } from 'lucide-react'

import type { Bot as AgentBot, Team } from '@/types/api'
import {
  simpleChoiceCardBaseClass,
  simpleChoiceCardSelectedClass,
  simpleChoiceCardUnselectedClass,
} from '@/components/common/simple-choice-card-styles'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { cn } from '@/lib/utils'
import { useToast } from '@/hooks/use-toast'
import TeamEditDialog from '@/features/settings/components/TeamEditDialog'
import { fetchBotsList } from '@/features/settings/services/bots'
import { fetchTeamsList } from '@/features/settings/services/teams'

function ResourceLibraryAgentCreator({
  namespace,
  onClose,
  onCreated,
  workspaceName,
}: {
  namespace: string
  onClose(): void
  onCreated(agent: { name: string; teamId: number }): Promise<void>
  workspaceName: string
}) {
  const { toast } = useToast()
  const [teams, setTeams] = useState<Team[]>([])
  const [bots, setBots] = useState<AgentBot[]>([])
  const resourceScope = namespace === 'default' ? 'personal' : 'group'

  useEffect(() => {
    let active = true
    void Promise.all([
      fetchTeamsList(resourceScope, namespace === 'default' ? undefined : namespace),
      fetchBotsList(resourceScope, namespace === 'default' ? undefined : namespace),
    ])
      .then(([nextTeams, nextBots]) => {
        if (!active) return
        setTeams(nextTeams)
        setBots(nextBots)
      })
      .catch(error => {
        if (!active) return
        toast({
          variant: 'destructive',
          title: error instanceof Error ? error.message : '加载智能体创建配置失败',
        })
      })
    return () => {
      active = false
    }
  }, [namespace, resourceScope, toast])

  return (
    <TeamEditDialog
      bots={bots}
      createTarget={
        namespace === 'default'
          ? { scope: 'personal' }
          : { scope: 'group', groupName: namespace, groupNames: [namespace] }
      }
      editingTeamId={0}
      fixedCreateTargetLabel={workspaceName}
      onClose={onClose}
      onSaved={team => onCreated({ name: team.displayName || team.name, teamId: team.id })}
      open
      scope={resourceScope}
      groupName={namespace === 'default' ? undefined : namespace}
      setBots={setBots}
      setTeams={setTeams}
      teams={teams}
      toast={toast}
    />
  )
}

const modeIcons = {
  create: Plus,
  existing: Bot,
} as const

export const webProjectAgentConfigurationHost: ProjectAgentConfigurationHost = {
  renderAgentCreator(props) {
    return <ResourceLibraryAgentCreator {...props} />
  },
  renderDialog({ busy, children, closeLabel, description, onClose, testIds, title }) {
    return (
      <Dialog
        open
        onOpenChange={open => {
          if (!open && !busy) onClose()
        }}
      >
        <DialogContent
          className="gap-0 overflow-hidden p-0 sm:max-w-[520px]"
          closeButtonProps={{
            'aria-label': closeLabel,
            className: 'right-5 top-5',
            'data-testid': testIds.close,
            disabled: busy,
          }}
          data-testid={testIds.dialog}
          overlayProps={{ 'data-testid': testIds.backdrop }}
          preventEscapeClose={busy}
          preventOutsideClick={busy}
        >
          <DialogHeader className="space-y-1 px-5 pb-4 pr-12 pt-5">
            <DialogTitle className="text-lg leading-6">{title}</DialogTitle>
            <DialogDescription className="text-sm leading-5 text-text-muted">
              {description}
            </DialogDescription>
          </DialogHeader>
          <div className="px-5 pb-5">{children}</div>
        </DialogContent>
      </Dialog>
    )
  },
  renderModePicker({ onChange, options, value }) {
    return (
      <RadioGroup
        className="grid grid-cols-2 gap-2"
        onValueChange={nextValue => {
          const option = options.find(candidate => candidate.value === nextValue)
          if (!option?.disabled) onChange(nextValue as typeof value)
        }}
        value={value}
      >
        {options.map(option => {
          const Icon = modeIcons[option.value]
          const selected = option.value === value
          return (
            <label
              aria-disabled={option.disabled || undefined}
              className={cn(
                simpleChoiceCardBaseClass,
                option.disabled
                  ? 'cursor-not-allowed opacity-45'
                  : selected
                    ? simpleChoiceCardSelectedClass
                    : simpleChoiceCardUnselectedClass
              )}
              data-testid={`${option.testId}-card`}
              key={option.value}
            >
              <RadioGroupItem
                aria-label={option.label}
                data-testid={option.testId}
                disabled={option.disabled}
                value={option.value}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
                  <Icon aria-hidden="true" className="h-4 w-4 text-primary" />
                  {option.label}
                </span>
                <span className="mt-0.5 block text-xs leading-5 text-text-secondary">
                  {option.description}
                </span>
              </span>
            </label>
          )
        })}
      </RadioGroup>
    )
  },
  renderSelect({ ariaLabel, onChange, options, placeholder, testId, value }) {
    return (
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={ariaLabel} data-testid={testId}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map(option => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  },
  renderPrimaryAction({ children, disabled, onClick, testId }) {
    return (
      <Button
        data-testid={testId}
        disabled={disabled}
        onClick={onClick}
        type="button"
        variant="primary"
      >
        {children}
      </Button>
    )
  },
}
