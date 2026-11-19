// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { X } from 'lucide-react'
import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { useDocumentEvent } from '../dom-events'
import type { CollaborationTranslate } from '../i18n'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationProject } from '../types'
import type { ProjectAgentConfigurationHost } from './types'
import styles from './ProjectAgentConfiguration.module.css'
import { ProjectAgentPicker } from './ProjectAgentPicker'
import { ConfirmationDialog } from '../controls/ConfirmationDialog'
import { createProjectAgentConfigurationState } from './projectAgentConfigurationState'

type ProjectAgentConfigurationProps = {
  api: SharedWorkspaceApi
  canManage?: boolean
  host?: ProjectAgentConfigurationHost
  project: Pick<
    CollaborationProject,
    'id' | 'workspace_id' | 'project_store' | 'workspace_access_role'
  > & {
    name?: string
    namespace?: string
  }
  resourceContext?: {
    name: string
    namespace: string
  }
  onError(): void
  onAgentsChange?(): void
  openComposerRequestId?: number
  onOpenComposerRequestConsumed?(requestId: number): void
  scope?: 'project' | 'workspace'
  translate: CollaborationTranslate
}

export function ProjectAgentConfiguration({
  api,
  canManage = true,
  host,
  project,
  resourceContext,
  onError,
  onAgentsChange,
  openComposerRequestId,
  onOpenComposerRequestConsumed,
  scope = 'project',
  translate,
}: ProjectAgentConfigurationProps) {
  const workspaceId = project.workspace_id
  const projectId = project.id
  const projectStore = project.project_store
  const role = project.workspace_access_role
  const namespace = resourceContext?.namespace ?? project.namespace ?? 'default'
  const resource = useMemo(
    () =>
      createProjectAgentConfigurationState({
        api,
        projectId,
        workspaceId,
        projectStore,
        role,
        canManage,
        scope,
        namespace,
      }),
    [api, projectId, workspaceId, projectStore, role, canManage, scope, namespace]
  )
  const supportsExistingAgentSelection = host?.supportsExistingAgentSelection ?? true
  const input = useMemo(
    () => ({
      translate,
      onError,
      onAgentsChange,
      supportsExisting: supportsExistingAgentSelection,
      openComposerRequestId,
      onOpenComposerRequestConsumed,
    }),
    [
      translate,
      onError,
      onAgentsChange,
      supportsExistingAgentSelection,
      openComposerRequestId,
      onOpenComposerRequestConsumed,
    ]
  )
  const subscribe = useCallback(
    (listener: () => void) => resource.subscribe(listener, input),
    [resource, input]
  )
  const {
    agents,
    workspaceAgents,
    selectedTeamId,
    mode,
    loading,
    loadError,
    candidateLoading,
    candidateError,
    composerOpen,
    composerVersion,
    editingVersion,
    editingAgentId,
    pendingRemoval,
    busy,
    archivingId,
    error,
    canBrowseSources,
  } = useSyncExternalStore(subscribe, resource.getSnapshot, resource.getSnapshot)
  const usesLocalAgentCreator = projectStore === 'local' && Boolean(host?.renderLocalAgentCreator)
  const usesProjectAgentEditor = Boolean(host?.renderProjectAgentEditor)
  const supportsAgentCreation =
    canBrowseSources && Boolean(usesLocalAgentCreator || host?.renderAgentCreator)
  const editingAgent = useMemo(
    () => agents.find(agent => agent.id === editingAgentId) ?? null,
    [agents, editingAgentId]
  )
  useDocumentEvent(
    'keydown',
    event => {
      if (event.key === 'Escape' && !busy) resource.closeComposer()
    },
    { enabled: composerOpen && !host }
  )
  const dialogTitle = translate('todo.add_project_agent', '添加智能体')
  const dialogDescription =
    scope === 'workspace'
      ? translate('todo.agent_picker_workspace_description', '选择一个智能体，供分组内项目复用。')
      : translate('todo.agent_picker_description', '选择一个智能体，加入后即可分配项目任务。')
  const closeLabel = translate('common.close', '关闭')

  function renderDialog(children: ReactNode) {
    if (host) {
      return host.renderDialog({
        busy,
        children,
        closeLabel,
        description: dialogDescription,
        onClose: () => resource.closeComposer(composerVersion),
        testIds: {
          backdrop: 'project-agent-dialog-backdrop',
          close: 'project-agent-dialog-close',
          dialog: 'project-agent-dialog',
        },
        title: dialogTitle,
      })
    }
    return (
      <div
        className={styles.modalBackdrop}
        data-testid="project-agent-dialog-backdrop"
        onMouseDown={event => {
          if (event.target === event.currentTarget && !busy) {
            resource.closeComposer(composerVersion)
          }
        }}
      >
        <section
          aria-labelledby="project-agent-dialog-title"
          aria-modal="true"
          className={styles.modal}
          data-testid="project-agent-dialog"
          role="dialog"
        >
          <header className={styles.modalHeader}>
            <div className={styles.composerHeader}>
              <h3 id="project-agent-dialog-title">{dialogTitle}</h3>
              <p>{dialogDescription}</p>
            </div>
            <button
              aria-label={closeLabel}
              className={styles.closeButton}
              data-testid="project-agent-dialog-close"
              disabled={busy}
              onClick={() => resource.closeComposer(composerVersion)}
              type="button"
            >
              <X aria-hidden="true" />
            </button>
          </header>
          {children}
        </section>
      </div>
    )
  }

  const creatorContext = resourceContext ?? {
    name: project.name ?? '',
    namespace: project.namespace ?? 'default',
  }
  const agentProjectId = scope === 'project' ? project.id : undefined

  function renderCustomAgentCreator() {
    if (mode !== 'create') return null
    const onClose = () => {
      resource.cancelCreation(composerVersion)
    }
    if (usesLocalAgentCreator && host?.renderLocalAgentCreator) {
      return host.renderLocalAgentCreator({
        onClose,
        onCreated: () => resource.finishLocalAgentCreation(composerVersion),
        projectId: agentProjectId,
      })
    }
    return host?.renderAgentCreator?.({
      projectId: scope === 'project' ? project.id : undefined,
      namespace: creatorContext.namespace,
      onClose,
      onCreated: agent => resource.createAndAddAgent(agent, composerVersion),
      workspaceName: creatorContext.name,
    })
  }

  const customAgentCreator = composerOpen ? renderCustomAgentCreator() : null

  return (
    <section className={styles.section} data-testid="project-agent-config">
      <div className={styles.header}>
        <div>
          <div className={styles.titleRow}>
            <h2 className={styles.title}>
              {scope === 'workspace'
                ? translate('todo.workspace_agents', '分组智能体')
                : translate('todo.project_agents', '项目智能体')}
            </h2>
            {!loading && !loadError ? <span className={styles.count}>{agents.length}</span> : null}
          </div>
          <p className={styles.description}>
            {scope === 'workspace'
              ? translate(
                  'todo.workspace_agents_description',
                  '管理分组共享智能体，分组内项目可以直接复用。'
                )
              : translate(
                  'todo.project_agents_description',
                  '直接管理这个项目的智能体；既可使用我的智能体，也可复用分组共享的智能体。'
                )}
          </p>
        </div>
        {canBrowseSources ? (
          <button
            className={styles.addButton}
            data-testid="project-agent-add"
            disabled={loading || loadError !== null}
            onClick={resource.openComposer}
            type="button"
          >
            {translate('todo.add_project_agent', '添加智能体')}
          </button>
        ) : null}
      </div>

      {loadError ? (
        <div role="alert" className={styles.error} data-testid="project-agent-config-error">
          {loadError}
          <button
            type="button"
            className={styles.retryButton}
            data-testid="project-agent-config-retry"
            onClick={resource.retryList}
          >
            {translate('common.retry', '重试')}
          </button>
        </div>
      ) : null}
      {loading && agents.length === 0 ? (
        <p className={styles.empty} data-testid="project-agent-config-loading">
          {translate('common.loading', '加载中…')}
        </p>
      ) : !loadError || agents.length > 0 ? (
        <>
          {agents.length ? (
            <div className={styles.list} data-testid="project-agent-list">
              {agents.map(agent => (
                <div
                  className={styles.agent}
                  data-testid={`project-agent-row-${agent.id}`}
                  key={agent.id}
                >
                  <span className={styles.agentAvatar} aria-hidden="true">
                    {agent.displayName.trim().slice(0, 1).toUpperCase() || 'AI'}
                  </span>
                  <div className={styles.agentIdentity}>
                    <span className={styles.agentName}>{agent.displayName}</span>
                    <span className={styles.agentDetails}>
                      <span className={styles.runtimeBadge}>
                        {agent.executorType === null
                          ? translate('todo.agent_executor_from_definition', '执行器由智能体定义')
                          : agent.executorType === 'claude_code'
                            ? 'Claude Code'
                            : translate('todo.codex_agent', 'Codex')}
                      </span>
                      <span className={styles.metadata}>
                        {agent.definitionSource === 'shared_agent'
                          ? translate('todo.shared_agent', '共享智能体')
                          : agent.capabilityDescription ||
                            translate('todo.project_owned_agent', '项目智能体')}
                      </span>
                      {agent.definitionSource === 'project' ? (
                        <span
                          className={styles.capabilitySummary}
                          data-testid={`project-agent-capabilities-${agent.id}`}
                        >
                          {agent.additionalSkills.length} Skill · 项目空间 MCP
                          {Object.keys(agent.mcpServers).length
                            ? ` + ${Object.keys(agent.mcpServers).length} MCP`
                            : ''}
                        </span>
                      ) : null}
                    </span>
                  </div>
                  {agent.status === 'archived' || !agent.canUse ? (
                    <span data-testid={`project-agent-unavailable-${agent.id}`}>
                      {agent.status === 'archived'
                        ? translate('todo.agent_disabled', '已停用')
                        : agent.unavailableReason
                          ? translate('todo.agent_authorization_revoked', '资源授权已失效')
                          : translate('todo.agent_permission_readonly', '只读账号无法执行')}
                      {agent.unavailableReason === 'resource_sharing_required'
                        ? translate(
                            'todo.agent_resource_sharing_required',
                            '需要资源所有者共享到分组'
                          )
                        : agent.unavailableReason === 'private_binding_requires_explicit_share'
                          ? translate(
                              'todo.agent_private_share_required',
                              '原私有绑定需要明确共享后启用'
                            )
                          : ''}
                    </span>
                  ) : null}
                  {canManage ? (
                    <div className={styles.agentActions}>
                      {scope === 'project' && agent.status === 'archived' ? (
                        <button
                          type="button"
                          data-testid={`project-agent-reactivate-${agent.id}`}
                          disabled={archivingId === agent.id}
                          onClick={() => void resource.archiveAgent(agent, true)}
                        >
                          {translate('todo.agent_reactivate_share', '授权并重新启用')}
                        </button>
                      ) : null}
                      {agent.canEdit &&
                      ((agent.definitionSource === 'project' && usesProjectAgentEditor) ||
                        (agent.definitionSource === 'shared_agent' &&
                          host?.renderAgentEditor &&
                          agent.wegentTeamId !== null)) ? (
                        <button
                          className={styles.archiveButton}
                          data-testid={`project-agent-edit-${agent.id}`}
                          disabled={archivingId === agent.id}
                          onClick={() => resource.editAgent(agent.id)}
                          type="button"
                        >
                          {translate('todo.edit_project_agent', '编辑')}
                        </button>
                      ) : null}
                      {agent.deletable && agent.status !== 'archived' ? (
                        <button
                          className={styles.archiveButton}
                          data-testid={`project-agent-archive-${agent.id}`}
                          disabled={archivingId === agent.id}
                          onClick={() => void resource.archiveAgent(agent)}
                          type="button"
                        >
                          {archivingId === agent.id
                            ? translate('common.saving', '处理中…')
                            : scope === 'workspace'
                              ? translate('todo.remove_workspace_agent', '移出分组')
                              : translate('todo.archive_project_agent', '停用')}
                        </button>
                      ) : null}
                      {scope === 'project' && agent.deletable && (
                        <button
                          type="button"
                          className={styles.archiveButton}
                          data-testid={`project-agent-delete-${agent.id}`}
                          disabled={archivingId === agent.id}
                          onClick={() => resource.requestRemoval(agent)}
                        >
                          {translate('todo.delete_project_agent', '删除')}
                        </button>
                      )}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className={styles.empty} data-testid="project-agent-list-empty">
              {translate(
                scope === 'workspace' ? 'todo.no_workspace_agents' : 'todo.no_project_agents',
                scope === 'workspace' ? '当前分组还没有智能体。' : '当前项目还没有智能体。'
              )}
            </p>
          )}

          {pendingRemoval && (
            <ConfirmationDialog
              key={pendingRemoval.id}
              title={translate('todo.delete_project_agent_title', '删除项目智能体？')}
              subject={pendingRemoval.displayName}
              description={translate(
                'todo.delete_project_agent_hint',
                '将删除此项目中的智能体配置。共享资源、已有任务和执行历史会保留。若协作小组仍在引用它，请先替换或移除成员。'
              )}
              labels={{
                cancel: translate('common.cancel', '取消'),
                confirm: translate('todo.delete_project_agent', '删除'),
                pending: translate('common.saving', '处理中…'),
                failed: translate('todo.delete_project_agent_failed', '删除项目智能体失败'),
              }}
              testIdPrefix="project-agent-delete"
              onClose={() => resource.cancelRemoval(pendingRemoval)}
              onConfirm={() => resource.removeAgent(pendingRemoval)}
            />
          )}
          {composerOpen
            ? (customAgentCreator ??
              renderDialog(
                <ProjectAgentPicker
                  agents={workspaceAgents}
                  addedTeamIds={
                    new Set(
                      agents.flatMap(agent =>
                        agent.wegentTeamId === null ? [] : [agent.wegentTeamId]
                      )
                    )
                  }
                  selectedId={selectedTeamId}
                  loading={candidateLoading}
                  loadError={candidateError}
                  error={error}
                  busy={busy}
                  scope={scope}
                  translate={translate}
                  onSelect={resource.selectTeam}
                  onRetry={resource.retryCandidates}
                  onCreate={supportsAgentCreation ? resource.createAgent : undefined}
                  onClose={() => resource.closeComposer(composerVersion)}
                  onAdd={() => void resource.addExistingAgent(composerVersion)}
                />
              ))
            : null}

          {editingAgent &&
          editingAgent.definitionSource === 'project' &&
          usesProjectAgentEditor &&
          host?.renderProjectAgentEditor
            ? host.renderProjectAgentEditor({
                projectId: agentProjectId,
                resourceId: editingAgent.id,
                onClose: () => resource.closeEditor(editingVersion),
                onSaved: () =>
                  resource.finishAgentChange({ id: editingAgent.id, version: editingVersion }),
              })
            : editingAgent &&
                editingAgent.definitionSource === 'shared_agent' &&
                editingAgent.wegentTeamId !== null &&
                host?.renderAgentEditor
              ? host.renderAgentEditor({
                  projectId: scope === 'project' ? String(project.id) : undefined,
                  agent: { teamId: editingAgent.wegentTeamId },
                  namespace: creatorContext.namespace,
                  onClose: () => resource.closeEditor(editingVersion),
                  onSaved: saved =>
                    resource.saveEditedAgent(saved, {
                      id: editingAgent.id,
                      version: editingVersion,
                    }),
                  workspaceName: creatorContext.name,
                })
              : null}
        </>
      ) : null}
      {error && !composerOpen ? (
        <p className={styles.error} data-testid="project-agent-config-error">
          {error}
        </p>
      ) : null}
    </section>
  )
}
