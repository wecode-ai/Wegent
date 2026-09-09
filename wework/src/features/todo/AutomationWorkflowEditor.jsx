import { useEffect, useRef, useState } from 'react'
import {
  Activity,
  ArrowLeft,
  Box,
  Clock3,
  GitBranch,
  History,
  Pencil,
  Play,
  Webhook,
  X,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { AutomationWorkflowCanvas } from './AutomationWorkflowCanvas.jsx'
import { automationClass } from './automationStyles'
import { createCoordinator, triggerPresentation } from './AutomationRuleModel.jsx'
import {
  runMatchesFilter,
  runStatusPresentation,
  RuleRunsPanel,
  RunDetailPanel,
  RunStatusIcon,
} from './AutomationRunViews.jsx'
import { CoordinatorSettings, StepSettings } from './AutomationRoleSettings.jsx'
import { TriggerSettings } from './AutomationTriggerSettings.jsx'

export const AUTOMATION_PANEL_GAP = 12

export const AUTOMATION_RIGHT_PANEL_WIDTH = 400

export const AUTOMATION_RIGHT_PANEL_TOP = 64

export function WorkflowEditor({
  draft,
  runs,
  runsLoading,
  dirty,
  saveState,
  saveError,
  editorSection,
  selectedNode,
  panelTab,
  canRun,
  readOnly = false,
  running,
  onRun,
  projectTags,
  executionCatalog,
  onBack,
  onSelectNode,
  onPanelTabChange,
  onDraftChange,
  onRetrySave,
  onReviewLegacy,
  onAddStep,
  onRemoveStep,
  onOpenPluginMenu,
  onEditorSectionChange,
}) {
  const { t } = useTranslation()
  const [runStatus, setRunStatus] = useState('all')
  const [selectedRunId, setSelectedRunId] = useState(runs[0]?.id ?? null)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(draft.name)
  const renameInputRef = useRef(null)
  const deleteButtonRef = useRef(null)
  const needsSave = dirty || !draft.persisted
  const trigger = triggerPresentation(draft.trigger, t)
  const TriggerIcon = draft.trigger.type === 'schedule' ? Clock3 : Webhook
  const visibleRuns = runs.filter(run => runMatchesFilter(run.status, runStatus))
  const selectedRun = visibleRuns.find(run => run.id === selectedRunId) ?? visibleRuns[0] ?? null
  const latestRun = runs[0] ?? null
  const selectedStep =
    selectedNode.type === 'step'
      ? (draft.steps.find(step => step.id === selectedNode.id) ?? null)
      : null
  const hasSelectedNode = selectedNode.type !== 'none'
  const showRightPanel = editorSection === 'runs' || hasSelectedNode

  useEffect(() => {
    if (renaming) {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
      return
    }
    setRenameValue(draft.name)
  }, [draft.name, renaming])

  useEffect(() => {
    const deleteSelectedNode = event => {
      if (event.key !== 'Backspace' && event.key !== 'Delete') return
      if (
        event.target instanceof HTMLElement &&
        (event.target.isContentEditable ||
          event.target.closest(
            'input, textarea, select, [contenteditable="true"], [role="textbox"]'
          ))
      ) {
        return
      }

      const deleteButton = deleteButtonRef.current
      if (!deleteButton) return
      event.preventDefault()
      event.stopImmediatePropagation()
      deleteButton.click()
    }

    window.addEventListener('keydown', deleteSelectedNode, true)
    return () => window.removeEventListener('keydown', deleteSelectedNode, true)
  }, [])

  const updateTrigger = (key, value) => {
    onDraftChange(current => ({
      ...current,
      trigger: { ...current.trigger, [key]: value },
    }))
  }

  const updateRule = (key, value) => {
    onDraftChange(current => ({ ...current, [key]: value }))
  }

  const startRenaming = () => {
    setRenameValue(draft.name)
    setRenaming(true)
  }

  const commitRename = () => {
    const value = renameValue.trim()
    setRenameValue(value || draft.name)
    setRenaming(false)
    if (value && value !== draft.name) updateRule('name', value)
  }

  const cancelRename = () => {
    setRenameValue(draft.name)
    setRenaming(false)
  }

  const updateStep = (key, value) => {
    if (!selectedStep) return
    onDraftChange(current => ({
      ...current,
      steps: current.steps.map(step =>
        step.id === selectedStep.id
          ? {
              ...step,
              [key]: value,
              executionConfigOverride: [
                'model',
                'modelType',
                'modelOptions',
                'executionDeviceId',
                'executionEnvironment',
                'plugins',
                'projectPlugins',
                'workspacePolicy',
              ].includes(key)
                ? true
                : step.executionConfigOverride,
            }
          : step
      ),
    }))
  }

  const toggleStepDependency = (targetId, dependencyId) => {
    onDraftChange(current => ({
      ...current,
      steps: current.steps.map(step =>
        step.id === targetId
          ? {
              ...step,
              dependencies: step.dependencies.includes(dependencyId)
                ? step.dependencies.filter(id => id !== dependencyId)
                : [...step.dependencies, dependencyId],
              dependencyContext: step.dependencies.includes(dependencyId)
                ? Object.fromEntries(
                    Object.entries(step.dependencyContext).filter(([id]) => id !== dependencyId)
                  )
                : {
                    ...step.dependencyContext,
                    [dependencyId]: ['final_result', 'deliveries'],
                  },
            }
          : step
      ),
    }))
  }

  const moveStep = (stepId, x, y) => {
    onDraftChange(current => ({
      ...current,
      steps: current.steps.map(step => (step.id === stepId ? { ...step, x, y } : step)),
    }))
  }

  const insertNode = (anchorStepId, placement, kind) => {
    onAddStep(anchorStepId, placement, kind)
  }

  const updateAdvancement = mode => {
    if (readOnly || mode === draft.advancement) return
    onDraftChange(current => ({
      ...current,
      advancement: mode,
      coordinator:
        mode === 'ai'
          ? (current.coordinator ?? createCoordinator(executionCatalog))
          : current.coordinator,
    }))
    if (mode === 'ai') {
      onEditorSectionChange('workflow')
      onSelectNode({ type: 'trigger' })
      onPanelTabChange('settings')
    }
  }

  const workspaceActions = (
    <div
      className={automationClass('editor-global-actions')}
      data-testid="automation-editor-global-actions"
    >
      <fieldset
        className={automationClass('editor-advancement')}
        data-testid="automation-advancement-control"
        disabled={readOnly}
      >
        <legend className="sr-only">{t('todo.automation_advancement')}</legend>
        {['sequential', 'ai'].map(mode => (
          <button
            key={mode}
            type="button"
            data-testid={`automation-advancement-${mode}`}
            className={draft.advancement === mode ? 'selected' : ''}
            aria-pressed={draft.advancement === mode}
            title={t(`todo.automation_advancement_${mode}_help`)}
            disabled={readOnly}
            onClick={() => updateAdvancement(mode)}
          >
            {t(`todo.automation_advancement_${mode}`)}
          </button>
        ))}
      </fieldset>
      {readOnly ? (
        <span data-testid="automation-read-only" title={t('todo.automation_read_only')}>
          {t('todo.automation_read_only_short')}
        </span>
      ) : draft.origin === 'legacy_workflow' ? (
        <button
          type="button"
          data-testid="automation-review-legacy"
          disabled={saveState === 'saving'}
          onClick={onReviewLegacy}
        >
          {t('todo.automation_review_legacy')}
        </button>
      ) : saveState === 'error' ? (
        <button
          type="button"
          className={automationClass('editor-save-state error')}
          data-testid="automation-save-retry"
          title={saveError}
          onClick={onRetrySave}
        >
          <i />
          保存失败，点击重试
        </button>
      ) : (
        <span className={automationClass(`editor-save-state ${saveState}`)} title={saveError}>
          <i />
          {saveState === 'saving'
            ? '保存中'
            : saveState === 'invalid'
              ? '等待补全'
              : saveState === 'pending' || needsSave
                ? '待保存'
                : '已保存'}
        </span>
      )}
      {draft.origin === 'legacy_workflow' && saveError ? (
        <p
          role="alert"
          data-testid="automation-legacy-save-error"
          className="max-w-sm text-sm text-destructive"
        >
          {saveError}
        </p>
      ) : null}
      {draft.trigger.type === 'schedule' ? (
        <button
          className={automationClass('dark-secondary')}
          data-testid="automation-run"
          disabled={!canRun || needsSave || saveState !== 'saved' || running}
          title={needsSave ? t('workbench.board_automation_save_first') : undefined}
          onClick={onRun}
        >
          <Play size={16} />
          {t(running ? 'workbench.board_automation_running' : 'workbench.board_automation_run')}
        </button>
      ) : null}
    </div>
  )

  return (
    <div
      className={automationClass('editor-shell')}
      data-testid="automation-rule-editor"
      style={{
        '--automation-panel-gap': `${AUTOMATION_PANEL_GAP}px`,
        '--automation-right-panel-width': showRightPanel
          ? `${AUTOMATION_RIGHT_PANEL_WIDTH}px`
          : '0px',
        '--automation-right-panel-top': `${AUTOMATION_RIGHT_PANEL_TOP}px`,
      }}
    >
      <div className={automationClass('editor-body')}>
        <div className={automationClass('editor-toolbar')} data-testid="automation-editor-toolbar">
          <div
            className={automationClass('editor-navigation-actions')}
            data-testid="automation-editor-navigation"
          >
            <div
              className={automationClass('editor-object-bar')}
              data-testid="automation-editor-object-bar"
            >
              <button
                className={automationClass('editor-back-button')}
                data-testid="automation-editor-back"
                onClick={onBack}
                aria-label="返回"
              >
                <ArrowLeft size={16} />
              </button>
              <span className={automationClass('editor-object-divider')} />
              {renaming ? (
                <input
                  ref={renameInputRef}
                  className={automationClass('editor-name-input')}
                  data-testid="automation-editor-name-input"
                  value={renameValue}
                  onChange={event => setRenameValue(event.target.value)}
                  onBlur={commitRename}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitRename()
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      cancelRename()
                    }
                  }}
                  aria-label="自动化名称"
                  spellCheck={false}
                />
              ) : (
                <button
                  type="button"
                  className={automationClass('editor-name-button')}
                  data-testid="automation-editor-name"
                  disabled={readOnly}
                  title={draft.name}
                  aria-label={`重命名自动化：${draft.name}`}
                  onClick={startRenaming}
                >
                  <span>{draft.name}</span>
                  <Pencil size={16} />
                </button>
              )}
            </div>

            <div
              className={automationClass('editor-view-tabs')}
              data-testid="automation-editor-section-menu"
              role="tablist"
              aria-label="自动化视图"
            >
              <button
                type="button"
                role="tab"
                aria-selected={editorSection === 'workflow'}
                className={automationClass(
                  'editor-view-tab',
                  editorSection === 'workflow' && 'active'
                )}
                data-testid="editor-nav-workflow"
                onClick={() => onEditorSectionChange('workflow')}
              >
                <GitBranch size={16} />
                <span>编排</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={editorSection === 'runs'}
                className={automationClass('editor-view-tab', editorSection === 'runs' && 'active')}
                data-testid="open-current-automation-runs"
                onClick={() => onEditorSectionChange('runs')}
              >
                <History size={16} />
                <span>运行记录</span>
              </button>
            </div>
          </div>

          {workspaceActions}
        </div>

        {editorSection === 'workflow' ? (
          <main className={automationClass('workflow-canvas')}>
            <AutomationWorkflowCanvas
              draft={draft}
              readOnly={readOnly}
              trigger={trigger}
              selectedNode={selectedNode}
              rightPanelInset={
                showRightPanel ? AUTOMATION_RIGHT_PANEL_WIDTH + AUTOMATION_PANEL_GAP : 0
              }
              onSelectNode={onSelectNode}
              onInsertNode={insertNode}
              onToggleStepDependency={toggleStepDependency}
              onMoveStep={moveStep}
            />
          </main>
        ) : (
          <RuleRunsPanel
            runs={visibleRuns}
            loading={runsLoading}
            status={runStatus}
            selectedRun={selectedRun}
            onStatusChange={setRunStatus}
            onSelectRun={run => setSelectedRunId(run.id)}
          />
        )}

        {editorSection === 'workflow' ? (
          hasSelectedNode ? (
            <aside
              className={automationClass('editor-rightbar')}
              data-testid="automation-editor-rightbar"
            >
              <div className={automationClass('node-panel')}>
                <div className={automationClass('panel-head')}>
                  <span className={automationClass(`node-icon ${selectedNode.type}`)}>
                    {selectedNode.type === 'trigger' ? (
                      <TriggerIcon size={17} />
                    ) : (
                      <Box size={17} />
                    )}
                  </span>
                  <div className={automationClass('panel-head-copy')}>
                    <strong>
                      {selectedNode.type === 'trigger'
                        ? t(
                            draft.advancement === 'ai'
                              ? 'todo.automation_ai_entry'
                              : 'todo.automation_trigger_entry'
                          )
                        : selectedStep?.name || t('todo.assignment_role_name')}
                    </strong>
                    <small>
                      {selectedNode.type === 'trigger'
                        ? '整条自动化的入口'
                        : t('todo.assignment_role_duties')}
                    </small>
                  </div>
                  <button
                    type="button"
                    className={automationClass('panel-close')}
                    data-testid="automation-editor-close-rightbar"
                    aria-label="关闭节点详情"
                    onClick={() => onSelectNode({ type: 'none' })}
                  >
                    <X size={17} />
                  </button>
                </div>

                <div className={automationClass('panel-tabs')}>
                  <button
                    type="button"
                    className={panelTab === 'settings' ? 'active' : ''}
                    data-testid="automation-panel-tab-settings"
                    onClick={() => onPanelTabChange('settings')}
                  >
                    设置
                  </button>
                  <button
                    type="button"
                    className={panelTab === 'lastRun' ? 'active' : ''}
                    data-testid="automation-panel-tab-last-run"
                    onClick={() => onPanelTabChange('lastRun')}
                  >
                    上次运行
                  </button>
                </div>

                {panelTab === 'lastRun' ? (
                  <div className={automationClass('last-run-panel')}>
                    {runsLoading ? (
                      <>
                        <Activity className={automationClass('spin')} size={24} />
                        <strong>正在加载运行记录</strong>
                      </>
                    ) : latestRun ? (
                      <>
                        <RunStatusIcon status={latestRun.status} size={24} />
                        <strong>最近一次：{runStatusPresentation(latestRun.status).label}</strong>
                        <span>
                          {latestRun.startedAt} · {latestRun.duration}
                        </span>
                        <button onClick={() => onEditorSectionChange('runs')}>
                          查看完整运行记录
                        </button>
                      </>
                    ) : (
                      <>
                        <History size={24} />
                        <strong>暂无运行记录</strong>
                        <span>测试或触发自动化后，这里会显示最近一次结果。</span>
                      </>
                    )}
                  </div>
                ) : (
                  <fieldset
                    disabled={readOnly}
                    className={automationClass('panel-content')}
                    data-testid="automation-settings-fields"
                  >
                    {selectedNode.type === 'trigger' ? (
                      <>
                        {draft.advancement === 'ai' && draft.coordinator ? (
                          <CoordinatorSettings
                            coordinator={draft.coordinator}
                            executionCatalog={executionCatalog}
                            onChange={(key, value) =>
                              onDraftChange(current => ({
                                ...current,
                                coordinator: { ...current.coordinator, [key]: value },
                              }))
                            }
                            onOpenPluginMenu={onOpenPluginMenu}
                          />
                        ) : null}
                        <TriggerSettings
                          draft={draft}
                          projectTags={projectTags}
                          onChange={updateTrigger}
                          onRuleChange={updateRule}
                        />
                      </>
                    ) : (
                      <StepSettings
                        step={selectedStep}
                        advancement={draft.advancement}
                        executionCatalog={executionCatalog}
                        onChange={updateStep}
                        onDelete={onRemoveStep}
                        deleteButtonRef={deleteButtonRef}
                        onOpenPluginMenu={onOpenPluginMenu}
                      />
                    )}
                  </fieldset>
                )}
              </div>
            </aside>
          ) : null
        ) : (
          <aside
            className={automationClass('editor-rightbar')}
            data-testid="automation-editor-rightbar"
          >
            <RunDetailPanel run={selectedRun} steps={draft.steps} />
          </aside>
        )}
      </div>
    </div>
  )
}
