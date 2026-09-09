import { Check, Clock3, Webhook, Zap } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { automationClass } from './automationStyles'
import { weekdayLabels, triggerPresentation } from './AutomationRuleModel.jsx'

export function TriggerSettings({ draft, projectTags, onChange, onRuleChange }) {
  const { t } = useTranslation()
  const trigger = draft.trigger
  const presentation = triggerPresentation(trigger, t)
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
          <option value="workflow">{t('workbench.board_automation_dispatch_trigger')}</option>
        </select>
      </label>
      {trigger.type === 'workflow' ? (
        <p>{t('workbench.board_automation_dispatch_description')}</p>
      ) : trigger.type === 'schedule' ? (
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
              <option value="hourly">{t('workbench.board_automation_hourly')}</option>
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
              {trigger.schedule.frequency === 'hourly'
                ? t('workbench.board_automation_minute')
                : '执行时间'}
            </span>
            {trigger.schedule.frequency === 'hourly' ? (
              <select
                data-testid="automation-trigger-minute"
                value={Number(trigger.schedule.time.split(':')[1])}
                onChange={event =>
                  updateSchedule('time', `00:${event.target.value.padStart(2, '0')}`)
                }
              >
                {Array.from({ length: 60 }, (_, minute) => (
                  <option key={minute} value={minute}>
                    {String(minute).padStart(2, '0')}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="time"
                data-testid="automation-trigger-time"
                value={trigger.schedule.time}
                onChange={event => updateSchedule('time', event.target.value)}
              />
            )}
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
