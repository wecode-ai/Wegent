import { useState } from 'react'
import { SelectContent, SelectItem, SelectRoot, SelectTrigger } from '../controls/SelectParts'
import { normalizeSelectValue } from '../controls/selectValue'
import { Button as ControlButton } from '../markdown/Button'
import { CollaborationTheme } from '../theme'
import '../theme-tokens.css'
import { ProjectAssistantStatusPanel } from './ProjectAssistantStatusPanel'
import { projectAssistantStatusChinese, projectAssistantStatusEnglish } from './copy'
import { projectAssistantStatusFixtures } from './fixtures'
import { formatReceiptTime } from './projection'
import type { ProjectAssistantStatus } from './types'

const scenarios = projectAssistantStatusFixtures.scenarios
export type HostingPreviewScenario =
  | keyof typeof scenarios
  | 'loading'
  | 'error'
  | 'refreshing'
  | 'refreshError'
  | 'manager'
  | 'managerLoading'
  | 'managerError'
  | 'managerRefreshing'
  | 'managerRefreshError'
  | 'featureOff'
interface PreviewArgs {
  scenario: HostingPreviewScenario
  surface?: 'project' | 'assistant' | 'both'
  theme?: 'light' | 'dark'
  width?: 390 | 900 | 1440
  locale?: 'en' | 'zh-CN'
}

const previewMessages = {
  en: {
    scenario: 'Review scenario',
    width: 'Content width',
    theme: 'Theme',
    surface: 'Entry',
    light: 'Light',
    dark: 'Dark',
    project: 'Project overview',
    assistant: 'Assistant home',
    both: 'Both entries',
    projectName: 'Example collaboration project',
    close: 'Close preview',
    feedback: 'Choose a state and inspect the hosting authorization and last receipt separately.',
    note: 'Synthetic design reference. Heartbeats, dispatch deduplication and permissions require production verification.',
    hidden: 'The status feature is off; stored settings and historical receipts are retained.',
    settings: 'Assistant settings preview',
    rules: 'Project rules preview',
    receipt: 'Acceptance receipt preview',
    retried: 'Synthetic sync completed. No execution was started.',
  },
  'zh-CN': {
    scenario: '评审场景',
    width: '内容宽度',
    theme: '主题',
    surface: '入口',
    light: '浅色',
    dark: '深色',
    project: '项目概览',
    assistant: '助理首页',
    both: '两个入口',
    projectName: '示例协作项目',
    close: '关闭预览',
    feedback: '选择状态，检查托管授权与最近回执分别展示。',
    note: '合成设计参考。心跳、派发幂等与权限待生产接入验收。',
    hidden: '托管状态功能已关闭；设备设置和历史回执保留。',
    settings: '助理设置预览',
    rules: '项目规则预览',
    receipt: '接单回执预览',
    retried: '合成同步已完成，未启动任何执行。',
  },
}

function Preview(args: PreviewArgs) {
  const [scenario, setScenario] = useState(args.scenario)
  const [theme, setTheme] = useState(args.theme ?? 'light')
  const [width, setWidth] = useState<number>(args.width ?? 900)
  const [surface, setSurface] = useState(args.surface ?? 'project')
  const [retryState, setRetryState] = useState<'idle' | 'loading' | 'succeeded'>('idle')
  const [destination, setDestination] = useState<'settings' | 'rules' | 'receipt' | null>(null)
  const [openedSnapshot, setOpenedSnapshot] = useState<ProjectAssistantStatus | null>(null)
  const locale = args.locale ?? 'en'
  const copy = locale === 'zh-CN' ? projectAssistantStatusChinese : projectAssistantStatusEnglish
  const messages = previewMessages[locale]
  const snapshot = scenarios[scenario as keyof typeof scenarios] ?? scenarios.hosting
  const manager = scenario.startsWith('manager')
  const initial = ['loading', 'error', 'managerLoading', 'managerError'].includes(scenario)
  const readSucceeded = retryState === 'succeeded'
  const projectScope = {
    projectStore: snapshot.projectStore,
    projectId: snapshot.projectId,
  }
  const panelStatus =
    initial && !readSucceeded
      ? null
      : manager
        ? { dispatchable: true, availability: 'online' }
        : snapshot
  const loading =
    retryState === 'loading' ||
    (!readSucceeded &&
      ['loading', 'refreshing', 'managerLoading', 'managerRefreshing'].includes(scenario))
  const error =
    !readSucceeded &&
    ['error', 'refreshError', 'managerError', 'managerRefreshError'].includes(scenario)
  const retry = () => {
    // A synthetic read refresh only; no heartbeat, assignment or execution is changed.
    setRetryState('loading')
    void Promise.resolve().then(() => setRetryState('succeeded'))
  }
  const open = (target: 'settings' | 'rules' | 'receipt', value: ProjectAssistantStatus) => {
    setOpenedSnapshot(value)
    setDestination(target)
  }
  const entries = surface === 'both' ? (['project', 'assistant'] as const) : [surface]
  return (
    <CollaborationTheme mode={theme}>
      <main
        className="project-assistant-review"
        style={{ width }}
        data-width={width}
        data-testid="hosting-review-canvas"
      >
        <div className="project-assistant-review__controls">
          <label>
            {messages.scenario}
            <SelectRoot
              value={normalizeSelectValue(scenario)}
              onValueChange={selectedValue => {
                if (selectedValue === null) return
                setScenario(selectedValue as HostingPreviewScenario)
                setDestination(null)
                setRetryState('idle')
              }}
            >
              <SelectTrigger data-testid="hosting-review-scenario" />
              <SelectContent>
                {[
                  ...Object.keys(scenarios),
                  'loading',
                  'error',
                  'refreshing',
                  'refreshError',
                  'manager',
                  'managerLoading',
                  'managerError',
                  'managerRefreshing',
                  'managerRefreshError',
                  'featureOff',
                ].map(value => (
                  <SelectItem key={value} value={String(value)}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectRoot>
          </label>
          <label>
            {messages.width}
            <SelectRoot
              value={normalizeSelectValue(width)}
              onValueChange={selectedValue => {
                if (selectedValue !== null) return setWidth(Number(selectedValue))
              }}
            >
              <SelectTrigger data-testid="hosting-review-width" />
              <SelectContent>
                {[390, 900, 1440].map(value => (
                  <SelectItem key={value} value={String(value)}>
                    {value}px
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectRoot>
          </label>
          <label>
            {messages.theme}
            <SelectRoot
              value={normalizeSelectValue(theme)}
              onValueChange={selectedValue => {
                if (selectedValue !== null) return setTheme(selectedValue as 'light' | 'dark')
              }}
            >
              <SelectTrigger data-testid="hosting-review-theme" />
              <SelectContent>
                <SelectItem value="light">{messages.light}</SelectItem>
                <SelectItem value="dark">{messages.dark}</SelectItem>
              </SelectContent>
            </SelectRoot>
          </label>
          <label>
            {messages.surface}
            <SelectRoot
              value={normalizeSelectValue(surface)}
              onValueChange={selectedValue => {
                if (selectedValue !== null) return setSurface(selectedValue as typeof surface)
              }}
            >
              <SelectTrigger data-testid="hosting-review-surface" />
              <SelectContent>
                {(['project', 'assistant', 'both'] as const).map(value => (
                  <SelectItem key={value} value={String(value)}>
                    {messages[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectRoot>
          </label>
        </div>
        {entries.map(entry => (
          <section
            key={entry}
            data-testid={`hosting-preview-${entry}`}
            aria-label={messages[entry]}
          >
            <h1>{messages[entry]}</h1>
            <ProjectAssistantStatusPanel
              projectScope={projectScope}
              statusScope={projectScope}
              status={panelStatus}
              projectName={messages.projectName}
              copy={copy}
              locale={locale}
              loading={loading}
              error={error}
              featureEnabled={scenario !== 'featureOff'}
              audience={manager ? 'manager' : 'self'}
              onRetry={retry}
              onOpenSettings={value => open('settings', value)}
              onOpenRules={value => open('rules', value)}
              onOpenReceipt={value => open('receipt', value)}
            />
          </section>
        ))}
        <p role="status" data-testid="hosting-review-feedback">
          {scenario === 'featureOff'
            ? messages.hidden
            : destination
              ? messages[destination]
              : readSucceeded
                ? messages.retried
                : messages.feedback}
        </p>
        {destination && openedSnapshot && (
          <aside
            className="project-assistant-review__destination"
            data-testid={`hosting-demo-${destination}`}
            aria-label={messages[destination]}
          >
            <h2>{messages[destination]}</h2>
            {destination === 'settings' && (
              <p>
                {copy.scope}: {openedSnapshot.projectStore} / {openedSnapshot.projectId} ·{' '}
                {copy.availabilityValues[openedSnapshot.availability]}
              </p>
            )}
            {destination === 'rules' && (
              <p>
                {copy.coveredTags}:{' '}
                {openedSnapshot.scope.kind === 'project'
                  ? copy.allTags
                  : openedSnapshot.scope.tagIds.join(', ')}{' '}
                · {copy.currentTags}: {openedSnapshot.currentTags.join(', ')}
              </p>
            )}
            {destination === 'receipt' && (
              <p>
                {openedSnapshot.receipt?.humanAssignmentId} ·{' '}
                {openedSnapshot.receipt?.runtimeTaskRef.taskId} ·{' '}
                {openedSnapshot.receipt?.deliveryRef ?? copy.incompleteEvidence} ·{' '}
                {formatReceiptTime(openedSnapshot.lastReceiptAt, copy.noReceiptTime, locale)}
              </p>
            )}
            <ControlButton
              variant="ghost"
              size="sm"
              type="button"
              data-testid="hosting-demo-close"
              onClick={() => setDestination(null)}
            >
              {messages.close}
            </ControlButton>
          </aside>
        )}
        <p>{messages.note}</p>
      </main>
    </CollaborationTheme>
  )
}

function render(args: PreviewArgs) {
  return (
    <Preview
      key={`${args.scenario}:${args.theme}:${args.width}:${args.locale}:${args.surface}`}
      {...args}
    />
  )
}

export default {
  title: 'Design/Project Assistant Status',
  component: ProjectAssistantStatusPanel,
  render,
  parameters: { layout: 'fullscreen' },
  argTypes: { theme: { control: 'inline-radio', options: ['light', 'dark'] } },
}

export const Project = { args: { scenario: 'hosting', surface: 'project' } }
export const Assistant = {
  args: { scenario: 'waitingDevice', surface: 'assistant' },
}
export const NotEnabled = { args: { scenario: 'notEnabled' } }
export const TagMismatch = { args: { scenario: 'tagMismatch' } }
export const WaitingDevice = { args: { scenario: 'waitingDevice' } }
export const PermissionRevoked = { args: { scenario: 'permissionRevoked' } }
export const Failed = { args: { scenario: 'failed' } }
export const Queued = { args: { scenario: 'queued' } }
export const BlockedPolicy = { args: { scenario: 'blockedPolicy' } }
export const Running = { args: { scenario: 'running' } }
export const Completed = { args: { scenario: 'completed' } }
export const IncompleteEvidence = { args: { scenario: 'incompleteEvidence' } }
export const PausedRunning = { args: { scenario: 'pausedRunning' } }
export const Paused = { args: { scenario: 'paused' } }
export const NoReceipt = { args: { scenario: 'noReceipt' } }
export const Unknown = { args: { scenario: 'unknown' } }
export const Loading = { args: { scenario: 'loading' } }
export const Error = { args: { scenario: 'error' } }
export const Refreshing = { args: { scenario: 'refreshing' } }
export const RefreshError = { args: { scenario: 'refreshError' } }
export const Manager = { args: { scenario: 'manager' } }
export const ManagerLoading = { args: { scenario: 'managerLoading' } }
export const ManagerError = { args: { scenario: 'managerError' } }
export const ManagerRefreshing = { args: { scenario: 'managerRefreshing' } }
export const ManagerRefreshError = { args: { scenario: 'managerRefreshError' } }
export const FeatureOff = { args: { scenario: 'featureOff' } }
export const Mobile = { args: { scenario: 'waitingDevice', width: 390 } }
export const Dark = { args: { scenario: 'waitingDevice', theme: 'dark' } }
export const Matrix = { args: { scenario: 'waitingDevice', surface: 'both' } }
export const Review = { args: { scenario: 'waitingDevice', locale: 'zh-CN' } }
