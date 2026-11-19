// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, X } from 'lucide-react'
import type { CollaborationGroupMember } from '../types'
import type { CollaborationLocale } from '../i18n'
import type { ProjectCreateCollaborationGroupDraft } from '../project-create/types'
import type { CollaborationTemplate, TemplateRoleAssignments as Bindings } from './types'
import { bindTemplate } from './document'
import {
  templateAgentBindings,
  templateAgentId,
  templateAgentReferences,
  templateRoutingResolver,
} from './agents'
import {
  TemplateModelSelection,
  sameTemplateModelScope,
  type TemplateModelConfiguration,
} from './TemplateModelSelection'
import type { RunnerModelIdentity } from '../agent-form/runnerRouting'
import type { TemplateRoutingResolver } from './types'
import { templateFailureMessage, templateMessages } from './messages'
import { TemplateDialog } from './TemplateDialog'
import { PartialTemplateApplyError, TemplateConfigurationError } from './apply'
import { TemplateApplyRecoveryError } from './projectApplyRecovery'

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
  const groupDisclosures = useRef(new Map<string, HTMLDetailsElement>())
  const [bindings, setBindings] = useState<Bindings>(() =>
    Object.fromEntries(
      document.spec.resources.collaboration.groups.map(group => {
        const kind = group.roles.find(role => role.key === group.leaderRole)?.defaultKind ?? 'agent'
        const current =
          (kind === 'human' &&
            candidates.find(
              candidate => candidate.kind === 'human' && candidate.id === String(currentUserId)
            )) ||
          candidates.find(candidate => candidate.kind === kind)
        const embedded = templateAgentBindings(document)[group.key]
        return [group.key, { ...(current ? { [group.leaderRole]: current } : {}), ...embedded }]
      })
    )
  )
  const [names, setNames] = useState<Record<string, string>>({})
  const [removed, setRemoved] = useState<Record<string, string[]>>({})
  const [customizing, setCustomizing] = useState<Record<string, boolean>>({})
  const configured = useMemo(
    () => ({
      ...document,
      spec: {
        ...document.spec,
        resources: {
          collaboration: {
            ...document.spec.resources.collaboration,
            groups: document.spec.resources.collaboration.groups.map(group => ({
              ...group,
              name: names[group.key] ?? group.name,
              roles: group.roles.filter(role => !removed[group.key]?.includes(role.key)),
              stages: group.stages.filter(
                stage => !stage.ownerRole || !removed[group.key]?.includes(stage.ownerRole)
              ),
            })),
          },
        },
      },
    }),
    [document, names, removed]
  )
  const changed = useRef(onChange)
  useEffect(() => {
    changed.current = onChange
  }, [onChange])
  const candidateKey = candidates
    .map(candidate => `${candidate.kind}:${candidate.id}`)
    .sort()
    .join('|')
  const available = useMemo(
    () =>
      new Set([
        ...candidateKey.split('|'),
        ...(document.spec.resources.collaboration.agents ?? []).map(
          agent => `agent:${templateAgentId(agent.key)}`
        ),
      ]),
    [candidateKey, document]
  )
  const unboundRoles = useMemo(
    () =>
      Object.fromEntries(
        configured.spec.resources.collaboration.groups.map(group => [
          group.key,
          new Set(
            group.roles
              .filter(role => {
                const member = bindings[group.key]?.[role.key]
                return !member || !available.has(`${member.kind}:${member.id}`)
              })
              .map(role => role.key)
          ),
        ])
      ),
    [configured, bindings, available]
  )
  const validation = useMemo(() => {
    try {
      if (Object.values(unboundRoles).some(roles => roles.size > 0))
        throw new Error('unbound_roles')
      return { drafts: bindTemplate(configured, bindings), error: null }
    } catch (error) {
      return {
        drafts: null,
        error: error instanceof Error ? error.message : '',
      }
    }
  }, [configured, bindings, unboundRoles])
  useEffect(() => {
    setCustomizing(current => {
      const missing = Object.entries(unboundRoles).filter(
        ([key, roles]) => roles.size > 0 && !current[key]
      )
      return missing.length
        ? { ...current, ...Object.fromEntries(missing.map(([key]) => [key, true])) }
        : current
    })
    for (const [groupKey, roles] of Object.entries(unboundRoles)) {
      const disclosure = groupDisclosures.current.get(groupKey)
      if (roles.size > 0 && disclosure) disclosure.open = true
    }
  }, [unboundRoles])
  useEffect(() => {
    changed.current(validation.drafts, configured)
  }, [validation, configured])
  const removeButton = (groupKey: string, roleKey: string, name: string, leader: boolean) => (
    <button
      type="button"
      className="collaboration-template-choice collaboration-template-icon-button"
      data-testid={`template-remove-role-${groupKey}-${roleKey}`}
      disabled={disabled || leader}
      aria-label={leader ? m.keepLeader : m.removeRole.replace('{name}', name)}
      title={leader ? m.keepLeader : m.removeRole.replace('{name}', name)}
      onClick={() => {
        setRemoved(current => ({
          ...current,
          [groupKey]: [...(current[groupKey] ?? []), roleKey],
        }))
        setBindings(current => {
          const roles = { ...current[groupKey] }
          delete roles[roleKey]
          return { ...current, [groupKey]: roles }
        })
      }}
    >
      <X size={16} aria-hidden="true" />
    </button>
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
            <input
              disabled={disabled}
              data-testid={`template-group-name-${group.key}`}
              value={group.name}
              onChange={event => {
                const name = event.target.value
                setNames(current => ({ ...current, [group.key]: name }))
              }}
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
          <details
            ref={node => {
              if (node) groupDisclosures.current.set(group.key, node)
              else groupDisclosures.current.delete(group.key)
            }}
            open={group.roles.every(role => !!role.agentKey) ? !!customizing[group.key] : true}
            onToggle={event => {
              const open = event.currentTarget.open
              setCustomizing(current =>
                current[group.key] === open ? current : { ...current, [group.key]: open }
              )
            }}
          >
            <summary data-testid={`template-customize-${group.key}`}>{m.customizeMembers}</summary>
            {(customizing[group.key] || !group.roles.every(role => !!role.agentKey)) &&
              group.roles.map(role => (
                <div className="collaboration-template-binding" key={role.key}>
                  <div>
                    <div className="collaboration-template-role-heading">
                      <strong>{role.name}</strong>
                      {removeButton(group.key, role.key, role.name, role.key === group.leaderRole)}
                    </div>
                    <p>{role.responsibility}</p>
                  </div>
                  <label className="collaboration-template-field">
                    <span className="sr-only">{role.name}</span>
                    <select
                      disabled={disabled}
                      data-testid={`template-role-${group.key}-${role.key}`}
                      aria-invalid={unboundRoles[group.key].has(role.key) || undefined}
                      aria-describedby={
                        unboundRoles[group.key].has(role.key)
                          ? `${bindingErrorId}-${group.key}`
                          : undefined
                      }
                      value={
                        bindings[group.key]?.[role.key]
                          ? `${bindings[group.key][role.key].kind}:${bindings[group.key][role.key].id}`
                          : ''
                      }
                      onChange={event => {
                        const candidate = [
                          ...candidates,
                          ...Object.values(templateAgentBindings(document)[group.key]),
                        ].find(
                          candidate => `${candidate.kind}:${candidate.id}` === event.target.value
                        )
                        const next = {
                          ...bindings,
                          [group.key]: { ...bindings[group.key] },
                        }
                        if (candidate) next[group.key][role.key] = candidate
                        else delete next[group.key][role.key]
                        setBindings(next)
                      }}
                    >
                      {role.agentKey && (
                        <option value={`agent:${templateAgentId(role.agentKey)}`}>
                          {m.autoCreate} ·{' '}
                          {
                            document.spec.resources.collaboration.agents?.find(
                              agent => agent.key === role.agentKey
                            )?.name
                          }
                        </option>
                      )}
                      <option value="">{m.choose}</option>
                      {candidates.map(candidate => (
                        <option
                          key={`${candidate.kind}:${candidate.id}`}
                          value={`${candidate.kind}:${candidate.id}`}
                        >
                          {candidate.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ))}
          </details>
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
  renderRecovery,
  recoveryBusy = false,
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
  renderRecovery?(busy: boolean): ReactNode
  recoveryBusy?: boolean
}) {
  const m = templateMessages[locale]
  const [selection, setSelection] = useState<{
    drafts: ProjectCreateCollaborationGroupDraft[]
    document: CollaborationTemplate
  } | null>(null)
  const [saving, setBusy] = useState(false)
  const busy = saving || recoveryBusy
  const [failure, setFailure] = useState<unknown>(null)
  const error = failure ? templateFailureMessage(failure, locale) : null
  const recovery = failure instanceof TemplateApplyRecoveryError ? failure : null
  const failed = failure instanceof PartialTemplateApplyError || recovery?.retryBlocked === true
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
          <button
            type="button"
            data-testid="template-bindings-cancel"
            disabled={busy}
            onClick={onClose}
          >
            {m.cancel}
          </button>
          <button
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
                setFailure(new TemplateConfigurationError(m.duplicateGroup))
                return
              }
              setBusy(true)
              setFailure(null)
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
                setFailure(error)
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? m.saving : m.apply}
          </button>
          {recovery?.outcome === 'unknown' && (
            <button
              type="button"
              data-testid="template-bindings-recheck"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  setFailure(await recovery.recheck())
                } finally {
                  setBusy(false)
                }
              }}
            >
              {m.refresh}
            </button>
          )}
        </>
      }
    >
      {renderRecovery?.(busy)}
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
        <details
          className="collaboration-runtime-disclosure"
          data-testid="template-runtime-configuration"
          onToggle={event => {
            if (event.currentTarget.open) setConfigurationMounted(true)
          }}
        >
          <summary>
            <ChevronRight aria-hidden="true" />
            <span>{m.optionalRuntimeConfiguration}</span>
          </summary>
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
        </details>
      )}
      {error && (
        <p role="alert" className="collaboration-template-error">
          {error}
        </p>
      )}
    </TemplateDialog>
  )
}
