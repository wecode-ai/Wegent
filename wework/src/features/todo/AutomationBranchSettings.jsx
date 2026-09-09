import { PopupMenu } from '@/components/common/MenuSelect'
import { useTranslation } from '@/hooks/useTranslation'
import { Plus, X, Repeat, Clock3, Trash2, Box, Sparkles, Webhook } from 'lucide-react'
import { automationClass } from './automationStyles'
import { eventTypeLabel } from './eventTypeLabel'
import { EventSubscriptionPicker } from './EventSubscriptionManager'
export function PollIntervalField({ testId, value, onChange, index }) {
  const minutes = Math.max(1, Math.round((value ?? 300) / 60))
  const suggestionsId = `${testId}-suggestions`
  return (
    <label className={automationClass('panel-field')}>
      <span>
        {index ? <i className={automationClass('cascade-index')}>{index}</i> : null}
        轮询间隔
      </span>
      <div className={automationClass('poll-interval-control')}>
        <input
          data-testid={testId}
          type="number"
          min={1}
          max={1440}
          step={1}
          list={suggestionsId}
          value={minutes}
          onChange={event => onChange(Math.max(1, Number(event.target.value) || 1) * 60)}
        />
        <span>分钟</span>
        <datalist id={suggestionsId}>
          <option value="1" />
          <option value="3" />
          <option value="5" />
          <option value="10" />
          <option value="30" />
        </datalist>
      </div>
      <small className={automationClass('panel-field-hint')}>
        常用 1、3、5、10 分钟，也可输入任意整数
      </small>
    </label>
  )
}

export function LoopSettings({ step, onChange, onDelete }) {
  const loopConfig = normalizeLoopConfig(step.loopConfig)
  const updateLoopConfig = next => onChange('loopConfig', next)
  return (
    <div className={automationClass('panel-settings')}>
      <label className={automationClass('panel-field')}>
        <span>
          <Repeat size={14} />
          循环名称
        </span>
        <input
          data-testid="loop-node-name"
          value={step.name}
          placeholder="例如：修复 CI 直到合入"
          onChange={event => onChange('name', event.target.value)}
        />
      </label>

      <div className={automationClass('node-model-settings')}>
        <label className={automationClass('panel-field')}>
          <span>
            <Repeat size={14} />
            最大循环次数（0 = 无限）
          </span>
          <input
            data-testid="loop-max-attempts"
            type="number"
            min={0}
            value={loopConfig.maxAttempts}
            onChange={event =>
              updateLoopConfig({
                ...loopConfig,
                maxAttempts: Math.max(0, Number(event.target.value) || 0),
              })
            }
          />
        </label>
        <label className={automationClass('panel-field')}>
          <span>
            <Clock3 size={14} />
            超时秒数（留空关闭）
          </span>
          <input
            data-testid="loop-timeout-seconds"
            type="number"
            min={1}
            value={loopConfig.timeoutSeconds ?? ''}
            placeholder="关闭"
            onChange={event =>
              updateLoopConfig({
                ...loopConfig,
                timeoutSeconds:
                  event.target.value === '' ? null : Math.max(1, Number(event.target.value) || 1),
              })
            }
          />
        </label>
      </div>
      <p className={automationClass('execution-hint')}>
        循环从「循环开始」进入；执行到「循环结束」、达到最大循环次数或超时即退出；也可用强行推进人工跳出。
      </p>
      <div className={automationClass('panel-danger-zone compact')}>
        <button
          type="button"
          className={automationClass('delete-step')}
          data-testid="loop-node-delete"
          onClick={onDelete}
        >
          <Trash2 size={14} />
          删除循环
        </button>
      </div>
    </div>
  )
}

export const branchHandlerPresentation = {
  task: { label: '执行任务', Icon: Box },
  dynamic: { label: 'AI 动态分配', Icon: Sparkles },
  loop: { label: '循环', Icon: Repeat },
  branch: { label: '分支', Icon: Webhook },
}

export function normalizeLoopConfig(config) {
  return {
    maxAttempts: Number.isFinite(config?.maxAttempts) ? config.maxAttempts : 5,
    timeoutSeconds: config?.timeoutSeconds ?? null,
  }
}

export function BranchSettings({
  step,
  bodyNodes,
  eventTypeOptions,
  eventSourceCatalog = [],
  projectIncomingHookApi,
  projectId,
  canManage,
  onChange,
  onDelete,
}) {
  const { t } = useTranslation('common')
  const conditions = step.branchConditions ?? []
  const eventWait = step.eventWait ?? {
    collectionMode: 'poll',
    subscriptionId: null,
    pollIntervalSeconds: 300,
  }
  const platformSources = eventSourceCatalog.filter(
    source => source.sourceType === 'github' || source.sourceType === 'gitlab'
  )
  const eventTypesBySource = new Map(
    platformSources.map(source => [
      source.sourceType,
      (source.eventTypes?.length ? source.eventTypes : eventTypeOptions).filter(eventType =>
        eventType.startsWith('change_request.')
      ),
    ])
  )
  const updateCondition = (index, key, value) => {
    onChange(
      'branchConditions',
      conditions.map((condition, candidate) =>
        candidate === index ? { ...condition, [key]: value } : condition
      )
    )
  }
  const removeHandler = (index, handlerId) => {
    const condition = conditions[index]
    updateCondition(
      index,
      'handlerNodeIds',
      condition.handlerNodeIds.filter(id => id !== handlerId)
    )
  }
  const changeCollectionMode = mode => {
    onChange('eventWait', {
      ...eventWait,
      collectionMode: mode,
      subscriptionId: mode === 'webhook' ? (eventWait.subscriptionId ?? null) : null,
      pollIntervalSeconds: mode === 'poll' ? (eventWait.pollIntervalSeconds ?? 300) : null,
    })
  }
  const changeConditionSource = (index, sourceType) => {
    const supportedEvents = eventTypesBySource.get(sourceType) ?? []
    const current = conditions[index]
    const nextEventType = supportedEvents.includes(current.eventType)
      ? current.eventType
      : (supportedEvents[0] ?? '')
    onChange(
      'branchConditions',
      conditions.map((condition, candidate) =>
        candidate === index ? { ...condition, sourceType, eventType: nextEventType } : condition
      )
    )
  }
  return (
    <div className={automationClass('panel-settings')}>
      <label className={automationClass('panel-field')}>
        <span>
          <Webhook size={14} />
          分支名称
        </span>
        <input
          data-testid="branch-node-name"
          value={step.name}
          onChange={event => onChange('name', event.target.value)}
        />
      </label>
      <p className={automationClass('execution-hint')}>
        分支节点监听当前 Issue 上游交付的
        PR/MR；仓库、编号和平台会从交付物自动识别。命中条件后路由到对应处理节点。
      </p>
      <section className={automationClass('event-source-settings')}>
        <div className={automationClass('event-source-heading')}>
          <div>
            <strong>事件源</strong>
            <span>运行时从当前 Issue 的前序节点交付物中识别 PR/MR</span>
          </div>
          <small>
            {[...new Set(conditions.map(condition => condition.sourceType))]
              .map(sourceType => (sourceType === 'gitlab' ? 'GitLab' : 'GitHub'))
              .join(' / ')}
          </small>
        </div>
        {eventWait.collectionMode === 'poll' ? (
          <p className={automationClass('execution-hint')} data-testid="branch-event-sources-hint">
            分支条件可分别选择 GitHub/GitLab；运行时会为绑定的各平台 PR/MR 建立对应采集器。
          </p>
        ) : null}
        <label className={automationClass('panel-field')}>
          <span>
            <i className={automationClass('cascade-index')}>2</i>
            接收方式
          </span>
          <select
            data-testid="branch-event-wait-mode"
            value={eventWait.collectionMode}
            onChange={event => changeCollectionMode(event.target.value)}
          >
            <option value="poll">{t('todo.automation_trigger_poll_label')}</option>
            <option value="webhook">{t('todo.automation_trigger_webhook_label')}</option>
          </select>
        </label>
        {eventWait.collectionMode === 'webhook' ? (
          <EventSubscriptionPicker
            api={projectIncomingHookApi}
            projectId={projectId}
            catalog={eventSourceCatalog}
            sourceTypes={[...new Set(conditions.map(condition => condition.sourceType))]}
            collectionMode="webhook"
            cascadeIndex={3}
            testIdPrefix="branch"
            canManage={canManage}
            value={eventWait.subscriptionId ?? null}
            onChange={subscriptionId => onChange('eventWait', { ...eventWait, subscriptionId })}
          />
        ) : (
          <PollIntervalField
            testId="branch-event-wait-poll-interval"
            value={eventWait.pollIntervalSeconds}
            index={3}
            onChange={pollIntervalSeconds =>
              onChange('eventWait', { ...eventWait, pollIntervalSeconds })
            }
          />
        )}
        {eventWait.collectionMode === 'poll' ? (
          <p
            className={automationClass('execution-hint')}
            data-testid="branch-event-wait-poll-hint"
          >
            {t('todo.workflow_branch_collector_poll_hint')}
          </p>
        ) : (
          <p
            className={automationClass('execution-hint')}
            data-testid="branch-event-wait-webhook-hint"
          >
            {t('todo.workflow_branch_collector_webhook_hint')}
          </p>
        )}
      </section>
      <div className={automationClass('branch-conditions')}>
        <span className={automationClass('branch-conditions-heading')}>分支条件</span>
        {conditions.length === 0 ? (
          <div className={automationClass('branch-conditions-empty')}>
            还没有分支，可通过分支节点右侧的加号添加。
          </div>
        ) : (
          conditions.map((condition, index) => {
            const handlerNodes = (condition.handlerNodeIds ?? [])
              .map(handlerId => bodyNodes.find(candidate => candidate.id === handlerId))
              .filter(Boolean)
            const candidateNodes = bodyNodes.filter(
              candidate =>
                candidate.id !== step.id &&
                candidate.kind === 'task' &&
                (!candidate.nodeType || candidate.nodeType === 'task') &&
                !condition.handlerNodeIds.includes(candidate.id)
            )
            return (
              <div className={automationClass('branch-condition-card')} key={`condition-${index}`}>
                <div className={automationClass('branch-condition-head')}>
                  <em>分支 {index + 1}</em>
                  <button
                    type="button"
                    className={automationClass('branch-condition-remove')}
                    data-testid={`branch-condition-remove-${index}`}
                    aria-label={`移除分支 ${index + 1}`}
                    onClick={() =>
                      onChange(
                        'branchConditions',
                        conditions.filter((_, candidate) => candidate !== index)
                      )
                    }
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                <div className={automationClass('branch-condition-source')}>
                  <label className={automationClass('panel-field')}>
                    <span>事件平台</span>
                    <select
                      data-testid={`branch-condition-source-${index}`}
                      value={condition.sourceType}
                      onChange={event => changeConditionSource(index, event.target.value)}
                    >
                      {platformSources.map(source => (
                        <option key={source.sourceType} value={source.sourceType}>
                          {source.sourceType === 'gitlab' ? 'GitLab' : 'GitHub'}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={automationClass('panel-field')}>
                    <span>事件类型</span>
                    <select
                      data-testid={`branch-condition-event-${index}`}
                      value={condition.eventType}
                      onChange={event => updateCondition(index, 'eventType', event.target.value)}
                    >
                      <option value="">选择事件</option>
                      {(eventTypesBySource.get(condition.sourceType) ?? []).map(eventType => (
                        <option key={eventType} value={eventType}>
                          {eventTypeLabel(eventType, t)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className={automationClass('branch-condition-handlers')}>
                  <span>处理节点</span>
                  <div className={automationClass('branch-handler-chips')}>
                    {handlerNodes.length === 0 ? (
                      <small className={automationClass('branch-handler-empty')}>
                        尚未指定处理节点
                      </small>
                    ) : (
                      handlerNodes.map(handler => {
                        const { Icon } =
                          branchHandlerPresentation[handler.kind] ?? branchHandlerPresentation.task
                        return (
                          <span className={automationClass('branch-handler-chip')} key={handler.id}>
                            <Icon size={12} />
                            <em>{handler.name || '未命名节点'}</em>
                            <button
                              type="button"
                              aria-label={`移除处理节点 ${handler.name || '未命名节点'}`}
                              onClick={() => removeHandler(index, handler.id)}
                            >
                              <X size={12} />
                            </button>
                          </span>
                        )
                      })
                    )}
                  </div>
                  {candidateNodes.length > 0 ? (
                    <PopupMenu
                      testId={`branch-add-handler-${index}`}
                      trigger={
                        <span className={automationClass('branch-add-handler')}>
                          <Plus size={13} />
                          指定已有节点
                        </span>
                      }
                    >
                      {close => (
                        <>
                          {candidateNodes.map(candidate => (
                            <button
                              type="button"
                              key={candidate.id}
                              className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-text-secondary hover:bg-muted hover:text-text-primary"
                              data-testid={`branch-add-handler-${index}-${candidate.id}`}
                              onClick={() => {
                                updateCondition(index, 'handlerNodeIds', [
                                  ...condition.handlerNodeIds,
                                  candidate.id,
                                ])
                                close()
                              }}
                            >
                              <Box size={14} />
                              {candidate.name || '未命名节点'}
                            </button>
                          ))}
                        </>
                      )}
                    </PopupMenu>
                  ) : null}
                </div>
              </div>
            )
          })
        )}
      </div>
      <div className={automationClass('panel-danger-zone compact')}>
        <button
          type="button"
          className={automationClass('delete-step')}
          data-testid="branch-node-delete"
          onClick={onDelete}
        >
          <Trash2 size={14} />
          删除分支节点
        </button>
      </div>
    </div>
  )
}

export const DEPENDENCY_CONTEXT_OPTIONS = [
  ['final_result', '最终结果'],
  ['deliveries', '交付物'],
  ['activity', '执行动态'],
]

export function SubgraphDependencySummary({ node, parent, onChange }) {
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
