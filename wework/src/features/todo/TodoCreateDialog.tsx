import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Bold,
  Bot,
  CalendarDays,
  ChevronDown,
  CircleDot,
  Code2,
  Image,
  Italic,
  Link2,
  List,
  Paperclip,
  Play,
  Plus,
  Sparkles,
  X,
} from 'lucide-react'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import type { ProjectWithTasks } from '@/types/api'
import type { TodoViewState } from './TodoDetailPanel'

export interface TodoCreateValues {
  projectId: number
  state: TodoViewState
  goal: string
  markdown: string
  priority: 'none' | 'urgent' | 'high' | 'normal' | 'low'
  assignee: 'unassigned' | 'ai' | 'human'
  launchMode: 'manual' | 'automatic'
  dueDate: string
  files: File[]
}

interface TodoCreateDialogProps {
  projects: ProjectWithTasks[]
  initialProjectId: number
  initialState: TodoViewState
  modelName?: string | null
  onClose: () => void
  onSubmit: (values: TodoCreateValues, runImmediately: boolean) => Promise<void> | void
}

const STATE_OPTIONS: Array<{ value: TodoViewState; key: string; fallback: string }> = [
  { value: 'backlog', key: 'todo.state_backlog', fallback: '待处理' },
  { value: 'started', key: 'todo.state_started', fallback: '进行中' },
  { value: 'review', key: 'todo.state_review', fallback: '待确认' },
  { value: 'completed', key: 'todo.state_completed', fallback: '已完成' },
]

export function TodoCreateDialog({
  projects,
  initialProjectId,
  initialState,
  modelName,
  onClose,
  onSubmit,
}: TodoCreateDialogProps) {
  const { t } = useTranslation('common')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [projectId, setProjectId] = useState(initialProjectId)
  const [state, setState] = useState<TodoViewState>(initialState)
  const [goal, setGoal] = useState('')
  const [markdown, setMarkdown] = useState('')
  const [priority, setPriority] = useState<TodoCreateValues['priority']>('none')
  const [assignee, setAssignee] = useState<TodoCreateValues['assignee']>('unassigned')
  const [launchMode, setLaunchMode] = useState<TodoCreateValues['launchMode']>('manual')
  const [dueDate, setDueDate] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selectedProject = projects.find(project => project.id === projectId) ?? projects[0]

  useEscapeKey(() => {
    if (!submitting) onClose()
  }, true)

  const addFiles = (incoming: FileList | File[]) => {
    const next = Array.from(incoming)
    setFiles(current => {
      const existing = new Set(
        current.map(file => `${file.name}:${file.size}:${file.lastModified}`)
      )
      return [
        ...current,
        ...next.filter(file => !existing.has(`${file.name}:${file.size}:${file.lastModified}`)),
      ]
    })
  }

  const submit = async (runImmediately: boolean) => {
    if (!markdown.trim()) {
      setError(t('todo.create_content_required', '请填写任务信息'))
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(
        { projectId, state, goal, markdown, priority, assignee, launchMode, dueDate, files },
        runImmediately
      )
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : t('todo.create_failed', 'TODO 创建失败')
      )
      setSubmitting(false)
    }
  }

  return (
    <div
      data-testid="todo-create-dialog-overlay"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[#11182766] p-5"
      onMouseDown={event => {
        if (event.currentTarget === event.target && !submitting) onClose()
      }}
    >
      <section
        data-testid="todo-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="todo-create-dialog-title"
        className="flex h-[min(744px,calc(100vh-40px))] w-[772px] max-w-[calc(100vw-40px)] flex-col overflow-hidden rounded-xl border border-[#D8DCE0] bg-white shadow-[0_18px_42px_rgba(17,24,39,0.30)] dark:border-border dark:bg-background"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-[#E2E5E7] px-[18px] dark:border-border">
          <div className="flex min-w-0 items-center gap-3">
            <h2
              id="todo-create-dialog-title"
              className="shrink-0 text-lg font-semibold text-[#24282D] dark:text-text-primary"
            >
              {t('todo.create_action', '新建 TODO')}
            </h2>
            <label className="relative flex h-[30px] min-w-0 max-w-[230px] items-center gap-2 rounded-md border border-[#E0E3E6] bg-[#F7F8F9] pl-2.5 pr-7 dark:border-border dark:bg-muted">
              <span
                className="h-[18px] w-[18px] shrink-0 rounded-[4px]"
                style={{ backgroundColor: selectedProject?.color || '#14B8A6' }}
              />
              <span className="truncate text-xs font-semibold text-[#4A5158] dark:text-text-primary">
                {selectedProject?.name ?? t('todo.no_project', '未选择项目')}
              </span>
              <select
                data-testid="todo-create-project"
                value={projectId}
                onChange={event => setProjectId(Number(event.target.value))}
                className="absolute inset-0 cursor-pointer appearance-none opacity-0"
                aria-label={t('todo.switch_project', '切换项目')}
              >
                {projects.map(project => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 h-3 w-3 text-[#818991]" />
            </label>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs text-[#969EA5]">
              ESC {t('workbench.close', '关闭')}
            </span>
            <button
              type="button"
              data-testid="todo-create-close"
              onClick={onClose}
              disabled={submitting}
              className="flex h-7 w-7 items-center justify-center rounded-md text-[#6F7880] hover:bg-[#F2F4F5] disabled:opacity-50 dark:hover:bg-muted"
              aria-label={t('workbench.close', '关闭')}
            >
              <X className="h-[15px] w-[15px]" />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="space-y-[13px]">
            <div className="flex h-8 items-center justify-between rounded-md bg-[#F7F8F9] px-2.5 dark:bg-muted">
              <span className="flex items-center gap-2 text-xs font-semibold text-[#626A72] dark:text-text-secondary">
                <span className="h-2.5 w-2.5 rounded-full bg-[#858E97]" />
                {t('todo.create_into_state', {
                  defaultValue: '将创建到「{{state}}」',
                  state: t(
                    STATE_OPTIONS.find(option => option.value === state)?.key ??
                      'todo.state_backlog',
                    STATE_OPTIONS.find(option => option.value === state)?.fallback ?? '待处理'
                  ),
                })}
              </span>
              <span className="text-xs text-[#949CA3]">
                {t('todo.create_state_source', '由当前看板列预填')}
              </span>
            </div>

            <FormGroup label={t('todo.goal', '目标')} hint={t('todo.optional', '可选')}>
              <input
                data-testid="todo-create-goal"
                value={goal}
                onChange={event => setGoal(event.target.value)}
                placeholder={t('todo.goal_placeholder', '例如：用户登录后 2 秒内稳定进入工作区')}
                className="h-[38px] w-full rounded-md border border-[#DDE1E4] bg-white px-3 text-xs text-[#424A52] outline-none placeholder:text-[#A1A8AF] focus:border-[#8FD6CE] dark:border-border dark:bg-background dark:text-text-primary"
              />
            </FormGroup>

            <FormGroup
              label={t('todo.task_markdown', '任务信息 · Markdown')}
              hint={t('todo.markdown_model_hint', '模型会读取全文并自动生成卡片标题')}
              spread
            >
              <div
                className="h-[clamp(190px,26vh,236px)] overflow-hidden rounded-[7px] border border-[#D9DDE0] bg-white dark:border-border dark:bg-background"
                onDragOver={event => event.preventDefault()}
                onDrop={event => {
                  event.preventDefault()
                  addFiles(event.dataTransfer.files)
                }}
              >
                <div className="flex h-[34px] items-center justify-between border-b border-[#E5E7E9] bg-[#F7F8F9] px-2 dark:border-border dark:bg-muted">
                  <div className="flex items-center gap-1 text-[#707981]">
                    <MarkdownTool icon={Bold} />
                    <MarkdownTool icon={Italic} />
                    <MarkdownTool icon={Code2} />
                    <MarkdownTool icon={List} />
                    <MarkdownTool icon={Link2} />
                  </div>
                  <button
                    type="button"
                    data-testid="todo-create-attach-toolbar"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex h-6 items-center gap-1 rounded px-1.5 text-xs text-[#6D767E] hover:bg-[#EDEFF1] dark:hover:bg-background"
                  >
                    <Paperclip className="h-3 w-3" />
                    {t('todo.add_attachment', '添加附件')}
                  </button>
                </div>
                <textarea
                  autoFocus
                  data-testid="todo-create-markdown"
                  value={markdown}
                  onChange={event => setMarkdown(event.target.value)}
                  placeholder={t(
                    'todo.markdown_placeholder',
                    '写下任务背景、问题、要求或任何模型需要读取的内容…'
                  )}
                  className="block h-[calc(100%-78px)] w-full resize-none bg-white px-3 py-2.5 font-mono text-xs leading-[1.5] text-[#424A52] outline-none placeholder:font-sans placeholder:text-[#A1A8AF] dark:bg-background dark:text-text-primary"
                />
                <div className="flex h-11 items-center justify-between border-t border-[#E8EAEC] bg-[#FAFBFB] px-2.5 dark:border-border dark:bg-background">
                  <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                    <input
                      ref={fileInputRef}
                      data-testid="todo-create-file-input"
                      type="file"
                      multiple
                      className="hidden"
                      onChange={event => {
                        if (event.target.files) addFiles(event.target.files)
                        event.target.value = ''
                      }}
                    />
                    {files.length === 0 ? (
                      <span className="flex items-center gap-1.5 text-xs text-[#899199]">
                        <Paperclip className="h-3 w-3" />
                        {t('todo.no_attachments', '暂无附件')}
                      </span>
                    ) : (
                      files.slice(0, 3).map((file, index) => (
                        <button
                          key={`${file.name}:${file.lastModified}`}
                          type="button"
                          data-testid={`todo-create-file-${index}`}
                          onClick={() => setFiles(current => current.filter(item => item !== file))}
                          className="flex h-6 max-w-[160px] items-center gap-1 rounded border border-[#E0E3E6] bg-white px-1.5 text-xs text-[#626A72] hover:bg-[#F2F4F5] dark:border-border dark:bg-muted"
                          title={t('todo.remove_attachment', '移除附件')}
                        >
                          <Image className="h-3 w-3 shrink-0" />
                          <span className="truncate">{file.name}</span>
                          <X className="h-2.5 w-2.5 shrink-0" />
                        </button>
                      ))
                    )}
                    {files.length > 3 && (
                      <span className="text-xs text-[#899199]">+{files.length - 3}</span>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-[#9AA1A8]">
                    {t('todo.drop_files_hint', '可拖拽文件到编辑器')}
                  </span>
                </div>
              </div>
            </FormGroup>

            <FormGroup
              label="Properties"
              hint={t('todo.properties_optional', '全部可选，可创建后再补充')}
              spread
            >
              <div className="grid grid-cols-3 gap-1.5">
                <PropertySelect
                  testId="todo-create-state"
                  icon={CircleDot}
                  value={state}
                  onChange={value => setState(value as TodoViewState)}
                  options={STATE_OPTIONS.map(option => ({
                    value: option.value,
                    label: t(option.key, option.fallback),
                  }))}
                />
                <PropertySelect
                  testId="todo-create-priority"
                  icon={Sparkles}
                  value={priority}
                  onChange={value => setPriority(value as TodoCreateValues['priority'])}
                  options={[
                    { value: 'none', label: t('todo.priority_none', '优先级：无') },
                    { value: 'urgent', label: t('todo.priority_urgent', '紧急') },
                    { value: 'high', label: t('todo.priority_high', '高') },
                    { value: 'normal', label: t('todo.priority_normal', '普通') },
                    { value: 'low', label: t('todo.priority_low', '低') },
                  ]}
                />
                <DateProperty
                  value={dueDate}
                  onChange={setDueDate}
                  label={t('todo.due_date', '截止时间')}
                />
              </div>
            </FormGroup>

            <FormGroup
              label={t('todo.execution_settings', '执行设置')}
              hint={t('todo.executor_hint', '承接者支持员工或 AI 智能体')}
              spread
            >
              <div className="grid grid-cols-3 gap-1.5">
                <PropertySelect
                  testId="todo-create-executor"
                  icon={Bot}
                  value={assignee}
                  onChange={value => setAssignee(value as TodoCreateValues['assignee'])}
                  options={[
                    { value: 'unassigned', label: t('todo.executor_unassigned', '承接者：未指定') },
                    { value: 'ai', label: t('todo.assignee_ai', 'AI 智能体') },
                    { value: 'human', label: t('todo.assignee_human', '员工') },
                  ]}
                />
                {assignee === 'ai' && (
                  <div
                    data-testid="todo-create-model"
                    className="flex h-[30px] min-w-0 items-center gap-1.5 rounded-md border border-[#E1E4E7] bg-[#F7F8F9] px-2 dark:border-border dark:bg-muted"
                  >
                    <Bot className="h-3 w-3 shrink-0 text-[#7C858D]" />
                    <span className="truncate text-xs text-[#626A72] dark:text-text-secondary">
                      {modelName || t('todo.model_automatic', 'Model：自动')}
                    </span>
                  </div>
                )}
                <PropertySelect
                  testId="todo-create-launch-mode"
                  icon={Play}
                  value={launchMode}
                  onChange={value => setLaunchMode(value as TodoCreateValues['launchMode'])}
                  options={[
                    { value: 'manual', label: t('todo.launch_manual', '启动方式：手动') },
                    { value: 'automatic', label: t('todo.launch_automatic', '启动方式：自动') },
                  ]}
                />
              </div>
            </FormGroup>
          </div>
        </div>

        <footer className="flex h-[72px] shrink-0 items-center justify-between border-t border-[#E0E3E6] bg-[#FAFBFB] px-[18px] dark:border-border dark:bg-background">
          <span
            className={`flex min-w-0 items-center gap-1.5 text-xs font-semibold ${
              error ? 'text-destructive' : 'text-[#57706D]'
            }`}
          >
            {error ? (
              error
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5 text-[#0F8F82]" />
                {t('todo.creation_principle', '内容保持自由，运行时自动结构化')}
              </>
            )}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              data-testid="todo-create-cancel"
              onClick={onClose}
              disabled={submitting}
              className="h-[34px] rounded-md border border-[#D8DCE0] bg-white px-3 text-xs font-semibold text-[#596169] hover:bg-[#F5F6F7] disabled:opacity-50 dark:border-border dark:bg-background dark:text-text-secondary"
            >
              {t('workbench.cancel', '取消')}
            </button>
            <button
              type="button"
              data-testid="todo-create-submit"
              onClick={() => void submit(false)}
              disabled={submitting}
              className="flex h-[34px] items-center gap-1.5 rounded-md border border-[#A9DAD3] bg-white px-3 text-xs font-bold text-[#0F766E] hover:bg-[#F1FAF8] disabled:opacity-50 dark:bg-background"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('todo.create_only', '创建 TODO')}
            </button>
            <button
              type="button"
              data-testid="todo-create-and-run"
              onClick={() => void submit(true)}
              disabled={submitting}
              className="flex h-[34px] items-center gap-1.5 rounded-md bg-[#14B8A6] px-3.5 text-xs font-bold text-white hover:bg-[#0FA797] disabled:opacity-50"
            >
              <Play className="h-3 w-3 fill-current" />
              {submitting ? t('todo.creating', '创建中…') : t('todo.create_and_run', '创建并运行')}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}

function FormGroup({
  label,
  hint,
  spread = false,
  children,
}: {
  label: string
  hint: string
  spread?: boolean
  children: ReactNode
}) {
  return (
    <section className="space-y-1.5">
      <div className={`flex items-center ${spread ? 'justify-between' : 'gap-1.5'}`}>
        <span className="text-xs font-semibold text-[#555D65] dark:text-text-secondary">
          {label}
        </span>
        <span className="text-xs text-[#929AA1]">{hint}</span>
      </div>
      {children}
    </section>
  )
}

function MarkdownTool({ icon: Icon }: { icon: typeof Bold }) {
  return (
    <span className="flex h-5 w-5 items-center justify-center rounded">
      <Icon className="h-3 w-3" />
    </span>
  )
}

function PropertySelect({
  testId,
  icon: Icon,
  value,
  options,
  onChange,
}: {
  testId: string
  icon: typeof CircleDot
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}) {
  return (
    <label className="relative flex h-[30px] min-w-0 items-center gap-1.5 rounded-md border border-[#E1E4E7] bg-[#F7F8F9] px-2 dark:border-border dark:bg-muted">
      <Icon className="h-3 w-3 shrink-0 text-[#7C858D]" />
      <span className="truncate text-xs text-[#626A72] dark:text-text-secondary">
        {options.find(option => option.value === value)?.label}
      </span>
      <ChevronDown className="ml-auto h-2.5 w-2.5 shrink-0 text-[#9AA1A8]" />
      <select
        data-testid={testId}
        value={value}
        onChange={event => onChange(event.target.value)}
        className="absolute inset-0 cursor-pointer appearance-none opacity-0"
        aria-label={options.find(option => option.value === value)?.label}
      >
        {options.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function DateProperty({
  value,
  label,
  onChange,
}: {
  value: string
  label: string
  onChange: (value: string) => void
}) {
  return (
    <label className="relative flex h-[30px] min-w-0 items-center gap-1.5 rounded-md border border-[#E1E4E7] bg-[#F7F8F9] px-2 dark:border-border dark:bg-muted">
      <CalendarDays className="h-3 w-3 shrink-0 text-[#7C858D]" />
      <span className="truncate text-xs text-[#626A72] dark:text-text-secondary">
        {value || label}
      </span>
      <input
        data-testid="todo-create-due-date"
        type="date"
        value={value}
        onChange={event => onChange(event.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
        aria-label={label}
      />
    </label>
  )
}
