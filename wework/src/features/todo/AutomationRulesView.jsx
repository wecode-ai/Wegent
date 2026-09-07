import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  ArrowLeft,
  Bot,
  Box,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock3,
  Cloud,
  Code2,
  Copy,
  FolderKanban,
  GitBranch,
  History,
  Laptop,
  LayoutGrid,
  MoreHorizontal,
  Plus,
  Puzzle,
  Search,
  Sparkles,
  Tag,
  Trash2,
  UserRound,
  Webhook,
  X,
  XCircle,
  Zap,
} from 'lucide-react'
import { PopupMenu } from '@/components/common/MenuSelect'
import { AutomationWorkflowCanvas } from './AutomationWorkflowCanvas.jsx'
import { automationClass } from './automationStyles'

const ACTIVE_RUN_STATUSES = new Set([
  'pending',
  'queued',
  'waiting_runtime',
  'waiting_device',
  'running',
])
const EMPTY_EXECUTION_CATALOG = { environments: [], models: [], plugins: [] }
const DELIVERABLE_TYPE_OPTIONS = [
  { value: 'text', label: '文本' },
  { value: 'file', label: '文件' },
  { value: 'code_snapshot', label: '代码快照' },
  { value: 'git_branch', label: 'Git 分支' },
  { value: 'pull_request', label: 'PR/MR' },
  { value: 'url', label: '链接' },
]

function runMatchesFilter(status, filter) {
  if (filter === 'all') return true
  if (filter === 'active') return ACTIVE_RUN_STATUSES.has(status)
  if (filter === 'success') return status === 'succeeded'
  if (filter === 'failed') return status === 'failed' || status === 'cancelled'
  return false
}

function runStatusPresentation(status) {
  const presentations = {
    pending: { label: '准备中', tone: 'queued', icon: Clock3 },
    queued: { label: '排队中', tone: 'queued', icon: Clock3 },
    waiting_runtime: { label: '待配置', tone: 'waiting', icon: Clock3 },
    waiting_device: { label: '等待设备', tone: 'waiting', icon: Clock3 },
    running: { label: '执行中', tone: 'running', icon: Activity },
    succeeded: { label: '成功', tone: 'success', icon: CheckCircle2 },
    failed: { label: '失败', tone: 'failed', icon: XCircle },
    skipped: { label: '已跳过', tone: 'neutral', icon: Circle },
    cancelled: { label: '已取消', tone: 'failed', icon: XCircle },
  }
  return presentations[status] ?? presentations.pending
}

function createExecutionNode({
  id,
  name,
  prompt,
  kind = 'task',
  dependencies = [],
  dependencyContext = {},
  x = 0,
  y = 0,
  deliverables = [],
  executionMode = 'automatic',
  environment = '',
  executionEnvironment = 'local',
  executionDeviceId = null,
  runtimeProfileId = null,
  model = '',
  modelType = null,
  modelOptions = {},
  plugins = [],
  projectPlugins = [],
  workspacePolicy = executionMode === 'automatic' ? 'none' : 'composer',
  required = true,
  automationRuleId = null,
  executionConfig = null,
  executionConfigOverride = false,
  approvalPolicy = undefined,
  subgraph = null,
}) {
  return {
    id,
    name,
    prompt,
    kind,
    dependencies,
    dependencyContext,
    x,
    y,
    deliverables,
    executionMode,
    environment,
    executionEnvironment,
    executionDeviceId,
    runtimeProfileId,
    model,
    modelType,
    modelOptions,
    plugins,
    projectPlugins,
    workspacePolicy,
    required,
    automationRuleId,
    executionConfig,
    executionConfigOverride,
    approvalPolicy,
    subgraph,
  }
}

function defaultExecutionConfiguration(executionCatalog) {
  const environment = executionCatalog.environments[0]
  const model = executionCatalog.models[0]
  return {
    environment: environment?.label ?? '',
    executionEnvironment: environment?.executionEnvironment ?? 'local',
    executionDeviceId: environment?.deviceId ?? null,
    model: model?.name ?? '',
    modelType: model?.type ?? null,
    modelOptions: model?.options ?? {},
  }
}

function environmentDisplayLabel(option) {
  if (!option) return ''
  if (option.executionEnvironment === 'local') return '本机'
  return option.label.replace(/\s*·\s*(在线|忙碌)$/, '') || option.deviceId
}

function clearExecutionEnvironment(onChange) {
  onChange('executionDeviceId', null)
  onChange('executionEnvironment', 'local')
  onChange('environment', '')
  onChange('runtimeProfileId', null)
}

function clearExecutionModel(onChange) {
  onChange('model', '')
  onChange('modelType', null)
  onChange('modelOptions', {})
  onChange('runtimeProfileId', null)
}

function ExecutionEnvironmentSelect({ testId, value, options, onChange }) {
  const selected = options.find(option => option.deviceId === value)
  const selectedLabel = environmentDisplayLabel(selected)
  const SelectedIcon = selected?.executionEnvironment === 'cloud' ? Cloud : Laptop

  return (
    <PopupMenu
      testId={testId}
      fullWidth
      trigger={
        <span
          data-value={value ?? ''}
          className="flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-transparent bg-muted/60 px-3 text-sm text-text-primary transition-colors hover:bg-muted"
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected ? (
              <SelectedIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
            ) : null}
            <span className={selected ? 'truncate' : 'truncate text-text-muted'}>
              {selectedLabel || '选择执行环境'}
            </span>
          </span>
          <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
        </span>
      }
    >
      {close => (
        <>
          <button
            type="button"
            data-testid={`${testId}-option-none`}
            onClick={() => {
              onChange(null)
              close()
            }}
            className="flex h-10 w-full items-center gap-2 rounded-xl px-3 text-left text-sm font-medium text-text-primary hover:bg-surface"
          >
            <X aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
            <span className="min-w-0 flex-1 truncate">不指定执行环境</span>
            {!value ? <Check className="h-4 w-4 shrink-0" /> : null}
          </button>
          {options.map(option => {
            const label = environmentDisplayLabel(option)
            const OptionIcon = option.executionEnvironment === 'cloud' ? Cloud : Laptop
            return (
              <button
                key={option.deviceId}
                type="button"
                data-testid={`${testId}-option-${option.deviceId}`}
                aria-label={option.executionEnvironment === 'cloud' ? `云设备 ${label}` : '本机'}
                onClick={() => {
                  onChange(option.deviceId)
                  close()
                }}
                className="flex h-10 w-full items-center gap-2 rounded-xl px-3 text-left text-sm font-medium text-text-primary hover:bg-surface"
              >
                <OptionIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {option.deviceId === value ? <Check className="h-4 w-4 shrink-0" /> : null}
              </button>
            )
          })}
        </>
      )}
    </PopupMenu>
  )
}

function createDynamicAllocationNode(executionCatalog, id = `step-${Date.now()}`) {
  return createExecutionNode({
    ...defaultExecutionConfiguration(executionCatalog),
    id,
    kind: 'dynamic',
    name: 'AI 动态分配',
    prompt:
      '阅读 Issue 的目标、上下文和验收标准，拆解需要完成的具体任务，选择合适的执行方式，并根据依赖关系决定执行顺序。',
    approvalPolicy: 'required',
    subgraph: {
      nodes: [],
    },
  })
}

function createStageConstraint(overrides) {
  return createExecutionNode({
    id: overrides.id,
    name: overrides.name,
    prompt: overrides.prompt,
    dependencies: overrides.dependencies ?? [],
    dependencyContext: overrides.dependencyContext ?? {},
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    deliverables: overrides.deliverables ?? [],
    executionMode: overrides.executionMode ?? 'automatic',
    workspacePolicy: 'none',
    required: overrides.required ?? true,
    automationRuleId: overrides.automationRuleId ?? null,
  })
}

const automationTemplates = [
  {
    id: 'issue-development',
    category: 'issue',
    featured: true,
    name: 'Issue 自动开发',
    description: '创建 Issue 后自动分析需求、实现代码并回写结果',
    tags: ['Issue', '研发'],
    icon: 'development',
    trigger: {
      type: 'event',
      source: 'issue',
      startMode: 'immediate',
      event: 'created',
      tags: ['自动开发'],
      schedule: {
        frequency: 'daily',
        weekday: 'monday',
        time: '03:00',
        timezone: 'Asia/Shanghai',
      },
    },
    steps: [
      {
        name: '分析需求',
        prompt: '阅读 Issue 的标题、描述和附件，理解目标、范围和验收标准。',
        deliverables: [
          {
            name: '需求分析',
            description: '目标、范围、约束与验收标准',
            valueType: 'text',
          },
        ],
        plugins: ['Wework 项目空间'],
      },
      {
        name: '实现与验证',
        prompt: '根据需求分析修改代码并运行相关测试，保留可验证的执行证据。',
        deliverables: [
          {
            name: '实现结果',
            description: '代码改动与测试结果',
            valueType: 'text',
          },
        ],
        plugins: ['GitHub', 'Wework 项目空间'],
        workspacePolicy: 'inherit',
      },
      {
        name: '回写 Issue',
        prompt: '将实现结果、验证证据和后续建议回写当前 Issue。',
        deliverables: [
          {
            name: 'Issue 更新',
            description: '结果、证据和后续建议',
            valueType: 'text',
          },
        ],
        plugins: ['Wework 项目空间'],
        workspacePolicy: 'inherit',
      },
    ],
  },
  {
    id: 'issue-testing',
    category: 'issue',
    featured: true,
    name: 'Issue 自动测试',
    description: '创建测试任务后自动确定范围、运行测试并更新验收结果',
    tags: ['Issue', '测试'],
    icon: 'testing',
    trigger: {
      type: 'event',
      source: 'issue',
      startMode: 'immediate',
      event: 'created',
      tags: ['自动测试'],
      schedule: {
        frequency: 'daily',
        weekday: 'monday',
        time: '03:00',
        timezone: 'Asia/Shanghai',
      },
    },
    steps: [
      {
        name: '确定测试范围',
        prompt: '根据 Issue 描述和代码变更识别需要执行的测试集合。',
        plugins: ['GitHub', 'Wework 项目空间'],
      },
      {
        name: '运行测试',
        prompt: '运行相关自动化测试，定位失败原因并收集可复现日志。',
        plugins: ['GitHub'],
        workspacePolicy: 'inherit',
      },
      {
        name: '更新验收结果',
        prompt: '将测试结论、失败日志和验收建议回写 Issue。',
        plugins: ['Wework 项目空间'],
        workspacePolicy: 'inherit',
      },
    ],
  },
  {
    id: 'daily-inspection',
    category: 'schedule',
    featured: true,
    name: '每日 Issue 巡检',
    description: '每天检查待处理和长期未更新的 Issue，生成行动建议',
    tags: ['定时', '巡检'],
    icon: 'schedule',
    trigger: {
      type: 'schedule',
      source: 'issue',
      startMode: 'immediate',
      event: 'created',
      tags: [],
      schedule: {
        frequency: 'daily',
        weekday: 'monday',
        time: '09:30',
        timezone: 'Asia/Shanghai',
      },
    },
    steps: [
      {
        name: '检查看板',
        prompt: '检查项目看板中的待处理和长时间未更新事项，识别优先级、依赖和风险。',
      },
      {
        name: '生成巡检报告',
        prompt: '汇总需要关注的 Issue，并为每项给出明确的下一步行动建议。',
        workspacePolicy: 'inherit',
      },
    ],
  },
  {
    id: 'issue-defect-triage',
    category: 'issue',
    featured: false,
    name: '缺陷自动分析',
    description: '新缺陷创建后自动复现、定位原因并给出修复建议',
    tags: ['Issue', '缺陷'],
    icon: 'defect',
    trigger: {
      type: 'event',
      source: 'issue',
      startMode: 'status',
      event: 'created',
      tags: ['缺陷'],
      schedule: {
        frequency: 'daily',
        weekday: 'monday',
        time: '03:00',
        timezone: 'Asia/Shanghai',
      },
    },
    steps: [
      {
        name: '复现缺陷',
        prompt: '阅读缺陷描述和附件，按照复现步骤验证问题并补充必要信息。',
        plugins: ['GitHub', 'Wework 项目空间'],
      },
      {
        name: '定位原因',
        prompt: '分析相关代码和日志，定位最可能的根因及影响范围。',
        plugins: ['GitHub'],
        workspacePolicy: 'inherit',
      },
      {
        name: '给出修复建议',
        prompt: '整理根因、修复方案、验证方式和风险，并回写当前 Issue。',
        plugins: ['Wework 项目空间'],
        workspacePolicy: 'inherit',
      },
    ],
  },
]

const frequencyLabels = {
  daily: '每天',
  weekdays: '工作日',
  weekly: '每周',
}

const weekdayLabels = {
  monday: '周一',
  tuesday: '周二',
  wednesday: '周三',
  thursday: '周四',
  friday: '周五',
  saturday: '周六',
  sunday: '周日',
}

function triggerPresentation(trigger) {
  if (trigger.type === 'schedule') {
    const schedule = trigger.schedule
    const frequency =
      schedule.frequency === 'weekly'
        ? `每周${weekdayLabels[schedule.weekday]}`
        : frequencyLabels[schedule.frequency]
    return {
      label: `${frequency} ${schedule.time}`,
      detail: `按计划执行 · ${schedule.timezone}`,
    }
  }

  if (trigger.startMode === 'status') {
    return {
      label: 'Issue 开始处理时',
      detail: 'Issue 从未开始区域进入处理阶段或其后任意状态时启动',
    }
  }

  const tagSuffix = trigger.tags.length
    ? `，且包含标签「${trigger.tags.join('、')}」中的任意一个`
    : ''
  return {
    label: 'Issue 创建后自动启动',
    detail: `创建新的 Issue 后立即运行${tagSuffix}`,
  }
}

function cloneRule(rule) {
  const cloneNode = step => ({
    ...step,
    dependencies: [...(step.dependencies ?? [])],
    dependencyContext: Object.fromEntries(
      Object.entries(step.dependencyContext ?? {}).map(([dependencyId, sources]) => [
        dependencyId,
        [...sources],
      ])
    ),
    deliverables: step.deliverables.map(deliverable => ({ ...deliverable })),
    plugins: [...step.plugins],
    projectPlugins: [...(step.projectPlugins ?? [])],
    modelOptions: { ...(step.modelOptions ?? {}) },
    executionConfig: step.executionConfig
      ? {
          ...step.executionConfig,
          model_options: { ...(step.executionConfig.model_options ?? {}) },
          project_plugins: [...(step.executionConfig.project_plugins ?? [])],
        }
      : null,
    subgraph: step.subgraph
      ? {
          nodes: step.subgraph.nodes.map(cloneNode),
        }
      : null,
  })
  return {
    ...rule,
    trigger: {
      ...rule.trigger,
      tags: [...rule.trigger.tags],
      schedule: { ...rule.trigger.schedule },
    },
    steps: rule.steps.map(cloneNode),
  }
}

function makeRule() {
  return {
    id: `draft-${crypto.randomUUID()}`,
    persisted: false,
    origin: 'automation',
    version: 1,
    name: '未命名自动化',
    description: '',
    enabled: true,
    updatedAt: '尚未保存',
    trigger: {
      type: 'event',
      source: 'issue',
      startMode: 'immediate',
      event: 'created',
      tags: [],
      schedule: {
        frequency: 'daily',
        weekday: 'monday',
        time: '03:00',
        timezone: 'Asia/Shanghai',
      },
    },
    steps: [],
    legacyDefinition: null,
  }
}

function makeRuleFromTemplate(template, executionCatalog) {
  const createdAt = Date.now()
  const rule = makeRule()
  const executionDefaults = defaultExecutionConfiguration(executionCatalog)
  return {
    ...rule,
    name: template.name,
    description: template.description,
    trigger: {
      ...template.trigger,
      tags: [...template.trigger.tags],
      schedule: { ...template.trigger.schedule },
    },
    steps: template.steps.map((step, stepIndex) =>
      createExecutionNode({
        ...executionDefaults,
        ...step,
        id: `step-${createdAt}-${stepIndex + 1}`,
        dependencies: stepIndex ? [`step-${createdAt}-${stepIndex}`] : [],
        x: 440 + stepIndex * 420,
        y: 226,
        deliverables: (step.deliverables ?? []).map((deliverable, deliverableIndex) => ({
          ...deliverable,
          id: `deliverable-${createdAt}-${stepIndex + 1}-${deliverableIndex + 1}`,
        })),
        plugins: [...(step.plugins ?? [])],
      })
    ),
  }
}

export function AutomationRulesView({
  rules: backendRules,
  runs: backendRuns,
  loading = false,
  error = '',
  canManage = true,
  projectTags = [],
  executionCatalog: initialExecutionCatalog = EMPTY_EXECUTION_CATALOG,
  onReload,
  onLoadExecutionCatalog,
  onLoadExecutionPlugins,
  onLoadRuns,
  onSaveRule,
  onToggleRule,
  onDuplicateRule,
  onDeleteRule,
}) {
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
  const [saving, setSaving] = useState(false)
  const [runsLoading, setRunsLoading] = useState(false)
  const executionCatalogRequestRef = useRef(null)
  const executionPluginRequestRef = useRef(null)
  const runsRequestRef = useRef(null)
  const toastTimerRef = useRef(null)

  const dirty = JSON.stringify(draft) !== savedSnapshot

  useEffect(() => {
    setRules(backendRules)
  }, [backendRules])

  useEffect(() => {
    if (!draft.persisted || JSON.stringify(draft) !== savedSnapshot) return
    const refreshed = backendRules.find(rule => rule.id === draft.id)
    if (!refreshed) return
    const refreshedSnapshot = JSON.stringify(refreshed)
    if (refreshedSnapshot === savedSnapshot) return
    setDraft(cloneRule(refreshed))
    setSavedSnapshot(refreshedSnapshot)
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
    },
    []
  )

  const visibleRules = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return rules.filter(rule => {
      const matchesStatus =
        filter === 'all' || (filter === 'enabled' ? rule.enabled : !rule.enabled)
      const trigger = triggerPresentation(rule.trigger)
      const matchesQuery =
        !normalized ||
        `${rule.name} ${rule.description} ${trigger.label}`.toLowerCase().includes(normalized)
      return matchesStatus && matchesQuery
    })
  }, [filter, query, rules])

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
    setDraft(cloneRule(rule))
    setSavedSnapshot(JSON.stringify(rule))
    setEditorSection('workflow')
    setSelectedNode({ type: 'trigger' })
    setPanelTab('settings')
    setView('editor')
    refreshExecutionCatalog()
  }

  const createRule = () => {
    const rule = makeRule()
    setDraft(rule)
    setSavedSnapshot('')
    setEditorSection('workflow')
    setSelectedNode({ type: 'trigger' })
    setPanelTab('settings')
    setView('editor')
    refreshExecutionCatalog()
  }

  const applyTemplate = template => {
    const rule = makeRuleFromTemplate(template, executionCatalog)
    setTemplateStoreOpen(false)
    setDraft(rule)
    setSavedSnapshot('')
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
    setDraft(current => (typeof updater === 'function' ? updater(current) : updater))
  }

  const saveRule = async () => {
    if (!draft.name.trim()) {
      notify('请填写自动化名称')
      return null
    }
    const hasUnnamedNode = nodes =>
      nodes.some(
        node =>
          !node.name.trim() ||
          (node.kind === 'dynamic' && hasUnnamedNode(node.subgraph?.nodes ?? []))
      )
    if (hasUnnamedNode(draft.steps)) {
      notify('请填写所有执行节点名称')
      return null
    }
    setSaving(true)
    try {
      const candidate = cloneRule(draft)
      const saved = onSaveRule ? await onSaveRule(candidate) : candidate
      setDraft(cloneRule(saved))
      setRules(current => {
        const withoutDraft = current.filter(rule => rule.id !== draft.id)
        const exists = withoutDraft.some(rule => rule.id === saved.id)
        return exists
          ? withoutDraft.map(rule => (rule.id === saved.id ? saved : rule))
          : [saved, ...withoutDraft]
      })
      setSavedSnapshot(JSON.stringify(saved))
      notify('自动化已保存')
      return saved
    } catch (saveError) {
      notify(saveError instanceof Error ? saveError.message : String(saveError))
      return null
    } finally {
      setSaving(false)
    }
  }

  const duplicateRule = async rule => {
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
      kind === 'dynamic'
        ? createDynamicAllocationNode(executionCatalog)
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

      const insertionX = placement === 'before' ? (anchor?.x ?? 440) : anchor ? anchor.x + 420 : 440
      const insertionY = anchor?.y ?? 226
      const shifted = current.steps.map(candidate =>
        candidate.id !== anchor?.id && candidate.x >= insertionX
          ? { ...candidate, x: candidate.x + 420 }
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

  const removeSelectedStep = () => {
    if (selectedNode.type !== 'step') return
    updateDraft(current => {
      const removed = current.steps.find(step => step.id === selectedNode.id)
      if (!removed) return current
      return {
        ...current,
        steps: current.steps
          .filter(step => step.id !== selectedNode.id)
          .map(step => {
            if (!step.dependencies.includes(selectedNode.id)) return step
            const dependencies = Array.from(
              new Set([
                ...step.dependencies.filter(dependencyId => dependencyId !== selectedNode.id),
                ...removed.dependencies,
              ])
            )
            return {
              ...step,
              dependencies,
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
          editorSection={editorSection}
          selectedNode={selectedNode}
          panelTab={panelTab}
          saving={saving}
          projectTags={projectTags}
          executionCatalog={executionCatalog}
          onBack={() => setView('home')}
          onEditorSectionChange={changeEditorSection}
          onSelectNode={setSelectedNode}
          onPanelTabChange={changePanelTab}
          onDraftChange={updateDraft}
          onSave={saveRule}
          onAddStep={addStep}
          onRemoveStep={removeSelectedStep}
          onOpenPluginMenu={preparePluginMenu}
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
              <button data-testid="automation-create-blank" onClick={() => createRule()}>
                <Plus size={18} />
                <span>
                  <strong>创建空白自动化</strong>
                  <small>从触发规则开始配置</small>
                </span>
              </button>
              <button data-testid="open-template-store" onClick={() => setTemplateStoreOpen(true)}>
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

function TemplateStore({ templates, onClose, onApply }) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [selectedId, setSelectedId] = useState(templates[0]?.id)
  const normalizedQuery = query.trim().toLowerCase()

  const visibleTemplates = useMemo(
    () =>
      templates.filter(template => {
        const matchesCategory =
          category === 'all' ||
          (category === 'featured' ? template.featured : template.category === category)
        const matchesQuery =
          !normalizedQuery ||
          `${template.name} ${template.description} ${template.tags.join(' ')}`
            .toLowerCase()
            .includes(normalizedQuery)
        return matchesCategory && matchesQuery
      }),
    [category, normalizedQuery, templates]
  )

  const selectedTemplate =
    visibleTemplates.find(template => template.id === selectedId) ?? visibleTemplates[0] ?? null

  useEffect(() => {
    const handleKeyDown = event => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      className={automationClass('template-store-overlay')}
      data-testid="template-store"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section className={automationClass('template-store-dialog')} role="dialog" aria-modal="true">
        <header className={automationClass('template-store-header')}>
          <div>
            <span className={automationClass('template-store-mark')}>
              <Sparkles size={18} />
            </span>
            <div>
              <h2>自动化模板</h2>
              <p>选择模板后会生成一份独立配置，可继续修改</p>
            </div>
          </div>
          <label className={automationClass('template-search')}>
            <Search size={15} />
            <input
              data-testid="template-search-input"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="搜索模板"
              autoFocus
            />
            {query ? (
              <button
                type="button"
                data-testid="clear-template-search"
                onClick={() => setQuery('')}
                aria-label="清除模板搜索"
              >
                <X size={13} />
              </button>
            ) : null}
          </label>
          <button
            className={automationClass('template-store-close')}
            type="button"
            data-testid="close-template-store"
            onClick={onClose}
            aria-label="关闭模板商店"
          >
            <X size={17} />
          </button>
        </header>

        <div className={automationClass('template-store-body')}>
          <nav className={automationClass('template-categories')} aria-label="模板分类">
            {[
              ['all', '全部模板', LayoutGrid],
              ['featured', '推荐', Sparkles],
              ['issue', 'Issue 触发', Webhook],
              ['schedule', '定时任务', Clock3],
            ].map(([value, label, Icon]) => (
              <button
                key={value}
                className={category === value ? 'active' : ''}
                type="button"
                data-testid={`template-category-${value}`}
                onClick={() => setCategory(value)}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </nav>

          <main className={automationClass('template-library')}>
            <div className={automationClass('template-library-title')}>
              <div>
                <h3>
                  {category === 'all'
                    ? '全部模板'
                    : category === 'featured'
                      ? '推荐模板'
                      : category === 'issue'
                        ? 'Issue 触发'
                        : '定时任务'}
                </h3>
                <span>{visibleTemplates.length} 个模板</span>
              </div>
              <small>内置模板</small>
            </div>

            {visibleTemplates.length ? (
              <div className={automationClass('template-grid')}>
                {visibleTemplates.map(template => (
                  <TemplateCard
                    key={template.id}
                    template={template}
                    selected={selectedTemplate?.id === template.id}
                    onSelect={() => setSelectedId(template.id)}
                    onApply={() => onApply(template)}
                  />
                ))}
              </div>
            ) : (
              <div className={automationClass('template-empty')}>
                <Search size={22} />
                <strong>没有找到相关模板</strong>
                <span>换个关键词或分类试试。</span>
              </div>
            )}
          </main>

          <aside className={automationClass('template-preview')}>
            {selectedTemplate ? (
              <>
                <div className={automationClass('template-preview-head')}>
                  <TemplateIcon type={selectedTemplate.icon} />
                  <div>
                    <small>模板预览</small>
                    <h3>{selectedTemplate.name}</h3>
                  </div>
                </div>
                <p>{selectedTemplate.description}</p>
                <div className={automationClass('template-preview-trigger')}>
                  <span>
                    {selectedTemplate.trigger.type === 'schedule' ? (
                      <Clock3 size={15} />
                    ) : (
                      <Webhook size={15} />
                    )}
                  </span>
                  <div>
                    <small>触发规则</small>
                    <strong>{triggerPresentation(selectedTemplate.trigger).label}</strong>
                  </div>
                </div>
                <div className={automationClass('template-preview-steps')}>
                  <small>执行流程 · {selectedTemplate.steps.length} 个节点</small>
                  {selectedTemplate.steps.map((step, index) => (
                    <div key={`${selectedTemplate.id}-${step.name}`}>
                      <span>{index + 1}</span>
                      <strong>{step.name}</strong>
                    </div>
                  ))}
                </div>
                <div className={automationClass('template-preview-footer')}>
                  <p>应用后生成独立自动化，不会与模板保持引用关系。</p>
                  <button
                    type="button"
                    data-testid="apply-selected-template"
                    onClick={() => onApply(selectedTemplate)}
                  >
                    使用此模板
                  </button>
                </div>
              </>
            ) : (
              <div className={automationClass('template-preview-empty')}>选择一个模板查看配置</div>
            )}
          </aside>
        </div>
      </section>
    </div>
  )
}

function TemplateCard({ template, selected, onSelect, onApply }) {
  const trigger = triggerPresentation(template.trigger)
  return (
    <article className={automationClass(`template-card ${selected ? 'selected' : ''}`)}>
      <button
        className={automationClass('template-card-main')}
        type="button"
        data-testid={`template-card-${template.id}`}
        onClick={onSelect}
      >
        <TemplateIcon type={template.icon} />
        <span className={automationClass('template-card-copy')}>
          <span>
            <strong>{template.name}</strong>
            {template.featured ? <small>推荐</small> : null}
          </span>
          <p>{template.description}</p>
          <span className={automationClass('template-card-meta')}>
            <span>{trigger.label}</span>
            <span>{template.steps.length} 个节点</span>
          </span>
        </span>
      </button>
      <button
        className={automationClass('template-card-apply')}
        type="button"
        data-testid={`apply-template-${template.id}`}
        onClick={onApply}
      >
        使用
      </button>
    </article>
  )
}

function TemplateIcon({ type }) {
  const Icon =
    type === 'schedule'
      ? Clock3
      : type === 'testing'
        ? CheckCircle2
        : type === 'defect'
          ? GitBranch
          : Code2
  return (
    <span className={automationClass(`template-icon ${type}`)}>
      <Icon size={18} />
    </span>
  )
}

function AutomationCard({ rule, canManage, onOpen, onToggle, onDuplicate, onDelete }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const trigger = triggerPresentation(rule.trigger)
  const TriggerIcon = rule.trigger.type === 'schedule' ? Clock3 : Webhook

  return (
    <article
      className={automationClass('automation-card')}
      data-testid={`automation-card-${rule.id}`}
      onClick={onOpen}
    >
      <div className={automationClass('card-head')}>
        <span className={automationClass('automation-icon')}>
          <Zap size={19} />
        </span>
        <div>
          <h3>{rule.name}</h3>
          <p>{rule.description}</p>
        </div>
        <div className={automationClass('card-menu-anchor')}>
          <button
            className={automationClass('icon-button')}
            onClick={event => {
              event.stopPropagation()
              setMenuOpen(value => !value)
            }}
            aria-label="更多操作"
          >
            <MoreHorizontal size={17} />
          </button>
          {menuOpen ? (
            <div
              className={automationClass('card-menu')}
              onClick={event => event.stopPropagation()}
            >
              <button onClick={onDuplicate}>
                <Copy size={14} />
                创建独立副本
              </button>
              <button className={automationClass('danger')} onClick={onDelete}>
                <Trash2 size={14} />
                删除
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className={automationClass('trigger-summary')}>
        <span>
          <TriggerIcon size={14} />
          触发规则
        </span>
        <strong>{trigger.label}</strong>
        <small>{trigger.detail}</small>
      </div>

      <div className={automationClass('card-footer')}>
        <span>{rule.updatedAt}</span>
        <button
          role="switch"
          aria-checked={rule.enabled}
          disabled={!canManage}
          className={automationClass(`switch ${rule.enabled ? 'on' : ''}`)}
          onClick={event => {
            event.stopPropagation()
            onToggle()
          }}
        >
          <i />
        </button>
      </div>
    </article>
  )
}

function WorkflowEditor({
  draft,
  runs,
  runsLoading,
  dirty,
  editorSection,
  selectedNode,
  panelTab,
  saving,
  projectTags,
  executionCatalog,
  onBack,
  onSelectNode,
  onPanelTabChange,
  onDraftChange,
  onSave,
  onAddStep,
  onRemoveStep,
  onOpenPluginMenu,
  onEditorSectionChange,
}) {
  const [runStatus, setRunStatus] = useState('all')
  const [selectedRunId, setSelectedRunId] = useState(runs[0]?.id ?? null)
  const needsSave = dirty || !draft.persisted
  const trigger = triggerPresentation(draft.trigger)
  const TriggerIcon = draft.trigger.type === 'schedule' ? Clock3 : Webhook
  const visibleRuns = runs.filter(run => runMatchesFilter(run.status, runStatus))
  const selectedRun = visibleRuns.find(run => run.id === selectedRunId) ?? visibleRuns[0] ?? null
  const latestRun = runs[0] ?? null
  const selectedStep =
    selectedNode.type === 'step'
      ? (draft.steps.find(step => step.id === selectedNode.id) ?? null)
      : null
  const selectedDagParent =
    selectedNode.type === 'dagStage'
      ? (draft.steps.find(step => step.id === selectedNode.stepId) ?? null)
      : null
  const selectedDagStage =
    selectedDagParent?.subgraph?.nodes.find(stage => stage.id === selectedNode.stageId) ?? null
  const hasSelectedNode = selectedNode.type !== 'none'
  const showRightPanel = editorSection === 'runs' || hasSelectedNode

  const updateTrigger = (key, value) => {
    onDraftChange(current => ({
      ...current,
      trigger: { ...current.trigger, [key]: value },
    }))
  }

  const updateRule = (key, value) => {
    onDraftChange(current => ({ ...current, [key]: value }))
  }

  const updateStep = (key, value) => {
    if (!selectedStep) return
    onDraftChange(current => ({
      ...current,
      steps: current.steps.map(step =>
        step.id === selectedStep.id ? { ...step, [key]: value } : step
      ),
    }))
  }

  const updateDagStage = (key, value) => {
    if (!selectedDagParent || !selectedDagStage) return
    onDraftChange(current => ({
      ...current,
      steps: current.steps.map(step =>
        step.id === selectedDagParent.id
          ? {
              ...step,
              subgraph: {
                nodes: step.subgraph.nodes.map(stage =>
                  stage.id === selectedDagStage.id ? { ...stage, [key]: value } : stage
                ),
              },
            }
          : step
      ),
    }))
  }

  const addDagStage = (stepId, anchorStageId = null, placement = 'after') => {
    const id = `dag-stage-${Date.now()}`
    onDraftChange(current => ({
      ...current,
      steps: current.steps.map(step => {
        if (step.id !== stepId) return step
        if (step.subgraph.nodes.length === 0) {
          return {
            ...step,
            subgraph: {
              nodes: [
                createStageConstraint({
                  id,
                  name: '新阶段',
                  prompt: '说明这个阶段的目标、边界和验收要求。',
                  dependencies: [],
                  dependencyContext: {},
                  x: 24,
                  y: 105,
                }),
              ],
            },
          }
        }
        const anchorIndex = step.subgraph.nodes.findIndex(stage => stage.id === anchorStageId)
        const anchor = step.subgraph.nodes[anchorIndex]
        if (!anchor) return step
        const insertionX = placement === 'before' ? anchor.x : anchor.x + 200
        const shifted = step.subgraph.nodes.map(stage =>
          stage.id !== anchor.id && stage.x >= insertionX ? { ...stage, x: stage.x + 200 } : stage
        )
        const dependencies = placement === 'before' ? [...anchor.dependencies] : [anchorStageId]
        const stage = createStageConstraint({
          id,
          name: '新阶段',
          prompt: '说明这个阶段的目标、边界和验收要求。',
          dependencies,
          dependencyContext:
            placement === 'before'
              ? { ...(anchor.dependencyContext ?? {}) }
              : {
                  [anchorStageId]: ['final_result', 'deliveries'],
                },
          x: insertionX,
          y: anchor.y,
        })
        const rewired = shifted.map(candidate => {
          if (placement === 'before' && candidate.id === anchor.id) {
            return {
              ...candidate,
              x: candidate.x + 200,
              dependencies: [stage.id],
              dependencyContext: {
                [stage.id]: ['final_result', 'deliveries'],
              },
            }
          }
          if (placement !== 'after' || !candidate.dependencies.includes(anchor.id)) {
            return candidate
          }
          return {
            ...candidate,
            dependencies: candidate.dependencies.map(dependencyId =>
              dependencyId === anchor.id ? stage.id : dependencyId
            ),
            dependencyContext: {
              ...Object.fromEntries(
                Object.entries(candidate.dependencyContext ?? {}).filter(
                  ([dependencyId]) => dependencyId !== anchor.id
                )
              ),
              [stage.id]: candidate.dependencyContext?.[anchor.id] ?? [
                'final_result',
                'deliveries',
              ],
            },
          }
        })
        const nodes = [...rewired]
        nodes.splice(placement === 'before' ? anchorIndex : anchorIndex + 1, 0, stage)
        return {
          ...step,
          subgraph: {
            nodes,
          },
        }
      }),
    }))
    onSelectNode({ type: 'dagStage', stepId, stageId: id })
  }

  const removeDagStage = () => {
    if (!selectedDagParent || !selectedDagStage) return
    onDraftChange(current => ({
      ...current,
      steps: current.steps.map(step =>
        step.id === selectedDagParent.id
          ? {
              ...step,
              subgraph: {
                nodes: step.subgraph.nodes
                  .filter(stage => stage.id !== selectedDagStage.id)
                  .map(stage => ({
                    ...stage,
                    dependencies: stage.dependencies.filter(id => id !== selectedDagStage.id),
                    dependencyContext: Object.fromEntries(
                      Object.entries(stage.dependencyContext).filter(
                        ([dependencyId]) => dependencyId !== selectedDagStage.id
                      )
                    ),
                  })),
              },
            }
          : step
      ),
    }))
    onSelectNode({ type: 'step', id: selectedDagParent.id })
  }

  const toggleDagDependency = (stepId, stageId, dependencyId) => {
    onDraftChange(current => ({
      ...current,
      steps: current.steps.map(step =>
        step.id === stepId
          ? {
              ...step,
              subgraph: {
                nodes: step.subgraph.nodes.map(stage =>
                  stage.id === stageId
                    ? {
                        ...stage,
                        dependencies: stage.dependencies.includes(dependencyId)
                          ? stage.dependencies.filter(id => id !== dependencyId)
                          : [...stage.dependencies, dependencyId],
                        dependencyContext: stage.dependencies.includes(dependencyId)
                          ? Object.fromEntries(
                              Object.entries(stage.dependencyContext).filter(
                                ([id]) => id !== dependencyId
                              )
                            )
                          : {
                              ...stage.dependencyContext,
                              [dependencyId]: ['final_result', 'deliveries'],
                            },
                      }
                    : stage
                ),
              },
            }
          : step
      ),
    }))
  }

  const moveDagStage = (stepId, stageId, x, y) => {
    onDraftChange(current => ({
      ...current,
      steps: current.steps.map(step =>
        step.id === stepId
          ? {
              ...step,
              subgraph: {
                nodes: step.subgraph.nodes.map(stage =>
                  stage.id === stageId ? { ...stage, x, y } : stage
                ),
              },
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

  const workspaceActions = (
    <div
      className={automationClass('editor-global-actions')}
      data-testid="automation-editor-global-actions"
    >
      <span
        className={automationClass(
          `editor-save-state ${saving ? 'saving' : needsSave ? 'dirty' : 'saved'}`
        )}
      >
        <i />
        {saving ? '保存中' : dirty ? '有未保存更改' : !draft.persisted ? '待保存' : '已保存'}
      </span>
      {needsSave ? (
        <button
          className={automationClass('dark-secondary')}
          data-testid="automation-save"
          onClick={onSave}
          disabled={saving}
        >
          <Check size={15} />
          保存
        </button>
      ) : null}
    </div>
  )

  return (
    <div
      className={automationClass('editor-shell')}
      data-testid="automation-rule-editor"
      style={{
        '--automation-panel-gap': '12px',
        '--automation-right-panel-width': showRightPanel ? '400px' : '0px',
        '--automation-right-panel-top': '64px',
      }}
    >
      <div className={automationClass('editor-body')}>
        <div
          className={automationClass('editor-navigation-actions')}
          data-testid="automation-editor-navigation"
        >
          <button
            className={automationClass('floating-icon-button')}
            data-testid="automation-editor-back"
            onClick={onBack}
            aria-label="返回"
          >
            <ArrowLeft size={17} />
          </button>
          <PopupMenu
            testId="automation-editor-section-menu"
            keepOpen
            menuWidth={220}
            trigger={
              <span className={automationClass('editor-section-trigger')}>
                {editorSection === 'workflow' ? <GitBranch size={16} /> : <History size={16} />}
                <span>{editorSection === 'workflow' ? '编排' : '运行记录'}</span>
                <ChevronDown size={14} />
              </span>
            }
          >
            {close => (
              <div className={automationClass('editor-section-menu')}>
                <label>
                  <span>自动化名称</span>
                  <input
                    value={draft.name}
                    onChange={event =>
                      onDraftChange(current => ({ ...current, name: event.target.value }))
                    }
                    aria-label="自动化名称"
                  />
                </label>
                <div>
                  <button
                    type="button"
                    className={editorSection === 'workflow' ? 'active' : ''}
                    data-testid="editor-nav-workflow"
                    onClick={() => {
                      onEditorSectionChange('workflow')
                      close()
                    }}
                  >
                    <GitBranch size={16} />
                    <span>编排</span>
                    {editorSection === 'workflow' ? <Check size={15} /> : null}
                  </button>
                  <button
                    type="button"
                    className={editorSection === 'runs' ? 'active' : ''}
                    data-testid="open-current-automation-runs"
                    onClick={() => {
                      onEditorSectionChange('runs')
                      close()
                    }}
                  >
                    <History size={16} />
                    <span>运行记录</span>
                    {editorSection === 'runs' ? <Check size={15} /> : null}
                  </button>
                </div>
              </div>
            )}
          </PopupMenu>
        </div>

        {editorSection === 'workflow' ? (
          <main className={automationClass('workflow-canvas')}>
            <AutomationWorkflowCanvas
              draft={draft}
              trigger={trigger}
              selectedNode={selectedNode}
              onSelectNode={onSelectNode}
              onInsertNode={insertNode}
              onAddDagStage={addDagStage}
              onToggleDagDependency={toggleDagDependency}
              onMoveDagStage={moveDagStage}
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

        {workspaceActions}

        {editorSection === 'workflow' ? (
          hasSelectedNode ? (
            <aside
              className={automationClass('editor-rightbar')}
              data-testid="automation-editor-rightbar"
            >
              <div className={automationClass('node-panel')}>
                <div className={automationClass('panel-head')}>
                  <span
                    className={automationClass(
                      `node-icon ${
                        selectedStep?.kind === 'dynamic' ? 'coordinator' : selectedNode.type
                      }`
                    )}
                  >
                    {selectedNode.type === 'trigger' ? (
                      <TriggerIcon size={17} />
                    ) : selectedStep?.kind === 'dynamic' ? (
                      <Sparkles size={17} />
                    ) : (
                      <Box size={17} />
                    )}
                  </span>
                  <div className={automationClass('panel-head-copy')}>
                    <strong>
                      {selectedNode.type === 'trigger'
                        ? '触发规则'
                        : selectedDagStage
                          ? selectedDagStage.name
                          : selectedStep?.kind === 'dynamic'
                            ? 'AI 动态分配'
                            : selectedStep?.name || '未命名执行节点'}
                    </strong>
                    <small>
                      {selectedNode.type === 'trigger'
                        ? '整条自动化的入口'
                        : selectedDagStage
                          ? 'DAG 子图执行节点'
                          : selectedStep?.kind === 'dynamic'
                            ? '运行时拆解并分配具体任务'
                            : '执行节点设置'}
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
                  <div className={automationClass('panel-content')}>
                    {selectedNode.type === 'trigger' ? (
                      <TriggerSettings
                        draft={draft}
                        projectTags={projectTags}
                        onChange={updateTrigger}
                        onRuleChange={updateRule}
                      />
                    ) : selectedDagStage ? (
                      <>
                        <StepSettings
                          step={selectedDagStage}
                          executionCatalog={executionCatalog}
                          onChange={updateDagStage}
                          onDelete={removeDagStage}
                          onOpenPluginMenu={onOpenPluginMenu}
                          constraint
                          supplemental={
                            <SubgraphDependencySummary
                              node={selectedDagStage}
                              parent={selectedDagParent}
                              onChange={updateDagStage}
                            />
                          }
                        />
                      </>
                    ) : selectedStep?.kind === 'dynamic' ? (
                      <CoordinatorSettings
                        coordinator={selectedStep}
                        executionCatalog={executionCatalog}
                        onChange={updateStep}
                        onDelete={onRemoveStep}
                        onOpenPluginMenu={onOpenPluginMenu}
                      />
                    ) : (
                      <StepSettings
                        step={selectedStep}
                        executionCatalog={executionCatalog}
                        onChange={updateStep}
                        onDelete={onRemoveStep}
                        onOpenPluginMenu={onOpenPluginMenu}
                      />
                    )}
                  </div>
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

function RuleRunsPanel({ runs, loading, status, selectedRun, onStatusChange, onSelectRun }) {
  return (
    <main className={automationClass('rule-runs-view')} data-testid="current-automation-runs">
      <div className={automationClass('rule-runs-header')}>
        <div>
          <h2>运行记录</h2>
          <p>这里只展示当前自动化产生的执行记录。</p>
        </div>
        <div className={automationClass('rule-run-filters')}>
          {[
            ['all', '全部'],
            ['active', '未结束'],
            ['success', '成功'],
            ['failed', '失败'],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={status === value ? 'active' : ''}
              data-testid={`current-run-filter-${value}`}
              onClick={() => onStatusChange(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className={automationClass('rule-runs-empty')} data-testid="automation-runs-loading">
          <Activity className={automationClass('spin')} size={22} />
          <strong>正在加载运行记录</strong>
        </div>
      ) : runs.length ? (
        <div className={automationClass('rule-runs-list')}>
          <div className={automationClass('rule-runs-list-head')}>
            <span>Issue / 任务</span>
            <span>状态</span>
            <span>触发时间</span>
            <span>耗时</span>
          </div>
          {runs.map(run => (
            <button
              key={run.id}
              type="button"
              className={automationClass(
                `rule-run-row ${selectedRun?.id === run.id ? 'selected' : ''}`
              )}
              data-testid={`current-run-${run.id}`}
              onClick={() => onSelectRun(run)}
            >
              <span>
                <strong>{run.issue}</strong>
                <small>由当前自动化触发</small>
              </span>
              <RunStatus status={run.status} />
              <span>{run.startedAt}</span>
              <span>{run.duration}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className={automationClass('rule-runs-empty')}>
          <History size={24} />
          <strong>当前自动化暂无运行记录</strong>
          <span>启用并触发自动化后，执行记录会出现在这里。</span>
        </div>
      )}
    </main>
  )
}

function RunDetailPanel({ run, steps }) {
  if (!run) {
    return (
      <aside className={automationClass('run-detail-panel empty')}>
        <History size={24} />
        <strong>暂无执行详情</strong>
        <span>选择一条运行记录后查看节点结果。</span>
      </aside>
    )
  }

  const presentation = runStatusPresentation(run.status)

  return (
    <aside className={automationClass('run-detail-panel')}>
      <div className={automationClass('run-detail-head')}>
        <span className={automationClass(`run-detail-icon ${presentation.tone}`)}>
          <RunStatusIcon status={run.status} size={18} />
        </span>
        <div>
          <strong>执行详情</strong>
          <small>{run.startedAt}</small>
        </div>
      </div>

      <div className={automationClass('run-detail-summary')}>
        <div>
          <span>状态</span>
          <RunStatus status={run.status} />
        </div>
        <div>
          <span>触发对象</span>
          <strong>{run.issue}</strong>
        </div>
        <div>
          <span>总耗时</span>
          <strong>{run.duration}</strong>
        </div>
      </div>

      <div className={automationClass('run-detail-steps')}>
        <span>本次执行流程</span>
        {steps.map((step, index) => (
          <div key={step.id}>
            <span className={automationClass('run-step-state pending')}>{index + 1}</span>
            <div>
              <strong>{step.name || `执行节点 ${index + 1}`}</strong>
              <small>节点级结果等待执行器回传</small>
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}

function RunStatusIcon({ status, size }) {
  const Icon = runStatusPresentation(status).icon
  return <Icon size={size} />
}

function RunStatus({ status }) {
  const presentation = runStatusPresentation(status)
  return (
    <span className={automationClass(`run-status ${presentation.tone}`)}>
      <RunStatusIcon status={status} size={14} />
      {presentation.label}
    </span>
  )
}

function TriggerSettings({ draft, projectTags, onChange, onRuleChange }) {
  const trigger = draft.trigger
  const presentation = triggerPresentation(trigger)
  const TriggerIcon = trigger.type === 'schedule' ? Clock3 : Webhook
  const startMode = trigger.startMode ?? 'immediate'

  const toggleTag = tag => {
    onChange(
      'tags',
      trigger.tags.includes(tag)
        ? trigger.tags.filter(item => item !== tag)
        : [...trigger.tags, tag]
    )
  }

  const updateSchedule = (key, value) => {
    onChange('schedule', { ...trigger.schedule, [key]: value })
  }

  return (
    <div className={automationClass('panel-settings')}>
      <label className={automationClass('panel-field')}>
        <span>自动化说明（可选）</span>
        <textarea
          data-testid="automation-rule-description"
          value={draft.description}
          placeholder="说明这条自动化要完成什么"
          onChange={event => onRuleChange('description', event.target.value)}
        />
      </label>
      <div className={automationClass('prominent-trigger')}>
        <TriggerIcon size={18} />
        <div>
          <strong>什么时候真正开始运行？</strong>
          <span>先选触发来源，再决定 Issue 创建后立即运行，还是开始处理后运行。</span>
        </div>
      </div>
      <label className={automationClass('panel-field')}>
        <span>
          <i className={automationClass('cascade-index')}>1</i>
          触发来源
        </span>
        <select
          data-testid="automation-trigger-type"
          value={trigger.type}
          onChange={event => onChange('type', event.target.value)}
        >
          <option value="schedule">按计划执行</option>
          <option value="event">Issue 触发</option>
        </select>
      </label>
      {trigger.type === 'schedule' ? (
        <section className={automationClass('schedule-settings')}>
          <label className={automationClass('panel-field')}>
            <span>
              <i className={automationClass('cascade-index')}>2</i>
              重复频率
            </span>
            <select
              data-testid="automation-trigger-frequency"
              value={trigger.schedule.frequency}
              onChange={event => updateSchedule('frequency', event.target.value)}
            >
              <option value="daily">每天</option>
              <option value="weekdays">工作日</option>
              <option value="weekly">每周</option>
            </select>
          </label>
          {trigger.schedule.frequency === 'weekly' ? (
            <label className={automationClass('panel-field')}>
              <span>
                <i className={automationClass('cascade-index')}>3</i>
                星期
              </span>
              <select
                data-testid="automation-trigger-weekday"
                value={trigger.schedule.weekday}
                onChange={event => updateSchedule('weekday', event.target.value)}
              >
                {Object.entries(weekdayLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className={automationClass('panel-field')}>
            <span>
              <i className={automationClass('cascade-index')}>
                {trigger.schedule.frequency === 'weekly' ? '4' : '3'}
              </i>
              执行时间
            </span>
            <input
              type="time"
              data-testid="automation-trigger-time"
              value={trigger.schedule.time}
              onChange={event => updateSchedule('time', event.target.value)}
            />
          </label>
          <label className={automationClass('panel-field')}>
            <span>
              <i className={automationClass('cascade-index')}>
                {trigger.schedule.frequency === 'weekly' ? '5' : '4'}
              </i>
              时区
            </span>
            <select
              data-testid="automation-trigger-timezone"
              value={trigger.schedule.timezone}
              onChange={event => updateSchedule('timezone', event.target.value)}
            >
              <option value="Asia/Shanghai">Asia/Shanghai · 上海时间</option>
              <option value="America/Los_Angeles">America/Los_Angeles</option>
              <option value="UTC">UTC</option>
            </select>
          </label>
        </section>
      ) : (
        <>
          <section className={automationClass('start-mode-section')}>
            <div className={automationClass('cascade-heading')}>
              <i className={automationClass('cascade-index')}>2</i>
              <div>
                <strong>启动方式</strong>
                <span>决定 Issue 绑定自动化后，什么时候开始执行</span>
              </div>
            </div>
            <div className={automationClass('start-mode-options')}>
              <button
                type="button"
                data-testid="automation-start-mode-immediate"
                className={startMode === 'immediate' ? 'selected' : ''}
                aria-pressed={startMode === 'immediate'}
                onClick={() => onChange('startMode', 'immediate')}
              >
                <span className={automationClass('start-mode-radio')}>
                  {startMode === 'immediate' ? <Check size={12} /> : null}
                </span>
                <span>
                  <strong>创建后自动启动</strong>
                  <small>Issue 创建成功后立即运行</small>
                </span>
              </button>
              <button
                type="button"
                data-testid="automation-start-mode-status"
                className={startMode === 'status' ? 'selected' : ''}
                aria-pressed={startMode === 'status'}
                onClick={() => onChange('startMode', 'status')}
              >
                <span className={automationClass('start-mode-radio')}>
                  {startMode === 'status' ? <Check size={12} /> : null}
                </span>
                <span>
                  <strong>开始处理时启动</strong>
                  <small>成员推进 Issue 状态后运行</small>
                </span>
              </button>
            </div>
          </section>
          {startMode === 'immediate' ? (
            <section className={automationClass('tag-filter')}>
              <div className={automationClass('tag-filter-heading')}>
                <div>
                  <strong>筛选标签</strong>
                  <span>可选</span>
                </div>
              </div>
              <div className={automationClass('tag-options')}>
                {projectTags.map(tag => {
                  const selected = trigger.tags.includes(tag)
                  return (
                    <button
                      key={tag}
                      type="button"
                      data-testid={`automation-trigger-tag-${tag}`}
                      className={selected ? 'selected' : ''}
                      aria-pressed={selected}
                      onClick={() => toggleTag(tag)}
                    >
                      <span>{selected ? <Check size={12} /> : null}</span>
                      {tag}
                    </button>
                  )
                })}
              </div>
              {!projectTags.length ? <p>当前项目暂无标签，不设置标签筛选。</p> : null}
              <p>不选表示所有新 Issue 都触发；选择多个标签时，包含任意一个即可触发。</p>
            </section>
          ) : (
            <section className={automationClass('execution-status-scope')}>
              <div className={automationClass('cascade-heading')}>
                <i className={automationClass('cascade-index')}>3</i>
                <div>
                  <strong>什么算“开始处理”？</strong>
                  <span>由项目看板的处理起点统一定义</span>
                </div>
              </div>
              <p>Issue 从处理起点之前，进入处理起点或其后任意状态时触发。</p>
            </section>
          )}
        </>
      )}
      <div className={automationClass('trigger-explanation')}>
        <Zap size={15} />
        <div>
          <strong>{presentation.label}</strong>
          <p>{presentation.detail}</p>
        </div>
      </div>
    </div>
  )
}

function PluginSelector({ testId, selectedPlugins, options, onToggle, onOpen }) {
  const optionForLabel = label =>
    options.find(option => option.label === label) ?? {
      id: label,
      label,
      reference: { displayName: label },
    }

  return (
    <div className={automationClass('panel-plugins')}>
      {selectedPlugins.map(plugin => (
        <button key={plugin} type="button" onClick={() => onToggle(optionForLabel(plugin))}>
          {plugin}
          <X size={12} />
        </button>
      ))}
      <PopupMenu
        testId={testId}
        keepOpen
        menuWidth={224}
        triggerClassName="add"
        onOpen={onOpen}
        trigger={
          <span className="inline-flex items-center gap-1">
            <Plus size={12} />
            添加
          </span>
        }
      >
        {() =>
          options.length ? (
            options.map(option => {
              const checked = selectedPlugins.includes(option.label)
              return (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  data-testid={`${testId}-option-${option.id}`}
                  onClick={() => onToggle(option)}
                  className="flex h-9 w-full items-center gap-2 rounded-lg bg-transparent px-2.5 text-left text-xs text-text-secondary hover:bg-muted"
                >
                  <span
                    className={automationClass(
                      'grid size-4 place-items-center rounded border border-border-strong',
                      checked && 'border-focus bg-focus text-white'
                    )}
                  >
                    {checked ? <Check size={11} /> : null}
                  </span>
                  {option.label}
                </button>
              )
            })
          ) : (
            <small className="block px-2.5 py-2 text-xs text-text-muted">
              当前执行环境没有可用插件
            </small>
          )
        }
      </PopupMenu>
    </div>
  )
}

function CoordinatorSettings({
  coordinator,
  executionCatalog,
  onChange,
  onDelete,
  onOpenPluginMenu,
}) {
  const environmentOptions = executionCatalog.environments.some(
    option => option.deviceId === coordinator.executionDeviceId
  )
    ? executionCatalog.environments
    : coordinator.executionDeviceId
      ? [
          {
            deviceId: coordinator.executionDeviceId,
            label: coordinator.environment,
            executionEnvironment: coordinator.executionEnvironment,
          },
          ...executionCatalog.environments,
        ]
      : executionCatalog.environments
  const modelOptions = executionCatalog.models.some(option => option.name === coordinator.model)
    ? executionCatalog.models
    : coordinator.model
      ? [
          {
            name: coordinator.model,
            label: coordinator.model,
            type: coordinator.modelType,
            options: coordinator.modelOptions,
          },
          ...executionCatalog.models,
        ]
      : executionCatalog.models
  const configuredPluginOptions = [
    ...executionCatalog.plugins,
    ...coordinator.plugins
      .filter(label => !executionCatalog.plugins.some(option => option.label === label))
      .map(label => ({ id: label, label, reference: { displayName: label } })),
  ]

  const selectEnvironment = deviceId => {
    if (!deviceId) {
      clearExecutionEnvironment(onChange)
      return
    }
    const option = environmentOptions.find(candidate => candidate.deviceId === deviceId)
    if (!option) return
    onChange('executionDeviceId', option.deviceId)
    onChange('executionEnvironment', option.executionEnvironment)
    onChange('environment', option.label)
    onChange('runtimeProfileId', null)
  }

  const selectModel = name => {
    if (!name) {
      clearExecutionModel(onChange)
      return
    }
    const option = modelOptions.find(candidate => candidate.name === name)
    if (!option) return
    onChange('model', option.name)
    onChange('modelType', option.type)
    onChange('modelOptions', option.options)
    onChange('runtimeProfileId', null)
  }

  const togglePlugin = option => {
    const selected = coordinator.plugins.includes(option.label)
    onChange(
      'plugins',
      selected
        ? coordinator.plugins.filter(item => item !== option.label)
        : [...coordinator.plugins, option.label]
    )
    onChange(
      'projectPlugins',
      selected
        ? coordinator.projectPlugins.filter(item => item.id !== option.id)
        : [...coordinator.projectPlugins, option.reference]
    )
  }

  return (
    <div className={automationClass('panel-settings')}>
      <div className={automationClass('coordinator-intro')}>
        <Sparkles size={17} />
        <div>
          <strong>由 AI 决定具体怎么做</strong>
          <span>AI 读取 Issue，运行时拆解任务、选择执行方式并安排顺序。</span>
        </div>
      </div>

      <div className={automationClass('node-model-settings coordinator-model-settings')}>
        <label className={automationClass('panel-field')}>
          <span>
            <Laptop size={14} />
            调度执行环境
          </span>
          <ExecutionEnvironmentSelect
            testId="ai-coordinator-environment"
            value={coordinator.executionDeviceId ?? ''}
            options={environmentOptions}
            onChange={selectEnvironment}
          />
        </label>
        <label className={automationClass('panel-field')}>
          <span>
            <Sparkles size={14} />
            调度模型
          </span>
          <select
            data-testid="ai-coordinator-model"
            value={coordinator.model}
            onChange={event => selectModel(event.target.value)}
          >
            <option value="">不指定模型</option>
            {modelOptions.map(option => (
              <option key={`${option.type}-${option.name}`} value={option.name}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className={automationClass('panel-field')}>
          <span>
            <Puzzle size={14} />
            调度插件
          </span>
          <PluginSelector
            testId="ai-coordinator-add-plugin"
            selectedPlugins={coordinator.plugins}
            options={configuredPluginOptions}
            onToggle={togglePlugin}
            onOpen={onOpenPluginMenu}
          />
        </div>
      </div>

      <label className={automationClass('panel-field')}>
        <span>
          <Code2 size={14} />
          调度提示词
        </span>
        <textarea
          data-testid="ai-coordinator-prompt"
          value={coordinator.prompt}
          placeholder="说明如何拆解任务、选择执行者、何时等待确认，以及如何判断阶段完成"
          onChange={event => onChange('prompt', event.target.value)}
        />
      </label>
      <fieldset className={automationClass('execution-mode')}>
        <legend>任务方案确认</legend>
        <div>
          <button
            type="button"
            data-testid="ai-coordinator-approval-required"
            className={coordinator.approvalPolicy !== 'automatic' ? 'selected' : ''}
            onClick={() => onChange('approvalPolicy', 'required')}
          >
            <UserRound size={16} />
            人工确认后执行
          </button>
          <button
            type="button"
            data-testid="ai-coordinator-approval-automatic"
            className={coordinator.approvalPolicy === 'automatic' ? 'selected' : ''}
            onClick={() => onChange('approvalPolicy', 'automatic')}
          >
            <Bot size={16} />
            自动确认并执行
          </button>
        </div>
      </fieldset>
      <p className={automationClass('execution-hint')}>
        人工确认时，Issue 详情会展示 AI 拆出的任务、依赖、执行者和顺序，确认后才创建并执行子任务。
      </p>
      <div className={automationClass('panel-danger-zone compact')}>
        <button
          type="button"
          className={automationClass('delete-step')}
          data-testid="ai-coordinator-delete"
          onClick={onDelete}
        >
          <Trash2 size={14} />
          删除 AI 动态分配节点
        </button>
      </div>
    </div>
  )
}

const DEPENDENCY_CONTEXT_OPTIONS = [
  ['final_result', '最终结果'],
  ['deliveries', '交付物'],
  ['activity', '执行动态'],
]

function SubgraphDependencySummary({ node, parent, onChange }) {
  const dependencies = node.dependencies
    .map(id => parent.subgraph.nodes.find(item => item.id === id))
    .filter(Boolean)

  const toggleSource = (dependencyId, source) => {
    const current = node.dependencyContext[dependencyId] ?? ['final_result', 'deliveries']
    const next = current.includes(source)
      ? current.filter(item => item !== source)
      : [...current, source]
    onChange('dependencyContext', {
      ...node.dependencyContext,
      [dependencyId]: next,
    })
  }

  return (
    <div className={automationClass('dag-stage-dependency-summary')}>
      <span>前置阶段上下文</span>
      <div>
        {dependencies.length ? (
          dependencies.map(dependency => (
            <div key={dependency.id}>
              <em>{dependency.name}</em>
              <div>
                {DEPENDENCY_CONTEXT_OPTIONS.map(([source, label]) => (
                  <label key={source}>
                    <input
                      type="checkbox"
                      data-testid={`dag-stage-context-${node.id}-${dependency.id}-${source}`}
                      checked={(
                        node.dependencyContext[dependency.id] ?? ['final_result', 'deliveries']
                      ).includes(source)}
                      onChange={() => toggleSource(dependency.id, source)}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          ))
        ) : (
          <small>子图起点，无前置依赖</small>
        )}
      </div>
      <p>依赖决定阶段解锁顺序；上下文决定 AI 规划该阶段时可读取哪些前序产物。</p>
    </div>
  )
}

function StepSettings({
  step,
  executionCatalog,
  onChange,
  onDelete,
  onOpenPluginMenu,
  supplemental,
  constraint = false,
}) {
  if (!step) return null

  const environmentOptions = executionCatalog.environments.some(
    option => option.deviceId === step.executionDeviceId
  )
    ? executionCatalog.environments
    : step.executionDeviceId
      ? [
          {
            deviceId: step.executionDeviceId,
            label: step.environment,
            executionEnvironment: step.executionEnvironment,
          },
          ...executionCatalog.environments,
        ]
      : executionCatalog.environments
  const modelOptions = executionCatalog.models.some(option => option.name === step.model)
    ? executionCatalog.models
    : step.model
      ? [
          {
            name: step.model,
            label: step.model,
            type: step.modelType,
            options: step.modelOptions,
          },
          ...executionCatalog.models,
        ]
      : executionCatalog.models
  const configuredPluginOptions = [
    ...executionCatalog.plugins,
    ...step.plugins
      .filter(label => !executionCatalog.plugins.some(option => option.label === label))
      .map(label => ({ id: label, label, reference: { displayName: label } })),
  ]

  const selectEnvironment = deviceId => {
    if (!deviceId) {
      clearExecutionEnvironment(onChange)
      return
    }
    const option = environmentOptions.find(candidate => candidate.deviceId === deviceId)
    if (!option) return
    onChange('executionDeviceId', option.deviceId)
    onChange('executionEnvironment', option.executionEnvironment)
    onChange('environment', option.label)
    onChange('runtimeProfileId', null)
  }

  const selectModel = name => {
    if (!name) {
      clearExecutionModel(onChange)
      return
    }
    const option = modelOptions.find(candidate => candidate.name === name)
    if (!option) return
    onChange('model', option.name)
    onChange('modelType', option.type)
    onChange('modelOptions', option.options)
    onChange('runtimeProfileId', null)
  }

  const togglePlugin = option => {
    const selected = step.plugins.includes(option.label)
    onChange(
      'plugins',
      selected
        ? step.plugins.filter(item => item !== option.label)
        : [...step.plugins, option.label]
    )
    onChange(
      'projectPlugins',
      selected
        ? step.projectPlugins.filter(item => item.id !== option.id)
        : [...step.projectPlugins, option.reference]
    )
  }

  const addDeliverable = () => {
    onChange('deliverables', [
      ...step.deliverables,
      {
        id: `deliverable-${Date.now()}`,
        name: '新交付物',
        description: '',
        valueType: 'text',
        fileConstraints: null,
      },
    ])
  }

  const updateDeliverable = (id, key, value) => {
    onChange(
      'deliverables',
      step.deliverables.map(deliverable =>
        deliverable.id === id ? { ...deliverable, [key]: value } : deliverable
      )
    )
  }

  const updateDeliverableType = (id, valueType) => {
    const deliverable = step.deliverables.find(item => item.id === id)
    if (!deliverable) return
    onChange(
      'deliverables',
      step.deliverables.map(item =>
        item.id === id
          ? {
              ...item,
              valueType,
              fileConstraints:
                valueType === 'file'
                  ? (deliverable.fileConstraints ?? {
                      accepted_types: [],
                      min_files: 1,
                      max_files: 1,
                    })
                  : null,
            }
          : item
      )
    )
  }

  return (
    <>
      <section className={automationClass('panel-section')}>
        <label className={automationClass('panel-field')}>
          <span>{constraint ? '阶段名称' : '节点名称'}</span>
          <input
            data-testid={`execution-node-name-${step.id}`}
            value={step.name}
            placeholder={constraint ? '例如：需求分析阶段' : '例如：分析需求'}
            onChange={event => onChange('name', event.target.value)}
          />
        </label>
        <label className={automationClass('panel-field')}>
          <span>
            <Code2 size={14} />
            {constraint ? '阶段目标与约束' : '节点提示词'}
          </span>
          <textarea
            data-testid={`execution-node-prompt-${step.id}`}
            value={step.prompt}
            placeholder={
              constraint
                ? '描述该阶段要达成的目标、执行边界和验收标准'
                : '清楚描述这个节点需要完成的具体任务'
            }
            onChange={event => onChange('prompt', event.target.value)}
          />
        </label>
      </section>

      <section className={automationClass('deliverables-section')}>
        <div className={automationClass('section-heading')}>
          <strong>必要交付物</strong>
          <button
            type="button"
            data-testid={`execution-node-add-deliverable-${step.id}`}
            onClick={addDeliverable}
          >
            <Plus size={13} />
            添加交付物
          </button>
        </div>
        {step.deliverables.length ? (
          <div className={automationClass('deliverable-list')}>
            {step.deliverables.map(deliverable => (
              <div className={automationClass('deliverable-item')} key={deliverable.id}>
                <div>
                  <input
                    data-testid={`execution-node-deliverable-name-${deliverable.id}`}
                    value={deliverable.name}
                    aria-label="交付物名称"
                    onChange={event =>
                      updateDeliverable(deliverable.id, 'name', event.target.value)
                    }
                  />
                  <input
                    data-testid={`execution-node-deliverable-description-${deliverable.id}`}
                    value={deliverable.description}
                    aria-label="交付物验收说明"
                    placeholder="暂无验收说明"
                    onChange={event =>
                      updateDeliverable(deliverable.id, 'description', event.target.value)
                    }
                  />
                </div>
                <select
                  data-testid={`execution-node-deliverable-type-${deliverable.id}`}
                  value={deliverable.valueType}
                  aria-label={`交付物类型 ${deliverable.name}`}
                  onChange={event => updateDeliverableType(deliverable.id, event.target.value)}
                >
                  {DELIVERABLE_TYPE_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  data-testid={`execution-node-deliverable-delete-${deliverable.id}`}
                  aria-label={`删除交付物 ${deliverable.name}`}
                  onClick={() =>
                    onChange(
                      'deliverables',
                      step.deliverables.filter(item => item.id !== deliverable.id)
                    )
                  }
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <button
            className={automationClass('empty-deliverables')}
            type="button"
            data-testid={`execution-node-empty-deliverables-${step.id}`}
            onClick={addDeliverable}
          >
            暂无交付物，点击添加
          </button>
        )}
        <p>每项交付要求都会绑定一个实际结果；全部满足后才可继续。</p>
      </section>

      <section className={automationClass('panel-section execution-section')}>
        <fieldset className={automationClass('execution-mode')}>
          <legend>{constraint ? '阶段执行偏好' : '任务执行方式'}</legend>
          <div>
            <button
              type="button"
              data-testid={`execution-node-mode-manual-${step.id}`}
              className={step.executionMode === 'manual' ? 'selected' : ''}
              onClick={() => onChange('executionMode', 'manual')}
            >
              <UserRound size={16} />
              手动执行
            </button>
            <button
              type="button"
              data-testid={`execution-node-mode-automatic-${step.id}`}
              className={step.executionMode === 'automatic' ? 'selected' : ''}
              onClick={() => onChange('executionMode', 'automatic')}
            >
              <Bot size={16} />
              自动执行
            </button>
          </div>
        </fieldset>

        {!constraint && step.executionMode === 'automatic' ? (
          <div className={automationClass('node-model-settings')}>
            <label className={automationClass('panel-field')}>
              <span>
                <Laptop size={14} />
                执行环境
              </span>
              <ExecutionEnvironmentSelect
                testId={`execution-node-environment-${step.id}`}
                value={step.executionDeviceId ?? ''}
                options={environmentOptions}
                onChange={selectEnvironment}
              />
            </label>
            <label className={automationClass('panel-field')}>
              <span>
                <Sparkles size={14} />
                模型
              </span>
              <select
                data-testid={`execution-node-model-${step.id}`}
                value={step.model}
                onChange={event => selectModel(event.target.value)}
              >
                <option value="">不指定模型</option>
                {modelOptions.map(option => (
                  <option key={`${option.type}-${option.name}`} value={option.name}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className={automationClass('panel-field')}>
              <span>
                <Puzzle size={14} />
                插件
              </span>
              <PluginSelector
                testId={`execution-node-add-plugin-${step.id}`}
                selectedPlugins={step.plugins}
                options={configuredPluginOptions}
                onToggle={togglePlugin}
                onOpen={onOpenPluginMenu}
              />
            </div>
            <p className={automationClass('execution-hint')}>
              节点提示词会作为当前模型的任务指令，执行记录归入当前节点。
            </p>
          </div>
        ) : !constraint ? (
          <p className={automationClass('execution-hint')}>
            节点就绪后由成员手动执行，完成结果仍归入当前节点。
          </p>
        ) : (
          <p className={automationClass('execution-hint')}>
            这里只约束阶段由人工还是机器人执行；具体执行环境、模型和插件由 AI 调度器在运行时选择。
          </p>
        )}

        {!constraint ? (
          <label className={automationClass('panel-field')}>
            <span>任务工作空间</span>
            <select
              data-testid={`execution-node-workspace-${step.id}`}
              value={step.workspacePolicy}
              onChange={event => onChange('workspacePolicy', event.target.value)}
            >
              <option value="composer">创建任务时选择工作空间</option>
              <option value="inherit">继承前序任务工作空间</option>
              <option value="none">不限定工作空间</option>
            </select>
          </label>
        ) : null}

        <label className={automationClass('required-node')}>
          <input
            type="checkbox"
            data-testid={`execution-node-required-${step.id}`}
            checked={step.required}
            onChange={event => onChange('required', event.target.checked)}
          />
          该节点完成后才能推进 Issue
        </label>

        <div className={automationClass('panel-help')}>
          <GitBranch size={15} />
          <p>
            {constraint
              ? '阶段按 DAG 依赖解锁，AI 会在阶段就绪后规划具体任务。'
              : '执行节点按画布顺序运行；模型、环境和插件只影响当前节点。'}
          </p>
        </div>
      </section>
      {supplemental ? (
        <section className={automationClass('panel-section')}>{supplemental}</section>
      ) : null}
      <section className={automationClass('panel-danger-zone')}>
        <button
          className={automationClass('delete-step')}
          data-testid={`execution-node-delete-${step.id}`}
          onClick={onDelete}
        >
          <Trash2 size={14} />
          {constraint ? '删除阶段约束' : '删除执行节点'}
        </button>
      </section>
    </>
  )
}

function RunsHome({ runs, rules, loading, onOpenRule }) {
  const [status, setStatus] = useState('all')
  const visibleRuns = runs.filter(run => runMatchesFilter(run.status, status))

  return (
    <main className={automationClass('runs-home')}>
      <div className={automationClass('runs-title')}>
        <div>
          <h1>运行记录</h1>
          <p>查看自动化的执行过程、结果与耗时。</p>
        </div>
        <div className={automationClass('run-filters')}>
          {[
            ['all', '全部'],
            ['active', '未结束'],
            ['success', '成功'],
            ['failed', '失败'],
          ].map(([value, label]) => (
            <button
              key={value}
              className={status === value ? 'active' : ''}
              onClick={() => setStatus(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className={automationClass('runs-table')}>
        <div className={automationClass('runs-table-head')}>
          <span>自动化与 Issue</span>
          <span>状态</span>
          <span>触发时间</span>
          <span>耗时</span>
          <span />
        </div>
        {loading ? (
          <div className={automationClass('home-empty')} data-testid="automation-runs-loading">
            <Activity className={automationClass('spin')} size={22} />
            <strong>正在加载运行记录</strong>
          </div>
        ) : (
          visibleRuns.map(run => (
            <div className={automationClass('runs-row')} key={run.id}>
              <span>
                <strong>{run.ruleName}</strong>
                <small>{run.issue}</small>
              </span>
              <RunStatus status={run.status} />
              <span>{run.startedAt}</span>
              <span>{run.duration}</span>
              <button
                onClick={() => {
                  const rule = rules.find(item => item.id === run.ruleId)
                  if (rule) onOpenRule(rule)
                }}
              >
                打开规则
              </button>
            </div>
          ))
        )}
      </div>
    </main>
  )
}
