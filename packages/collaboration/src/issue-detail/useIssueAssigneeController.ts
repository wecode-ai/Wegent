import { useState, type SetStateAction } from 'react'
import { runnerEnvironmentError } from '../execution-environment/runnerEnvironmentError'
import type { CollaborationTranslate } from '../i18n'
import { canAssignCollaborationIssue } from '../permissions'
import type { CollaborationProject } from '../types'
import type { SharedIssueDetailPort } from './createSharedIssueDetailPort'
import {
  isValidIssueAssignmentShortcut,
  type IssueAssignmentShortcut,
} from './issueAssignmentShortcuts'
import {
  issueAssigneeTarget,
  parseIssueAssigneeTarget,
  type IssueAssigneeTarget,
  type IssueDetailDraftValue,
} from './IssueDetailDraft'
import type { CloudLoopItem, TodoEditorProps } from './issueEditorSupport'
import { isIssueVersionConflict } from './issueVersionConflict'
import { useIssueAssigneeResources } from './useIssueAssigneeResources'
import type { useIssueDetailCollections } from './useIssueDetailCollections'
import type { useIssueFieldSaves } from './useIssueFieldSaves'
import { useIssueOutsideAssignee } from './useIssueOutsideAssignee'

function createAssignmentScope(getOwner: () => number) {
  return {
    getOwner,
    owner: getOwner(),
    gate: { busy: false },
    inFlight: false,
    successRevision: 0,
  }
}

export function useIssueAssigneeController({
  props,
  item,
  project,
  editorPort,
  collections,
  fieldSaves,
  assigneeTarget,
  setIssueDraftField,
  setDraftField,
  getDraft,
  setSaveError,
  t,
}: {
  props: TodoEditorProps
  item: CloudLoopItem | null
  project: CollaborationProject | undefined
  editorPort: SharedIssueDetailPort
  collections: ReturnType<typeof useIssueDetailCollections>
  fieldSaves: ReturnType<typeof useIssueFieldSaves<CloudLoopItem>>
  assigneeTarget: IssueAssigneeTarget
  setIssueDraftField: <K extends keyof IssueDetailDraftValue>(
    field: K,
    value: SetStateAction<IssueDetailDraftValue[K]>
  ) => boolean
  setDraftField: <K extends keyof IssueDetailDraftValue>(
    field: K,
    value: SetStateAction<IssueDetailDraftValue[K]>
  ) => void
  getDraft: () => IssueDetailDraftValue
  setSaveError: (message: string | null) => void
  t: CollaborationTranslate
}) {
  const [notifyAssignee, setNotifyAssignee] = useState(true)
  const [operation, setOperation] = useState(() => createAssignmentScope(collections.getOwner))
  if (operation.getOwner !== collections.getOwner || operation.owner !== collections.getOwner()) {
    setOperation(createAssignmentScope(collections.getOwner))
  }
  const gate = operation.gate
  const { projectMembers, projectAgents, projectGroups, wegentTeams } = collections
  const outside = useIssueOutsideAssignee(props, item, projectMembers)
  const workspaceAgents = useIssueAssigneeResources(
    editorPort,
    item?.invited_only ? undefined : project,
    setSaveError,
    item?.assignee_agent_id
  )
  const assignee = projectMembers.find(member => assigneeTarget === `user:${member.user_id}`)
  const assigneeAgent = projectAgents.find(agent => assigneeTarget === `agent:${agent.id}`)
  const assigneeResource = workspaceAgents.find(agent => assigneeTarget === `resource:${agent.id}`)
  const assigneeTeam = wegentTeams.find(team => assigneeTarget === `team:${team.id}`)
  const assigneeGroup = projectGroups.find(group => assigneeTarget === `group:${group.id}`)
  const assigneeName =
    assigneeGroup?.name ||
    assigneeTeam?.displayName ||
    assigneeTeam?.name ||
    assigneeAgent?.name ||
    assigneeResource?.name ||
    assignee?.user_name ||
    (item && assigneeTarget && assigneeTarget === issueAssigneeTarget(item)
      ? assigneeTarget.startsWith('group:')
        ? item.assignee_group_name
        : assigneeTarget.startsWith('team:')
          ? item.assignee_team_name
          : assigneeTarget.startsWith('agent:')
            ? item.assignee_agent_name
            : item.assignee_name
      : null) ||
    (assigneeTarget ? assigneeTarget.slice(assigneeTarget.indexOf(':') + 1) : null)
  const canAssign =
    props.canAssign ??
    (item?.invited_only === true ||
      (project !== undefined &&
        (item === null || item.can_view_detail !== false) &&
        canAssignCollaborationIssue(project)))
  const assigneeChanged = item !== null && assigneeTarget !== issueAssigneeTarget(item)
  const assignmentPending = fieldSaves.pendingFields.has('assigneeTarget')
  const assignmentInFlight = operation.inFlight
  const assignmentBusy = assignmentInFlight || assignmentPending

  function recordAssignmentSuccess(owner: number) {
    if (!collections.isActive(owner)) return
    setOperation(current =>
      current.gate === gate ? { ...current, successRevision: current.successRevision + 1 } : current
    )
  }

  async function resolveAssigneeTarget(target: IssueAssigneeTarget): Promise<IssueAssigneeTarget> {
    if (!target.startsWith('resource:')) return target
    if (!project || !editorPort.agentResources) throw new Error('Workspace Agent is not available')
    if (!collections.isActive()) throw new Error('Issue editor scope changed')
    const id = await editorPort.agentResources.bind(project, target.slice(9))
    return `agent:${id}`
  }

  async function persistAssignee(
    source: CloudLoopItem,
    selectedTarget: IssueAssigneeTarget,
    shouldNotify: boolean,
    redeliver = false
  ): Promise<CloudLoopItem> {
    const target = await resolveAssigneeTarget(selectedTarget)
    if (!collections.isActive()) throw new Error('Issue editor scope changed')
    if (redeliver && (!target.startsWith('user:') || target !== issueAssigneeTarget(source)))
      throw new Error(t('todo.redeliver_assignee_changed', '负责人已变化，请重新选择。'))
    if (!target)
      return editorPort.issues.update(source.id, {
        version: source.version,
        assignee_user_id: null,
        assignee_agent_id: null,
        assignee_team_id: null,
        ...(source.assignee_group_id ? { assignee_group_id: null } : {}),
      })
    if (target.startsWith('group:')) {
      return editorPort.issues.update(source.id, {
        version: source.version,
        assignee_group_id: target.slice(6),
      })
    }
    const { assigneeUserId, assigneeAgentId, assigneeTeamId } = parseIssueAssigneeTarget(target)
    return editorPort.issues.update(source.id, {
      version: source.version,
      ...(assigneeUserId == null
        ? assigneeAgentId == null
          ? { assignee_team_id: assigneeTeamId }
          : { assignee_agent_id: assigneeAgentId }
        : {
            assignee_user_id: assigneeUserId,
            notify_assignee: shouldNotify,
            ...(redeliver ? { redeliver: true } : {}),
          }),
    })
  }

  function synchronizeAssigneeSource(
    issue: CloudLoopItem,
    expectedDraftTarget: IssueAssigneeTarget,
    owner: number,
    confirmedWrite = false
  ) {
    if (!collections.isActive(owner)) return
    const current = fieldSaves.acceptSource(issue, confirmedWrite)
    if (current && issueAssigneeTarget(current) !== expectedDraftTarget)
      setIssueDraftField('assigneeTarget', draftTarget =>
        draftTarget === expectedDraftTarget ? issueAssigneeTarget(current) : draftTarget
      )
    return current
  }

  async function persistShortcutAssignee(
    source: CloudLoopItem,
    shortcut: Pick<IssueAssignmentShortcut, 'kind' | 'target' | 'currentTarget' | 'historyIndex'>,
    expectedDraftTarget: IssueAssigneeTarget,
    owner = collections.getOwner()
  ) {
    if (!isValidIssueAssignmentShortcut(source, shortcut)) {
      synchronizeAssigneeSource(source, expectedDraftTarget, owner)
      throw new Error(t('todo.redeliver_assignee_changed', '负责人已变化，请重新选择。'))
    }
    try {
      const updated = await persistAssignee(
        source,
        shortcut.target,
        true,
        shortcut.kind === 'redeliver'
      )
      if (shortcut.kind === 'redeliver') {
        const previousCount = source.assignment_history?.length ?? 0
        const history = updated.assignment_history ?? []
        const latest = history.at(-1)
        // Older local executors deliver on same-person assignment and append legacy history.
        const legacyLocal = project?.project_store === 'local' && latest?.redeliver === undefined
        const confirmed =
          updated.version > source.version &&
          history.length > previousCount &&
          latest?.to_type === 'user' &&
          `user:${latest.to_id}` === shortcut.target &&
          ((latest.action === 'reassign' && (latest.redeliver === true || legacyLocal)) ||
            (legacyLocal && latest.action === 'assign' && previousCount === 0))
        if (!confirmed) {
          synchronizeAssigneeSource(updated, expectedDraftTarget, owner, true)
          throw new Error(
            t('todo.redeliver_unconfirmed', '未能确认重新投递，请升级服务后核实投递记录。')
          )
        }
      }
      return updated
    } catch (error) {
      const conflict =
        isIssueVersionConflict(error) ||
        (error && typeof error === 'object' && 'status' in error && error.status === 409)
      if (!conflict || !collections.isActive(owner)) throw error
      const latest = await editorPort.issues.get(source.id)
      synchronizeAssigneeSource(latest, expectedDraftTarget, owner)
      throw new Error(t('todo.assignment_reselect', '事项已更新，请重新选择负责人。'))
    }
  }

  function saveAssigneeProperty(value: SetStateAction<IssueAssigneeTarget>) {
    if (gate.busy) return
    const next = typeof value === 'function' ? value(getDraft().assigneeTarget) : value
    setDraftField('assigneeTarget', next)
    if (!item || !canAssign) return
    const owner = collections.getOwner()
    void fieldSaves.save('assigneeTarget', async source => {
      let updated: CloudLoopItem
      try {
        if (gate.busy) throw new Error(t('todo.saving', '保存中…'))
        updated = await persistAssignee(source, next, notifyAssignee)
      } catch (error) {
        const latest = fieldSaves.getSource() ?? item
        if (runnerEnvironmentError(error, t) && latest?.id === source.id)
          setIssueDraftField('assigneeTarget', current =>
            current === next ? issueAssigneeTarget(latest) : current
          )
        throw error
      }
      const latest = fieldSaves.getSource() ?? item
      if (latest?.id === source.id) {
        const accepted = latest.version > updated.version ? latest : updated
        setIssueDraftField('assigneeTarget', current =>
          current === next ? issueAssigneeTarget(accepted) : current
        )
      }
      recordAssignmentSuccess(owner)
      return updated
    })
  }

  function applyShortcutAssignee(shortcut: IssueAssignmentShortcut) {
    if (gate.busy || (shortcut.kind !== 'redeliver' && shortcut.kind !== 'return')) return
    const isReturn = shortcut.kind === 'return'
    if (isReturn) setDraftField('assigneeTarget', shortcut.target)
    if (!item || !canAssign) return
    const owner = collections.getOwner()
    void fieldSaves.save(
      'assigneeTarget',
      async source => {
        let updated: CloudLoopItem
        try {
          if (gate.busy) throw new Error(t('todo.saving', '保存中…'))
          updated = await persistShortcutAssignee(source, shortcut, shortcut.target, owner)
        } catch (error) {
          if (isReturn) {
            const latest = fieldSaves.getSource() ?? item
            if (latest?.id === source.id)
              setIssueDraftField('assigneeTarget', current =>
                current === shortcut.target ? issueAssigneeTarget(latest) : current
              )
          }
          throw error
        }
        const latest = fieldSaves.getSource() ?? item
        if (latest?.id === source.id) {
          const accepted = latest.version > updated.version ? latest : updated
          setIssueDraftField('assigneeTarget', current =>
            current === shortcut.target ? issueAssigneeTarget(accepted) : current
          )
        }
        recordAssignmentSuccess(owner)
        return updated
      },
      { retry: false, reportError: false }
    )
  }

  function completeIssueAssignment(owner: number) {
    if (!collections.isActive(owner)) return
    fieldSaves.discardFailure('assigneeTarget')
    recordAssignmentSuccess(owner)
  }

  async function runIssueAssignment(
    work: (owner: number) => Promise<void | boolean>
  ): Promise<void | boolean> {
    const owner = collections.getOwner()
    if (!collections.isActive(owner)) return false
    if (gate.busy || fieldSaves.isPending('assigneeTarget')) {
      throw new Error(t('todo.saving', '保存中…'))
    }
    gate.busy = true
    setOperation(current => (current.gate === gate ? { ...current, inFlight: true } : current))
    try {
      return await work(owner)
    } finally {
      gate.busy = false
      setOperation(current => (current.gate === gate ? { ...current, inFlight: false } : current))
    }
  }

  return {
    ...outside,
    workspaceAgents,
    notifyAssignee,
    setNotifyAssignee,
    assigneeName,
    canAssign,
    assigneeChanged,
    assignmentPending,
    assignmentInFlight,
    assignmentBusy,
    assignmentSuccessRevision: operation.successRevision,
    resolveAssigneeTarget,
    persistAssignee,
    synchronizeAssigneeSource,
    persistShortcutAssignee,
    saveAssigneeProperty,
    applyShortcutAssignee,
    completeIssueAssignment,
    runIssueAssignment,
  }
}
