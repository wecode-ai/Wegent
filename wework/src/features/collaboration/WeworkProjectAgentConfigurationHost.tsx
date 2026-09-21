import { Bot, Plus, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import type { ProjectAgentConfigurationHost, ProjectAgentMode } from '@wegent/collaboration'

import { Button } from '@/components/ui/button'
import type { createAgentResourceApi } from '@/api/agentResources'
import type { createLocalProjectChatAgentApi } from '@/api/local/localDelivery'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { ProjectChatAgentEditor } from '@/features/todo/ProjectChatAgentEditor'
import { cn } from '@/lib/utils'
import { WeworkAgentResourceForm } from './WeworkAgentResourceForm'

const modeIcons = {
  create: Plus,
  existing: Bot,
} as const

const controlClassName =
  'w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-focus focus:ring-2 focus:ring-focus/20'

export const weworkProjectAgentConfigurationHost: ProjectAgentConfigurationHost = {
  renderDialog({ busy, children, closeLabel, description, onClose, testIds, title }) {
    return createPortal(
      <div
        className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 p-6"
        data-testid={testIds.backdrop}
        onMouseDown={event => {
          if (event.target === event.currentTarget && !busy) onClose()
        }}
      >
        <section
          aria-labelledby="wework-project-agent-dialog-title"
          aria-modal="true"
          className="flex max-h-[90dvh] w-full max-w-4xl flex-col overflow-hidden rounded-[20px] border border-border bg-popover text-text-primary shadow-xl"
          data-testid={testIds.dialog}
          role="dialog"
        >
          <header className="flex items-start justify-between gap-4 border-b border-border px-5 pb-4 pt-5">
            <div className="min-w-0 space-y-1">
              <h2
                className="text-heading-sm font-medium text-text-primary"
                id="wework-project-agent-dialog-title"
              >
                {title}
              </h2>
              <p className="text-sm leading-5 text-text-muted">{description}</p>
            </div>
            <button
              aria-label={closeLabel}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-text-primary disabled:pointer-events-none disabled:opacity-40"
              data-testid={testIds.close}
              disabled={busy}
              onClick={onClose}
              type="button"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          </header>
          <div className="min-h-0 overflow-y-auto px-5 pb-5">{children}</div>
        </section>
      </div>,
      document.body
    )
  },
  renderModePicker({ onChange, options, value }) {
    return (
      <div className="grid grid-cols-2 gap-2" role="radiogroup">
        {options.map(option => {
          const Icon = modeIcons[option.value]
          const selected = option.value === value
          return (
            <label
              className={cn(
                'flex min-h-[84px] cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
                selected
                  ? 'border-focus bg-focus/5 ring-1 ring-focus/20'
                  : 'border-border bg-background hover:border-focus/40 hover:bg-surface'
              )}
              data-testid={`${option.testId}-card`}
              key={option.value}
            >
              <input
                aria-label={option.label}
                autoFocus={selected}
                checked={selected}
                className="sr-only"
                data-testid={option.testId}
                name="project-agent-mode"
                onChange={() => onChange(option.value as ProjectAgentMode)}
                type="radio"
                value={option.value}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
                  <Icon aria-hidden="true" className="h-4 w-4 text-focus" />
                  {option.label}
                </span>
                <span className="mt-1 block text-xs leading-5 text-text-secondary">
                  {option.description}
                </span>
              </span>
            </label>
          )
        })}
      </div>
    )
  },
  renderSelect({ ariaLabel, onChange, options, placeholder, testId, value }) {
    return (
      <select
        aria-label={ariaLabel}
        className={cn('wework-native-select h-10', controlClassName)}
        data-testid={testId}
        onChange={event => onChange(event.target.value)}
        value={value}
      >
        <option value="">{placeholder}</option>
        {options.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    )
  },
  renderPrimaryAction({ children, disabled, onClick, testId }) {
    return (
      <Button
        className="h-10 rounded-lg"
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

/**
 * Wework manages Agents through the resource library. Existing resources can
 * be selected, while the same dialog can create or edit the backing resource.
 */
export function createWeworkProjectAgentConfigurationHost(
  agentResourceApi: ReturnType<typeof createAgentResourceApi> | undefined,
  localAgentApi?: ReturnType<typeof createLocalProjectChatAgentApi>,
  localModelApi?: WorkbenchServices['modelApi'],
  pluginApi?: WorkbenchServices['pluginApi'],
  deviceApi?: Pick<WorkbenchServices['deviceApi'], 'listDevices' | 'listSkills'>
): ProjectAgentConfigurationHost {
  return {
    ...weworkProjectAgentConfigurationHost,
    ...(agentResourceApi
      ? {
          supportsExistingAgentSelection: true,
          supportsCrossLocationAgentSelection: true,
          renderAgentCreator({ namespace, onClose, onCreated, workspaceName }) {
            return (
              <WeworkAgentResourceForm
                api={agentResourceApi}
                deviceApi={deviceApi}
                namespace={namespace}
                onClose={onClose}
                onSaved={onCreated}
                pluginApi={pluginApi}
                workspaceName={workspaceName}
              />
            )
          },
          renderAgentEditor({ agent, namespace, onClose, onSaved, workspaceName }) {
            return (
              <WeworkAgentResourceForm
                api={agentResourceApi}
                deviceApi={deviceApi}
                editingTeamId={agent.teamId}
                key={agent.teamId}
                namespace={namespace}
                onClose={onClose}
                onSaved={onSaved}
                pluginApi={pluginApi}
                workspaceName={workspaceName}
              />
            )
          },
        }
      : {}),
    ...(localAgentApi && localModelApi
      ? {
          renderLocalAgentCreator({ onClose, onCreated, projectId }) {
            return (
              <ProjectChatAgentEditor
                api={localAgentApi}
                deviceApi={deviceApi}
                modelApi={localModelApi}
                pluginApi={pluginApi}
                projectId={projectId}
                skillApi={agentResourceApi}
                onClose={onClose}
                onSaved={onCreated}
              />
            )
          },
          renderLocalAgentEditor({ projectId, resourceId, onClose, onSaved }) {
            return (
              <ProjectChatAgentEditor
                api={localAgentApi}
                deviceApi={deviceApi}
                editingAgentId={resourceId}
                key={resourceId}
                modelApi={localModelApi}
                pluginApi={pluginApi}
                projectId={projectId}
                skillApi={agentResourceApi}
                onClose={onClose}
                onSaved={onSaved}
              />
            )
          },
        }
      : {}),
  }
}
