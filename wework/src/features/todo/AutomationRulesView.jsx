import { createLoopNode, createBranchNode } from './AutomationRuleModel.jsx'
import {
  OUTER_NODE_WIDTH,
  OUTER_NODE_HEIGHT,
  OUTER_NODE_GAP,
  stepCanvasSize,
} from './canvasGeometry'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Circle,
  History,
  LayoutGrid,
  Plus,
  Search,
  Sparkles,
  Tag,
  X,
  XCircle,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { automationClass } from './automationStyles'
import {
  createExecutionNode,
  defaultExecutionConfiguration,
  triggerPresentation,
  cloneRule,
  validateRule,
  mergeSavedIdentity,
  makeRule,
  makeRuleFromTemplate,
} from './AutomationRuleModel.jsx'
import { automationTemplates, TemplateStore } from './AutomationTemplateStore.jsx'
import { AutomationCard, RunsHome } from './AutomationRunViews.jsx'
import { WorkflowEditor } from './AutomationWorkflowEditor.jsx'

export const AUTO_SAVE_DELAY_MS = 600

export const EMPTY_EXECUTION_CATALOG = { environments: [], models: [], plugins: [] }

export function AutomationRulesView({
  rules: backendRules,
  runs: backendRuns,
  loading = false,
  error = '',
  canManage = true,
  projectTags = [],
  eventSourceCatalog = [],
  projectIncomingHookApi,
  projectId,
  project,
  executionCatalog: initialExecutionCatalog = EMPTY_EXECUTION_CATALOG,
  onReload,
  onLoadExecutionCatalog,
  onLoadExecutionPlugins,
  onLoadRuns,
  onRunRule,
  onSaveRule,
  onToggleRule,
  onDuplicateRule,
  onDeleteRule,
}) {
  const { t } = useTranslation('common')
  const runningRef = useRef(new Set())
  const [runningIds, setRunningIds] = useState(new Set())
  const runRule = async rule => {
    if (!onRunRule || !canManage || !rule.persisted || runningRef.current.has(rule.id)) return
    runningRef.current.add(rule.id)
    setRunningIds(new Set(runningRef.current))
    try {
      await onRunRule(rule)
      notify(t('workbench.board_automation_run_started'))
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error))
    } finally {
      runningRef.current.delete(rule.id)
      setRunningIds(new Set(runningRef.current))
    }
  }
  const [view, setView] = useState('home')
  const [homeTab, setHomeTab] = useState('rules')
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [rules, setRules] = useState(backendRules)
  const [runs, setRuns] = useState(backendRuns)
  const [executionCatalog, setExecutionCatalog] = useState(initialExecutionCatalog)
  const [draft, setDraft] = useState(makeRule)
  const [savedSnapshot, setSavedSnapshot] = useState('')
  const [editorSection, setEditorSection] = useState('workflow')
  const [selectedNode, setSelectedNode] = useState({ type: 'trigger' })
  const [panelTab, setPanelTab] = useState('settings')
  const [templateStoreOpen, setTemplateStoreOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [saveState, setSaveState] = useState('saved')
  const [saveError, setSaveError] = useState('')
  const [runsLoading, setRunsLoading] = useState(false)
  const draftRef = useRef(draft)
  const savedSnapshotRef = useRef('')
  const saveTimerRef = useRef(null)
  const saveRequestRef = useRef(null)
  const flushAutoSaveRef = useRef(null)
  const failedSnapshotRef = useRef('')
  const leavingEditorRef = useRef(false)
  const executionCatalogRequestRef = useRef(null)
  const executionPluginRequestRef = useRef(null)
  const runsRequestRef = useRef(null)
  const pollingSubscriptionRef = useRef(null)
  const toastTimerRef = useRef(null)

  const dirty = JSON.stringify(draft) !== savedSnapshot

  useEffect(() => {
    setRules(backendRules)
  }, [backendRules])

  useEffect(() => {
    if (!draft.persisted || JSON.stringify(draft) !== savedSnapshot) return
    const refreshed = backendRules.find(rule => rule.id === draft.id)
    if (!refreshed) return
    if (refreshed.version <= draft.version) return
    const refreshedSnapshot = JSON.stringify(refreshed)
    if (refreshedSnapshot === savedSnapshot) return
    const nextDraft = cloneRule(refreshed)
    draftRef.current = nextDraft
    savedSnapshotRef.current = refreshedSnapshot
    setDraft(nextDraft)
    setSavedSnapshot(refreshedSnapshot)
    setSaveState('saved')
  }, [backendRules, draft, savedSnapshot])

  useEffect(() => {
    setRuns(backendRuns)
  }, [backendRuns])

  useEffect(() => {
    setExecutionCatalog(initialExecutionCatalog)
  }, [initialExecutionCatalog])

  useEffect(
    () => () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current)
      }
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
      }
    },
    []
  )

  const visibleRules = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return rules.filter(rule => {
      const matchesStatus =
        filter === 'all' || (filter === 'enabled' ? rule.enabled : !rule.enabled)
      const trigger = triggerPresentation(rule.trigger, t)
      const matchesQuery =
        !normalized ||
        `${rule.name} ${rule.description} ${trigger.label}`.toLowerCase().includes(normalized)
      return matchesStatus && matchesQuery
    })
  }, [filter, query, rules, t])

  const notify = message => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current)
    }
    setToast(message)
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null
      setToast('')
    }, 2200)
  }

  const loadExecutionCatalog = async () => {
    if (!onLoadExecutionCatalog) return executionCatalog
    if (!executionCatalogRequestRef.current) {
      executionCatalogRequestRef.current = onLoadExecutionCatalog()
        .then(catalog => {
          setExecutionCatalog(current => ({
            ...catalog,
            plugins: current.plugins,
          }))
          return catalog
        })
        .finally(() => {
          executionCatalogRequestRef.current = null
        })
    }
    return executionCatalogRequestRef.current
  }

  const refreshExecutionCatalog = () => {
    void loadExecutionCatalog().catch(loadError => {
      notify(loadError instanceof Error ? loadError.message : String(loadError))
    })
  }

  const loadExecutionPlugins = async () => {
    if (!onLoadExecutionPlugins) return executionCatalog.plugins
    if (!executionPluginRequestRef.current) {
      executionPluginRequestRef.current = onLoadExecutionPlugins()
        .then(plugins => {
          setExecutionCatalog(current => ({ ...current, plugins }))
          return plugins
        })
        .finally(() => {
          executionPluginRequestRef.current = null
        })
    }
    return executionPluginRequestRef.current
  }

  const preparePluginMenu = () => {
    void loadExecutionPlugins().catch(loadError => {
      notify(loadError instanceof Error ? loadError.message : String(loadError))
    })
  }

  const openRule = rule => {
    const nextDraft = cloneRule(rule)
    const nextSnapshot = JSON.stringify(rule)
    draftRef.current = nextDraft
    savedSnapshotRef.current = nextSnapshot
    failedSnapshotRef.current = ''
    setDraft(nextDraft)
    setSavedSnapshot(nextSnapshot)
    setSaveState('saved')
    setSaveError('')
    setEditorSection('workflow')
    setSelectedNode({ type: 'trigger' })
    setPanelTab('settings')
    setView('editor')
    refreshExecutionCatalog()
  }

  const createRule = () => {
    if (!canManage) return
    const rule = makeRule()
    const nextSnapshot = JSON.stringify(rule)
    draftRef.current = rule
    savedSnapshotRef.current = nextSnapshot
    failedSnapshotRef.current = ''
    setDraft(rule)
    setSavedSnapshot(nextSnapshot)
    setSaveState('pending')
    setSaveError('')
    setEditorSection('workflow')
    setSelectedNode({ type: 'trigger' })
    setPanelTab('settings')
    setView('editor')
    refreshExecutionCatalog()
  }

  const ensureTriggerPollingSubscription = async trigger => {
    if (
      !projectIncomingHookApi ||
      !projectId ||
      trigger.collectionMode !== 'poll' ||
      trigger.subscriptionId
    ) {
      return
    }
    const repository = project?.provider_config?.repository?.trim()
    const domain = project?.provider_config?.domain?.trim()
    if (!repository || project?.task_provider !== trigger.source) return
    const defaultDomain = trigger.source === 'github' ? 'github.com' : 'gitlab.com'
    const resourceUrl = `https://${domain || defaultDomain}/${repository}`
    try {
      const existing = (await projectIncomingHookApi.list(projectId)).find(
        item =>
          item.collectionMode === 'poll' &&
          item.sourceType === trigger.source &&
          item.resource?.url === resourceUrl
      )
      if (existing) {
        pollingSubscriptionRef.current = existing
        updateDraft(current =>
          current.trigger.subscriptionId === existing.id
            ? current
            : { ...current, trigger: { ...current.trigger, subscriptionId: existing.id } }
        )
        return
      }
      const created = await projectIncomingHookApi.create(projectId, {
        name: `${project.name} 轮询`,
        sourceType: trigger.source,
        collectionMode: 'poll',
        resource: { url: resourceUrl },
        pollIntervalSeconds: 300,
        credentialRef: 'project-provider',
      })
      pollingSubscriptionRef.current = created
      updateDraft(current => ({
        ...current,
        trigger: { ...current.trigger, subscriptionId: created.id },
      }))
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error))
    }
  }

  const applyTemplate = template => {
    if (!canManage) return
    const rule = makeRuleFromTemplate(template, executionCatalog)
    draftRef.current = rule
    savedSnapshotRef.current = ''
    failedSnapshotRef.current = ''
    setTemplateStoreOpen(false)
    setDraft(rule)
    setSavedSnapshot('')
    setSaveState('pending')
    setSaveError('')
    setEditorSection('workflow')
    setSelectedNode({ type: 'trigger' })
    setPanelTab('settings')
    setView('editor')
    refreshExecutionCatalog()
  }

  const loadRuns = async () => {
    if (!onLoadRuns) return runs
    if (!runsRequestRef.current) {
      setRunsLoading(true)
      runsRequestRef.current = onLoadRuns()
        .then(loadedRuns => {
          setRuns(loadedRuns)
          return loadedRuns
        })
        .catch(loadError => {
          notify(loadError instanceof Error ? loadError.message : String(loadError))
          throw loadError
        })
        .finally(() => {
          setRunsLoading(false)
          runsRequestRef.current = null
        })
    }
    return runsRequestRef.current
  }

  const openRunsHome = () => {
    setHomeTab('runs')
    void loadRuns().catch(() => undefined)
  }

  const changeEditorSection = section => {
    setEditorSection(section)
    if (section === 'runs') void loadRuns().catch(() => undefined)
  }

  const changePanelTab = tab => {
    setPanelTab(tab)
    if (tab === 'lastRun') void loadRuns().catch(() => undefined)
  }

  const updateDraft = updater => {
    if (!canManage) return
    const nextDraft = typeof updater === 'function' ? updater(draftRef.current) : updater
    draftRef.current = nextDraft
    setDraft(nextDraft)
  }

  const flushAutoSave = async ({ retryFailed = false, reviewLegacy = false } = {}) => {
    if (!canManage) return null
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    if (saveRequestRef.current) {
      return saveRequestRef.current
    }

    const candidate = cloneRule(draftRef.current)
    if (candidate.origin === 'legacy_workflow' && !reviewLegacy) {
      notify(t('todo.automation_review_legacy'))
      return null
    }
    const candidateSnapshot = JSON.stringify(candidate)
    if (candidateSnapshot === savedSnapshotRef.current && !reviewLegacy) {
      setSaveState(candidate.persisted ? 'saved' : 'pending')
      return candidate
    }

    const validationError = validateRule(candidate)
    if (validationError) {
      setSaveState('invalid')
      setSaveError(validationError)
      return null
    }
    if (failedSnapshotRef.current === candidateSnapshot && !retryFailed) {
      setSaveState('error')
      return null
    }

    failedSnapshotRef.current = ''
    setSaveState('saving')
    setSaveError('')
    const request = (async () => {
      try {
        const saved = onSaveRule ? await onSaveRule(candidate) : candidate
        const nextSavedSnapshot = JSON.stringify(saved)
        savedSnapshotRef.current = nextSavedSnapshot
        setSavedSnapshot(nextSavedSnapshot)
        setRules(current => [
          saved,
          ...current.filter(rule => rule.id !== candidate.id && rule.id !== saved.id),
        ])
        const currentDraft = draftRef.current
        const nextDraft =
          JSON.stringify(currentDraft) === candidateSnapshot
            ? cloneRule(saved)
            : mergeSavedIdentity(currentDraft, saved)
        draftRef.current = nextDraft
        setDraft(nextDraft)
        setSaveState(JSON.stringify(draftRef.current) === nextSavedSnapshot ? 'saved' : 'pending')
        return saved
      } catch (requestError) {
        failedSnapshotRef.current = candidateSnapshot
        setSaveError(requestError instanceof Error ? requestError.message : String(requestError))
        setSaveState('error')
        return null
      } finally {
        saveRequestRef.current = null
        const latestSnapshot = JSON.stringify(draftRef.current)
        const latestValidationError = validateRule(draftRef.current)
        const shouldContinue =
          draftRef.current.origin !== 'legacy_workflow' &&
          latestSnapshot !== savedSnapshotRef.current &&
          latestSnapshot !== failedSnapshotRef.current &&
          !latestValidationError
        if (shouldContinue) {
          setSaveState('pending')
          queueMicrotask(() => flushAutoSaveRef.current?.())
        } else if (latestValidationError) {
          setSaveError(latestValidationError)
          setSaveState('invalid')
        }
      }
    })()
    saveRequestRef.current = request
    return request
  }
  flushAutoSaveRef.current = flushAutoSave

  useEffect(() => {
    if (view !== 'editor' || !canManage || draft.origin === 'legacy_workflow') return undefined
    const currentSnapshot = JSON.stringify(draft)
    if (currentSnapshot === savedSnapshot) {
      if (!saveRequestRef.current) setSaveState(draft.persisted ? 'saved' : 'pending')
      return undefined
    }

    const validationError = validateRule(draft)
    if (validationError) {
      setSaveError(validationError)
      setSaveState('invalid')
      return undefined
    }
    if (saveRequestRef.current) {
      return undefined
    }
    if (failedSnapshotRef.current === currentSnapshot) {
      setSaveState('error')
      return undefined
    }

    setSaveError('')
    setSaveState('pending')
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void flushAutoSaveRef.current?.()
    }, AUTO_SAVE_DELAY_MS)
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [canManage, draft, savedSnapshot, view])

  const leaveEditor = async () => {
    if (!canManage) {
      setView('home')
      return
    }
    if (leavingEditorRef.current) return
    leavingEditorRef.current = true
    try {
      while (true) {
        if (saveRequestRef.current) await saveRequestRef.current
        if (JSON.stringify(draftRef.current) === savedSnapshotRef.current) break
        const validationError = validateRule(draftRef.current)
        if (validationError) {
          setSaveError(validationError)
          setSaveState('invalid')
          notify(validationError)
          return
        }
        const saved = await flushAutoSaveRef.current?.({ retryFailed: true })
        if (!saved) return
      }
      setView('home')
    } finally {
      leavingEditorRef.current = false
    }
  }

  const retryAutoSave = () => {
    failedSnapshotRef.current = ''
    void flushAutoSaveRef.current?.({ retryFailed: true })
  }

  const duplicateRule = async rule => {
    if (!canManage) return
    try {
      const copy = onDuplicateRule
        ? await onDuplicateRule(rule)
        : {
            ...cloneRule(rule),
            id: `draft-${crypto.randomUUID()}`,
            persisted: false,
            origin: 'automation',
            version: 1,
            name: `${rule.name} 副本`,
            enabled: false,
          }
      setRules(current => [copy, ...current.filter(item => item.id !== copy.id)])
      notify('已创建独立副本')
    } catch (duplicateError) {
      notify(duplicateError instanceof Error ? duplicateError.message : String(duplicateError))
    }
  }

  const deleteRule = async rule => {
    if (!canManage) return
    try {
      await onDeleteRule?.(rule)
      setRules(current => current.filter(item => item.id !== rule.id))
      setRuns(current => current.filter(run => run.ruleId !== rule.id))
      notify('自动化已删除')
    } catch (deleteError) {
      notify(deleteError instanceof Error ? deleteError.message : String(deleteError))
    }
  }

  const addStep = (anchorStepId, placement = 'after', kind = 'task') => {
    const step =
      kind === 'loop'
        ? createLoopNode()
        : kind === 'branch'
          ? createBranchNode()
          : createExecutionNode({
              ...defaultExecutionConfiguration(executionCatalog),
              id: `step-${Date.now()}`,
              name: '',
              prompt: '',
            })
    updateDraft(current => {
      const anchorIndex = anchorStepId
        ? current.steps.findIndex(candidate => candidate.id === anchorStepId)
        : -1
      const anchor = anchorIndex >= 0 ? current.steps[anchorIndex] : null
      if (anchorStepId && !anchor) return current
      if (placement === 'before' && !anchor) return current

      const anchorSize = anchor
        ? stepCanvasSize(anchor)
        : { width: OUTER_NODE_WIDTH, height: OUTER_NODE_HEIGHT }
      const stepSize = stepCanvasSize(step)
      const insertionX =
        placement === 'before'
          ? (anchor?.x ?? 440)
          : anchor
            ? anchor.x + anchorSize.width + OUTER_NODE_GAP
            : 440
      const insertionY = anchor?.y ?? 226
      const shift = Math.max(OUTER_NODE_WIDTH + OUTER_NODE_GAP, stepSize.width + OUTER_NODE_GAP)
      const shifted = current.steps.map(candidate =>
        candidate.id !== anchor?.id && candidate.x >= insertionX
          ? { ...candidate, x: candidate.x + shift }
          : candidate
      )
      const inheritedDependencies =
        placement === 'before' ? [...anchor.dependencies] : anchor ? [anchor.id] : []
      const inserted = {
        ...step,
        dependencies: inheritedDependencies,
        dependencyContext:
          placement === 'before'
            ? { ...(anchor.dependencyContext ?? {}) }
            : Object.fromEntries(
                inheritedDependencies.map(dependencyId => [
                  dependencyId,
                  ['final_result', 'deliveries'],
                ])
              ),
        x: insertionX,
        y: insertionY,
      }
      const rewired = shifted.map(candidate => {
        if (placement === 'before' && candidate.id === anchor.id) {
          return {
            ...candidate,
            x: candidate.x + 420,
            dependencies: [inserted.id],
            dependencyContext: {
              [inserted.id]: ['final_result', 'deliveries'],
            },
          }
        }

        const followsAnchor = anchor
          ? candidate.dependencies.includes(anchor.id)
          : candidate.dependencies.length === 0
        if (placement !== 'after' || !followsAnchor) return candidate
        const inheritedContext = anchor
          ? (candidate.dependencyContext?.[anchor.id] ?? ['final_result', 'deliveries'])
          : ['final_result', 'deliveries']
        return {
          ...candidate,
          dependencies: anchor
            ? candidate.dependencies.map(dependencyId =>
                dependencyId === anchor.id ? inserted.id : dependencyId
              )
            : [inserted.id],
          dependencyContext: {
            ...Object.fromEntries(
              Object.entries(candidate.dependencyContext ?? {}).filter(
                ([dependencyId]) => dependencyId !== anchor?.id
              )
            ),
            [inserted.id]: inheritedContext,
          },
        }
      })
      const next = [...rewired]
      next.splice(placement === 'before' ? anchorIndex : anchorIndex + 1, 0, inserted)
      return { ...current, steps: next }
    })
    setSelectedNode({ type: 'step', id: step.id })
  }

  const removeStep = (stepId = selectedNode.id) => {
    if (!stepId) return
    updateDraft(current => {
      const removed = current.steps.find(step => step.id === stepId)
      if (!removed) return current
      return {
        ...current,
        steps: current.steps
          .filter(step => step.id !== stepId)
          .map(step => {
            const cleanedConditions = (step.branchConditions ?? [])
              .map(condition => ({
                ...condition,
                handlerNodeIds: condition.handlerNodeIds.filter(id => id !== stepId),
              }))
              .filter(condition => condition.handlerNodeIds.length > 0)
            if (!step.dependencies.includes(stepId)) {
              return { ...step, branchConditions: cleanedConditions }
            }
            const dependencies = Array.from(
              new Set([
                ...step.dependencies.filter(dependencyId => dependencyId !== stepId),
                ...removed.dependencies,
              ])
            )
            return {
              ...step,
              dependencies,
              branchConditions: cleanedConditions,
              dependencyContext: Object.fromEntries(
                dependencies.map(dependencyId => [
                  dependencyId,
                  step.dependencyContext[dependencyId] ??
                    removed.dependencyContext[dependencyId] ?? ['final_result', 'deliveries'],
                ])
              ),
            }
          }),
      }
    })
    setSelectedNode({ type: 'trigger' })
  }

  if (view === 'editor') {
    const editor = (
      <div className={automationClass('project-editor-host')}>
        <WorkflowEditor
          draft={draft}
          runs={runs.filter(run => run.ruleId === draft.id)}
          runsLoading={runsLoading}
          dirty={dirty}
          saveState={saveState}
          saveError={saveError}
          editorSection={editorSection}
          selectedNode={selectedNode}
          panelTab={panelTab}
          canManage={canManage}
          canRun={canManage && Boolean(onRunRule)}
          readOnly={!canManage}
          running={runningIds.has(draft.id)}
          onRun={() => runRule(draft)}
          projectTags={projectTags}
          eventSourceCatalog={eventSourceCatalog}
          projectIncomingHookApi={projectIncomingHookApi}
          projectId={projectId}
          executionCatalog={executionCatalog}
          onBack={leaveEditor}
          onEditorSectionChange={changeEditorSection}
          onSelectNode={setSelectedNode}
          onPanelTabChange={changePanelTab}
          onDraftChange={updateDraft}
          onRetrySave={retryAutoSave}
          onReviewLegacy={() => flushAutoSave({ retryFailed: true, reviewLegacy: true })}
          onAddStep={addStep}
          onRemoveStep={removeStep}
          onOpenPluginMenu={preparePluginMenu}
          onTriggerCollectionModeChange={() =>
            void ensureTriggerPollingSubscription(draftRef.current.trigger)
          }
        />
      </div>
    )
    return (
      <div
        className={automationClass('automation-root editor')}
        data-testid="project-automation-view"
      >
        {editor}
        {toast ? (
          <div className={automationClass('toast')}>
            <CheckCircle2 size={16} />
            {toast}
          </div>
        ) : null}
      </div>
    )
  }

  const content = (
    <main className={automationClass('project-content')}>
      <div className={automationClass('project-page-title')}>
        <div>
          <h1>{homeTab === 'rules' ? '自动化' : '运行记录'}</h1>
          <p>
            {homeTab === 'rules'
              ? '统一配置触发规则和执行流程，查看每条自动化的运行状态。'
              : '查看当前项目内所有自动化的执行过程、结果与耗时。'}
          </p>
        </div>
        {homeTab === 'rules' ? (
          <div className={automationClass('project-page-actions')}>
            <button
              className={automationClass('project-secondary-action')}
              data-testid="automation-open-runs"
              onClick={openRunsHome}
            >
              <History size={15} />
              运行记录
            </button>
            <button
              className={automationClass('project-primary-action')}
              data-testid="automation-create-rule"
              disabled={!canManage}
              onClick={() => createRule()}
            >
              <Plus size={15} />
              新建自动化
            </button>
          </div>
        ) : null}
      </div>

      {homeTab === 'rules' ? (
        <section className={automationClass('automation-home')}>
          <div className={automationClass('home-toolbar')}>
            <div className={automationClass('filter-tabs')}>
              {[
                ['all', '全部'],
                ['enabled', '已启用'],
                ['paused', '已暂停'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  className={filter === value ? 'active' : ''}
                  onClick={() => setFilter(value)}
                >
                  {value === 'all' ? <LayoutGrid size={15} /> : <Circle size={13} />}
                  {label}
                </button>
              ))}
            </div>
            <div className={automationClass('toolbar-actions')}>
              <button className={automationClass('quiet-filter')}>
                <Tag size={15} />
                全部标签
                <ChevronDown size={14} />
              </button>
              <label className={automationClass('home-search')}>
                <Search size={15} />
                <input
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  placeholder="搜索自动化"
                />
                {query ? (
                  <button onClick={() => setQuery('')} aria-label="清除搜索">
                    <X size={13} />
                  </button>
                ) : null}
              </label>
            </div>
          </div>

          <section className={automationClass('automation-grid')}>
            <div className={automationClass('create-card')}>
              <h2>创建自动化</h2>
              <button
                data-testid="automation-create-blank"
                disabled={!canManage}
                onClick={() => createRule()}
              >
                <Plus size={18} />
                <span>
                  <strong>创建空白自动化</strong>
                  <small>从触发规则开始配置</small>
                </span>
              </button>
              <button
                data-testid="open-template-store"
                disabled={!canManage}
                onClick={() => setTemplateStoreOpen(true)}
              >
                <Sparkles size={18} />
                <span>
                  <strong>从模板创建</strong>
                  <small>浏览内置模板并一键应用</small>
                </span>
              </button>
            </div>

            {loading ? (
              <div className={automationClass('home-empty')}>
                <Activity className={automationClass('spin')} size={22} />
                <strong>正在加载自动化</strong>
                <span>正在读取当前项目的自动化规则。</span>
              </div>
            ) : null}

            {!loading &&
              visibleRules.map(rule => (
                <AutomationCard
                  key={rule.id}
                  rule={rule}
                  onOpen={() => openRule(rule)}
                  onRun={onRunRule ? () => runRule(rule) : undefined}
                  running={runningIds.has(rule.id)}
                  canManage={canManage}
                  onToggle={async () => {
                    try {
                      const updated = onToggleRule
                        ? await onToggleRule(rule, !rule.enabled)
                        : { ...rule, enabled: !rule.enabled }
                      setRules(current =>
                        current.map(item => (item.id === rule.id ? updated : item))
                      )
                    } catch (toggleError) {
                      notify(
                        toggleError instanceof Error ? toggleError.message : String(toggleError)
                      )
                    }
                  }}
                  onDuplicate={() => duplicateRule(rule)}
                  onDelete={() => deleteRule(rule)}
                />
              ))}
          </section>

          {error ? (
            <div className={automationClass('home-empty')}>
              <XCircle size={22} />
              <strong>自动化加载失败</strong>
              <span>{error}</span>
              {onReload ? <button onClick={() => void onReload()}>重新加载</button> : null}
            </div>
          ) : null}

          {!loading && !error && !visibleRules.length ? (
            <div className={automationClass('home-empty')}>
              <Search size={22} />
              <strong>没有匹配的自动化</strong>
              <span>换个搜索词或筛选条件。</span>
            </div>
          ) : null}
        </section>
      ) : (
        <section className={automationClass('project-runs-section')}>
          <button
            className={automationClass('back-to-automation')}
            onClick={() => setHomeTab('rules')}
          >
            <ArrowLeft size={14} />
            返回自动化规则
          </button>
          <RunsHome runs={runs} rules={rules} loading={runsLoading} onOpenRule={openRule} />
        </section>
      )}
    </main>
  )

  return (
    <div className={automationClass('automation-root')} data-testid="project-automation-view">
      {content}
      {toast ? (
        <div className={automationClass('toast')}>
          <CheckCircle2 size={16} />
          {toast}
        </div>
      ) : null}

      {templateStoreOpen ? (
        <TemplateStore
          templates={automationTemplates}
          onClose={() => setTemplateStoreOpen(false)}
          onApply={applyTemplate}
        />
      ) : null}
    </div>
  )
}
