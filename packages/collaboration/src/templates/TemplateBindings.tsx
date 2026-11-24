import { TextField as ControlInput } from '../controls/TextField'
import { SelectContent, SelectItem, SelectRoot, SelectTrigger } from '../controls/SelectParts'
import { CollapsibleRoot, CollapsibleTrigger, CollapsiblePanel } from '../controls/Collapsible'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useId, useState, useSyncExternalStore, type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { CollaborationGroupMember } from '../types'
import type { CollaborationLocale } from '../i18n'
import type { ProjectCreateCollaborationGroupDraft } from '../project-create/types'
import type { CollaborationTemplate } from './types'
import { createTemplateBindingsDraft } from './templateBindingsDraft'
import { templateAgentId, templateAgentReferences, templateRoutingResolver } from './agents'
import { TemplateModelSelection, type TemplateModelConfiguration } from './TemplateModelSelection'
import { sameTemplateModelScope } from './templateModelScope'
import type { RunnerModelIdentity } from '../agent-form/runnerRouting'
import type { TemplateRoutingResolver } from './types'
import { templateFailureMessage, templateMessages } from './messages'
import { TemplateDialog } from './TemplateDialog'
import { PartialTemplateApplyError, TemplateConfigurationError } from './apply'

export interface TemplateParticipant extends CollaborationGroupMember {
  label: string
}

export function TemplateBindings({
  document,
  locale,
  candidates,
  currentUserId,
  disabled,
  onChange,
  environmentHint,
}: {
  document: CollaborationTemplate
  locale: CollaborationLocale
  candidates: TemplateParticipant[]
  currentUserId?: number
  disabled?: boolean
  environmentHint?: string
  onChange(
    drafts: ProjectCreateCollaborationGroupDraft[] | null,
    document: CollaborationTemplate
  ): void
}) {
  const m = templateMessages[locale]
  const bindingErrorId = useId()
  const [source] = useState(() => createTemplateBindingsDraft(document, candidates, currentUserId))
  const subscribe = useCallback(
    (notify: () => void) => source.subscribe(notify, onChange, document, candidates, currentUserId),
    [source, onChange, document, candidates, currentUserId]
  )
  const { configured, bindings, unboundRoles, validation, customizing } = useSyncExternalStore(
    subscribe,
    source.getSnapshot,
    source.getSnapshot
  )
  const removeButton = (groupKey: string, roleKey: string, name: string, leader: boolean) => (
    <ControlButton
      variant="unstyled"
      type="button"
      className="collaboration-template-choice collaboration-template-icon-button"
      data-testid={`template-remove-role-${groupKey}-${roleKey}`}
      disabled={disabled || leader}
      aria-label={leader ? m.keepLeader : m.removeRole.replace('{name}', name)}
      title={leader ? m.keepLeader : m.removeRole.replace('{name}', name)}
      onClick={() => source.removeRole(groupKey, roleKey)}
    >
      <X size={16} aria-hidden="true" />
    </ControlButton>
  )
  return (
    <div className="collaboration-template-bindings" data-testid="template-bindings">
      {!!document.spec.resources.collaboration.agents?.length && (
        <p className="collaboration-template-muted" data-testid="template-agents-summary">
          <strong>
            {m.agentsCount.replace(
              '{count}',
              String(
                new Set(
                  Object.values(bindings)
                    .flatMap(roles => Object.values(roles))
                    .filter(member => member.id.startsWith('template-agent:'))
                    .map(member => member.id)
                ).size
              )
            )}
          </strong>{' '}
          {environmentHint ?? m.environmentHint}
        </p>
      )}
      {configured.spec.resources.collaboration.groups.map(group => (
        <section key={group.key}>
          <label className="collaboration-template-field">
            <span>{m.groupName}</span>
            <ControlInput
              disabled={disabled}
              data-testid={`template-group-name-${group.key}`}
              value={group.name}
              onChange={event => source.rename(group.key, event.target.value)}
            />
          </label>
          {unboundRoles[group.key].size > 0 && (
            <p
              id={`${bindingErrorId}-${group.key}`}
              role="alert"
              className="collaboration-template-error"
              data-testid={`template-unbound-${group.key}`}
            >
              {m.unbound}
            </p>
          )}
          {group.roles.every(role => !!role.agentKey) &&
            !customizing[group.key] &&
            unboundRoles[group.key].size === 0 && (
              <ul
                className="collaboration-template-agent-roster"
                data-testid={`template-roster-${group.key}`}
              >
                {group.roles.map(role => (
                  <li key={role.key}>
                    <div className="collaboration-template-role-heading">
                      <strong>{role.name}</strong>
                      {removeButton(group.key, role.key, role.name, role.key === group.leaderRole)}
                    </div>
                    <span>
                      {bindings[group.key]?.[role.key]?.name !== role.name
                        ? `${bindings[group.key]?.[role.key]?.name ?? m.choose} · `
                        : ''}
                      {role.responsibility}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          <CollapsibleRoot
            open={group.roles.every(role => !!role.agentKey) ? !!customizing[group.key] : true}
            onOpenChange={open => source.customize(group.key, open)}
          >
            <CollapsibleTrigger data-testid={`template-customize-${group.key}`}>
              {m.customizeMembers}
            </CollapsibleTrigger>
            <CollapsiblePanel>
              {(customizing[group.key] || !group.roles.every(role => !!role.agentKey)) &&
                group.roles.map(role => (
                  <div className="collaboration-template-binding" key={role.key}>
                    <div>
                      <div className="collaboration-template-role-heading">
                        <strong>{role.name}</strong>
                        {removeButton(
                          group.key,
                          role.key,
                          role.name,
                          role.key === group.leaderRole
                        )}
                      </div>
                      <p>{role.responsibility}</p>
                    </div>
                    <label className="collaboration-template-field">
                      <span className="sr-only">{role.name}</span>
                      <SelectRoot
                        disabled={disabled}
                        value={String(
                          bindings[group.key]?.[role.key]
                            ? `${bindings[group.key][role.key].kind}:${bindings[group.key][role.key].id}`
                            : ''
                        )}
                        onValueChange={selectedValue => {
                          if (selectedValue === null) return
                          return source.assign(group.key, role.key, selectedValue)
                        }}
                      >
                        <SelectTrigger
                          data-testid={`template-role-${group.key}-${role.key}`}
                          data-value={
                            bindings[group.key]?.[role.key]
                              ? `${bindings[group.key][role.key].kind}:${bindings[group.key][role.key].id}`
                              : ''
                          }
                          aria-invalid={unboundRoles[group.key].has(role.key) || undefined}
                          aria-describedby={
                            unboundRoles[group.key].has(role.key)
                              ? `${bindingErrorId}-${group.key}`
                              : undefined
                          }
                        />
                        <SelectContent>
                          {role.agentKey && (
                            <SelectItem value={`agent:${templateAgentId(role.agentKey)}`}>
                              {m.autoCreate} ·{' '}
                              {
                                document.spec.resources.collaboration.agents?.find(
                                  agent => agent.key === role.agentKey
                                )?.name
                              }
                            </SelectItem>
                          )}
                          <SelectItem value="">{m.choose}</SelectItem>
                          {candidates.map(candidate => (
                            <SelectItem
                              key={`${candidate.kind}:${candidate.id}`}
                              value={`${candidate.kind}:${candidate.id}`}
                            >
                              {candidate.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </SelectRoot>
                    </label>
                  </div>
                ))}
            </CollapsiblePanel>
          </CollapsibleRoot>
        </section>
      ))}
      {validation.error === 'leader_executor' && (
        <p role="alert" className="collaboration-template-error">
          {m.bindError}
        </p>
      )}
      {validation.error?.includes('.name') && (
        <p role="alert" className="collaboration-template-error">
          {m.duplicateGroup}
        </p>
      )}
    </div>
  )
}

export function TemplateBindingsDialog({
  document,
  locale,
  candidates,
  currentUserId,
  existingNames = [],
  onApply,
  onClose,
  renderConfiguration,
  modelConfiguration,
}: {
  document: CollaborationTemplate
  locale: CollaborationLocale
  candidates: TemplateParticipant[]
  currentUserId?: number
  existingNames?: string[]
  onApply(
    drafts: ProjectCreateCollaborationGroupDraft[],
    document: CollaborationTemplate,
    resolveRouting?: TemplateRoutingResolver
  ): Promise<void>
  onClose(): void
  renderConfiguration?(disabled: boolean): ReactNode
  modelConfiguration?: TemplateModelConfiguration
}) {
  const m = templateMessages[locale]
  const [selection, setSelection] = useState<{
    drafts: ProjectCreateCollaborationGroupDraft[]
    document: CollaborationTemplate
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [configurationMounted, setConfigurationMounted] = useState(false)
  const [modelState, setModelState] = useState<{
    configuration: TemplateModelConfiguration
    models: Partial<Record<RunnerModelIdentity['runtime'], RunnerModelIdentity>>
  } | null>(null)
  const models =
    modelState && sameTemplateModelScope(modelState.configuration, modelConfiguration)
      ? modelState.models
      : {}
  const references = selection ? templateAgentReferences(selection.drafts) : new Set<string>()
  const runtimes = modelConfiguration?.host.listTemplateAgentModels
    ? [
        ...new Set(
          (document.spec.resources.collaboration.agents ?? [])
            .filter(agent => references.has(templateAgentId(agent.key)))
            .map(agent => agent.runtime)
        ),
      ]
    : []
  return (
    <TemplateDialog
      title={m.bindingsTitle}
      description={m.bindingsHint}
      closeLabel={m.close}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="template-bindings-cancel"
            disabled={busy}
            onClick={onClose}
          >
            {m.cancel}
          </ControlButton>
          <ControlButton
            variant="unstyled"
            type="button"
            className="collaboration-primary-button"
            data-testid="template-bindings-apply"
            disabled={!selection || busy || failed}
            onClick={async () => {
              if (!selection) return
              if (
                selection.drafts.some(
                  group => !group.name.trim() || existingNames.includes(group.name.trim())
                ) ||
                new Set(selection.drafts.map(group => group.name.trim())).size !==
                  selection.drafts.length
              ) {
                setError(m.duplicateGroup)
                return
              }
              setBusy(true)
              setError(null)
              try {
                const args = [selection.drafts, selection.document] as const
                if (modelConfiguration) {
                  await onApply(
                    ...args,
                    templateRoutingResolver(modelConfiguration.environmentId, models)
                  )
                } else {
                  await onApply(...args)
                }
                onClose()
              } catch (error) {
                setFailed(error instanceof PartialTemplateApplyError)
                setError(
                  [
                    'template_model_default_unavailable',
                    'template_model_unavailable',
                    'template_environment_unavailable',
                  ].includes(error instanceof Error ? error.message : '')
                    ? templateFailureMessage(error, locale)
                    : error instanceof TemplateConfigurationError
                      ? error.message
                      : m.failed
                )
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? m.saving : m.apply}
          </ControlButton>
        </>
      }
    >
      <p className="collaboration-template-muted">{m.existingHint}</p>
      <TemplateBindings
        document={document}
        locale={locale}
        environmentHint={
          modelConfiguration?.host.listTemplateAgentModels ? m.selectedModelHint : undefined
        }
        disabled={busy || failed}
        candidates={candidates}
        currentUserId={currentUserId}
        onChange={(drafts, document) => setSelection(drafts ? { drafts, document } : null)}
      />
      {(renderConfiguration || runtimes.length > 0) && (
        <CollapsibleRoot
          className="collaboration-runtime-disclosure"
          data-testid="template-runtime-configuration"
          onOpenChange={open => {
            if (open) setConfigurationMounted(true)
          }}
        >
          <CollapsibleTrigger data-testid="template-bindings-toggle">
            <span>{m.optionalRuntimeConfiguration}</span>
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <p className="collaboration-runtime-hint">{m.deferredRuntimeHint}</p>
            {configurationMounted && (
              <>
                {renderConfiguration?.(busy || failed)}
                {runtimes.map(runtime => (
                  <TemplateModelSelection
                    key={JSON.stringify([
                      runtime,
                      modelConfiguration?.location,
                      modelConfiguration?.projectId,
                      modelConfiguration?.environmentId,
                    ])}
                    runtime={runtime}
                    showRuntime={runtimes.length > 1}
                    configuration={modelConfiguration!}
                    locale={locale}
                    disabled={busy || failed}
                    onChange={model =>
                      setModelState(current => ({
                        configuration: modelConfiguration!,
                        models: {
                          ...(current &&
                          sameTemplateModelScope(current.configuration, modelConfiguration)
                            ? current.models
                            : {}),
                          [runtime]: model,
                        },
                      }))
                    }
                  />
                ))}
              </>
            )}
          </CollapsiblePanel>
        </CollapsibleRoot>
      )}
      {error && (
        <p role="alert" className="collaboration-template-error">
          {error}
        </p>
      )}
    </TemplateDialog>
  )
}
