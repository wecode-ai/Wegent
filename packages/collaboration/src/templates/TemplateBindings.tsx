// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CollaborationGroupMember } from '../types'
import type { CollaborationLocale } from '../i18n'
import type { ProjectCreateCollaborationGroupDraft } from '../project-create/types'
import type { CollaborationTemplate, TemplateRoleAssignments as Bindings } from './types'
import { bindTemplate } from './document'
import { templateMessages } from './messages'
import { TemplateDialog } from './TemplateDialog'
import { PartialTemplateApplyError } from './apply'

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
}: {
  document: CollaborationTemplate
  locale: CollaborationLocale
  candidates: TemplateParticipant[]
  currentUserId?: number
  disabled?: boolean
  onChange(
    drafts: ProjectCreateCollaborationGroupDraft[] | null,
    document: CollaborationTemplate
  ): void
}) {
  const m = templateMessages[locale]
  const [bindings, setBindings] = useState<Bindings>(() =>
    Object.fromEntries(
      document.spec.resources.collaboration.groups.map(group => {
        const current = candidates.find(
          candidate => candidate.kind === 'human' && candidate.id === String(currentUserId)
        )
        return [group.key, current ? { [group.leaderRole]: current } : {}]
      })
    )
  )
  const [names, setNames] = useState<Record<string, string>>({})
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
            })),
          },
        },
      },
    }),
    [document, names]
  )
  const changed = useRef(onChange)
  useEffect(() => {
    changed.current = onChange
  }, [onChange])
  const candidateKey = candidates
    .map(candidate => `${candidate.kind}:${candidate.id}`)
    .sort()
    .join('|')
  const validation = useMemo(() => {
    try {
      const available = new Set(candidateKey.split('|'))
      if (
        Object.values(bindings).some(roles =>
          Object.values(roles).some(member => !available.has(`${member.kind}:${member.id}`))
        )
      )
        throw new Error('unbound_roles')
      return { drafts: bindTemplate(configured, bindings), error: null }
    } catch (error) {
      return {
        drafts: null,
        error: error instanceof Error ? error.message : '',
      }
    }
  }, [configured, bindings, candidateKey])
  useEffect(() => {
    changed.current(validation.drafts, configured)
  }, [validation, configured])
  return (
    <div className="collaboration-template-bindings" data-testid="template-bindings">
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
          {group.roles.map(role => (
            <div className="collaboration-template-binding" key={role.key}>
              <div>
                <strong>{role.name}</strong>
                <p>{role.responsibility}</p>
              </div>
              <label className="collaboration-template-field">
                <span className="sr-only">{role.name}</span>
                <select
                  disabled={disabled}
                  data-testid={`template-role-${group.key}-${role.key}`}
                  value={
                    bindings[group.key]?.[role.key]
                      ? `${bindings[group.key][role.key].kind}:${bindings[group.key][role.key].id}`
                      : ''
                  }
                  onChange={event => {
                    const candidate = candidates.find(
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
}: {
  document: CollaborationTemplate
  locale: CollaborationLocale
  candidates: TemplateParticipant[]
  currentUserId?: number
  existingNames?: string[]
  onApply(
    drafts: ProjectCreateCollaborationGroupDraft[],
    document: CollaborationTemplate
  ): Promise<void>
  onClose(): void
}) {
  const m = templateMessages[locale]
  const [selection, setSelection] = useState<{
    drafts: ProjectCreateCollaborationGroupDraft[]
    document: CollaborationTemplate
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
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
                setError(m.duplicateGroup)
                return
              }
              setBusy(true)
              setError(null)
              try {
                await onApply(selection.drafts, selection.document)
                onClose()
              } catch (error) {
                setFailed(error instanceof PartialTemplateApplyError)
                setError(error instanceof PartialTemplateApplyError ? error.message : m.failed)
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? m.saving : m.apply}
          </button>
        </>
      }
    >
      <p className="collaboration-template-muted">{m.existingHint}</p>
      <TemplateBindings
        document={document}
        locale={locale}
        disabled={busy || failed}
        candidates={candidates}
        currentUserId={currentUserId}
        onChange={(drafts, document) => setSelection(drafts ? { drafts, document } : null)}
      />
      {!selection && <p className="collaboration-template-muted">{m.unbound}</p>}
      {error && (
        <p role="alert" className="collaboration-template-error">
          {error}
        </p>
      )}
    </TemplateDialog>
  )
}
