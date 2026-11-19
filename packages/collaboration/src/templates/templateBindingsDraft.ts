// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationTemplate, TemplateRoleAssignments as Bindings } from './types'
import type { TemplateParticipant } from './TemplateBindings'
import { templateAgentBindings, templateAgentId } from './agents'
import { bindTemplate } from './document'
import type { ProjectCreateCollaborationGroupDraft } from '../project-create/types'

type Change = (
  drafts: ProjectCreateCollaborationGroupDraft[] | null,
  document: CollaborationTemplate
) => void

export function createTemplateBindingsDraft(
  initialDocument: CollaborationTemplate,
  initialCandidates: TemplateParticipant[],
  initialUserId?: number
) {
  let document = initialDocument
  let candidates = initialCandidates
  let currentUserId = initialUserId
  const initialize = (): Bindings =>
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
  let bindings = initialize()
  let names: Record<string, string> = {}
  let removed: Record<string, string[]> = {}
  let customizing: Record<string, boolean> = {}
  const candidateIdentity = (values: TemplateParticipant[]) =>
    values
      .map(candidate => candidate.kind + ':' + candidate.id)
      .sort()
      .join('|')
  let candidateKey = candidateIdentity(candidates)
  const derive = () => {
    const configured = {
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
    }
    const available = new Set([
      ...candidateKey.split('|'),
      ...(document.spec.resources.collaboration.agents ?? []).map(
        agent => `agent:${templateAgentId(agent.key)}`
      ),
    ])
    const unboundRoles = Object.fromEntries(
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
    )
    const validation = (() => {
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
    })()
    for (const [key, roles] of Object.entries(unboundRoles)) {
      if (roles.size) customizing = { ...customizing, [key]: true }
    }
    return { configured, bindings, unboundRoles, validation, customizing }
  }
  let snapshot = derive()
  const observers = new Set<{ notify(): void; change: Change }>()
  let reported: string | undefined
  // Disclosure state does not change the document or the parent-facing validation result.
  const publish = () => {
    const signature = JSON.stringify([snapshot.configured, snapshot.validation.drafts])
    const changed = signature !== reported
    reported = signature
    for (const observer of observers) {
      observer.notify()
      if (changed) observer.change(snapshot.validation.drafts, snapshot.configured)
    }
  }
  const update = () => {
    snapshot = derive()
    publish()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(
      notify: () => void,
      change: Change,
      nextDocument: CollaborationTemplate,
      nextCandidates: TemplateParticipant[],
      nextUserId?: number
    ) {
      const observer = { notify, change }
      observers.add(observer)
      candidates = nextCandidates
      const nextKey = candidateIdentity(candidates)
      if (document !== nextDocument || currentUserId !== nextUserId) {
        document = nextDocument
        currentUserId = nextUserId
        bindings = initialize()
        names = {}
        removed = {}
        customizing = {}
        candidateKey = nextKey
        update()
      } else if (candidateKey !== nextKey) {
        candidateKey = nextKey
        update()
      } else if (reported === undefined) publish()
      return () => {
        observers.delete(observer)
      }
    },
    rename(groupKey: string, name: string) {
      if (
        (names[groupKey] ??
          document.spec.resources.collaboration.groups.find(group => group.key === groupKey)
            ?.name) === name
      )
        return
      names = { ...names, [groupKey]: name }
      update()
    },
    removeRole(groupKey: string, roleKey: string) {
      const group = snapshot.configured.spec.resources.collaboration.groups.find(
        group => group.key === groupKey
      )
      if (!group || group.leaderRole === roleKey || !group.roles.some(role => role.key === roleKey))
        return
      removed = { ...removed, [groupKey]: [...(removed[groupKey] ?? []), roleKey] }
      const roles = { ...bindings[groupKey] }
      delete roles[roleKey]
      bindings = { ...bindings, [groupKey]: roles }
      update()
    },
    assign(groupKey: string, roleKey: string, value: string) {
      const candidate = [
        ...candidates,
        ...Object.values(templateAgentBindings(document)[groupKey]),
      ].find(candidate => candidate.kind + ':' + candidate.id === value)
      if (bindings[groupKey]?.[roleKey] === candidate) return
      const roles = { ...bindings[groupKey] }
      if (candidate) roles[roleKey] = candidate
      else delete roles[roleKey]
      bindings = { ...bindings, [groupKey]: roles }
      update()
    },
    customize(groupKey: string, open: boolean) {
      if (!!customizing[groupKey] === open) return
      customizing = { ...customizing, [groupKey]: open }
      snapshot = { ...snapshot, customizing }
      publish()
    },
  }
}
