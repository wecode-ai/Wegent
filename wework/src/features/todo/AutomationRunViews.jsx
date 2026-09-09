import { useState } from 'react'
import {
  Activity,
  CheckCircle2,
  Circle,
  Clock3,
  Copy,
  History,
  MoreHorizontal,
  Play,
  Trash2,
  Webhook,
  XCircle,
  Zap,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { PopupMenu } from '@/components/common/MenuSelect'
import { automationClass } from './automationStyles'
import { triggerPresentation } from './AutomationRuleModel.jsx'

export const ACTIVE_RUN_STATUSES = new Set([
  'pending',
  'queued',
  'waiting_runtime',
  'waiting_device',
  'running',
])

export function runMatchesFilter(status, filter) {
  if (filter === 'all') return true
  if (filter === 'active') return ACTIVE_RUN_STATUSES.has(status)
  if (filter === 'success') return status === 'succeeded'
  if (filter === 'failed') return status === 'failed' || status === 'cancelled'
  return false
}

export function runStatusPresentation(status) {
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

export function AutomationCard({
  rule,
  canManage,
  onOpen,
  onToggle,
  onDuplicate,
  onDelete,
  onRun,
  running,
}) {
  const { t } = useTranslation('common')
  const [menuOpen, setMenuOpen] = useState(false)
  const trigger = triggerPresentation(rule.trigger, t)
  const TriggerIcon = rule.trigger.type === 'schedule' ? Clock3 : Webhook
  const statusText = running
    ? t('workbench.board_automation_running')
    : rule.enabled
      ? rule.nextRunAt
        ? `运行中 · 下次 ${formatCardTime(rule.nextRunAt)}`
        : '运行中'
      : '已停用'
  const lastRunText = rule.lastRunAt
    ? `${formatCardTimestamp(rule.lastRunAt)}${rule.lastRunStatus ? ` · ${runStatusPresentation(rule.lastRunStatus).label}` : ''}`
    : '尚未运行'

  return (
    <article
      className={automationClass(`automation-card ${rule.enabled ? 'enabled' : ''}`)}
      data-testid={`automation-card-${rule.id}`}
      onClick={event => {
        if (event.target.closest('button')) return
        onOpen()
      }}
    >
      <div className={automationClass('card-head')}>
        <span className={automationClass('automation-icon')}>
          <Zap size={19} />
        </span>
        <div className={automationClass('card-title')}>
          <h3>{rule.name}</h3>
          <span className={automationClass('card-status')}>
            <i />
            {statusText}
          </span>
        </div>
        <div className={automationClass('card-menu-anchor')}>
          <PopupMenu
            testId={`automation-menu-${rule.id}`}
            menuWidth={144}
            triggerClassName={automationClass('icon-button')}
            ariaLabel="更多操作"
            trigger={<MoreHorizontal size={17} />}
          >
            {close => (
              <>
                <button
                  className={automationClass('card-menu-action')}
                  disabled={!canManage}
                  data-testid={`automation-duplicate-${rule.id}`}
                  onClick={() => {
                    close()
                    onDuplicate()
                  }}
                >
                  <Copy size={14} />
                  创建独立副本
                </button>
                <button
                  className={automationClass('card-menu-action danger')}
                  disabled={!canManage}
                  data-testid={`automation-delete-${rule.id}`}
                  onClick={() => {
                    close()
                    onDelete()
                  }}
                >
                  <Trash2 size={14} />
                  删除
                </button>
              </>
            )}
          </PopupMenu>
        </div>
      </div>

      <div className={automationClass('trigger-summary')}>
        <TriggerIcon className={automationClass('trigger-summary-icon')} size={18} />
        <div className={automationClass('trigger-summary-copy')}>
          <span>触发规则</span>
          <strong>{trigger.label}</strong>
          <small>{trigger.detail}</small>
        </div>
      </div>

      <div className={automationClass('card-footer')}>
        <div className={automationClass('card-last-run')}>
          <span>上次运行</span>
          <strong>{lastRunText}</strong>
        </div>
        <div className={automationClass('card-actions')}>
          {rule.trigger.type === 'schedule' && onRun ? (
            <button
              className={automationClass('card-run-action')}
              data-testid={`automation-run-${rule.id}`}
              disabled={!canManage || running}
              onClick={event => {
                event.stopPropagation()
                onRun()
              }}
            >
              <Play size={14} />
              {t(running ? 'workbench.board_automation_running' : 'workbench.board_automation_run')}
            </button>
          ) : null}
          <button
            role="switch"
            aria-checked={rule.enabled}
            aria-label={rule.enabled ? '停用自动化' : '启用自动化'}
            data-testid={`automation-toggle-${rule.id}`}
            disabled={!canManage || rule.origin === 'legacy_workflow'}
            className={automationClass(`switch ${rule.enabled ? 'on' : ''}`)}
            onClick={event => {
              event.stopPropagation()
              onToggle()
            }}
          >
            <span>
              <i />
            </span>
          </button>
        </div>
      </div>
    </article>
  )
}

export function formatCardTimestamp(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  }).format(new Date(value))
}

export function formatCardTime(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  }).format(new Date(value))
}

export function RuleRunsPanel({ runs, loading, status, selectedRun, onStatusChange, onSelectRun }) {
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

export function RunDetailPanel({ run, steps }) {
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

export function RunStatusIcon({ status, size }) {
  const Icon = runStatusPresentation(status).icon
  return <Icon size={size} />
}

export function RunStatus({ status }) {
  const presentation = runStatusPresentation(status)
  return (
    <span className={automationClass(`run-status ${presentation.tone}`)}>
      <RunStatusIcon status={status} size={14} />
      {presentation.label}
    </span>
  )
}

export function RunsHome({ runs, rules, loading, onOpenRule }) {
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
