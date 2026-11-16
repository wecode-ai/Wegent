import { useState } from 'react'
import { CollaborationTheme } from '../theme'
import '../theme-tokens.css'
import { ProjectAssistantStatusPanel } from './ProjectAssistantStatusPanel'
import {
  projectAssistantStatusChinese,
  projectAssistantStatusEnglish,
} from './copy'
import { projectAssistantStatusFixtures } from './fixtures'
import { formatReceiptTime } from './projection'
import type { ProjectAssistantStatus } from './types'

const scenarios = projectAssistantStatusFixtures.scenarios
export type HostingPreviewScenario =
  | keyof typeof scenarios
  | 'loading'
  | 'error'
  | 'manager'
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
    feedback:
      'Choose a state and inspect the hosting authorization and last receipt separately.',
    note: 'Synthetic design reference. Heartbeats, dispatch deduplication and permissions require production verification.',
    hidden:
      'The status feature is off; stored settings and historical receipts are retained.',
    settings: 'Assistant settings preview',
    rules: 'Project rules preview',
    receipt: 'Acceptance receipt preview',
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
  },
}

function Preview(args: PreviewArgs) {
  const [scenario, setScenario] = useState(args.scenario)
  const [theme, setTheme] = useState(args.theme ?? 'light')
  const [width, setWidth] = useState<number>(args.width ?? 900)
  const [surface, setSurface] = useState(args.surface ?? 'project')
  const [destination, setDestination] = useState<
    'settings' | 'rules' | 'receipt' | null
  >(null)
  const [openedSnapshot, setOpenedSnapshot] =
    useState<ProjectAssistantStatus | null>(null)
  const locale = args.locale ?? 'en'
  const copy =
    locale === 'zh-CN'
      ? projectAssistantStatusChinese
      : projectAssistantStatusEnglish
  const messages = previewMessages[locale]
  const snapshot =
    scenarios[scenario as keyof typeof scenarios] ?? scenarios.hosting
  const panelStatus =
    scenario === 'manager'
      ? { dispatchable: true, availability: 'online' }
      : snapshot
  const open = (
    target: 'settings' | 'rules' | 'receipt',
    value: ProjectAssistantStatus,
  ) => {
    setOpenedSnapshot(value)
    setDestination(target)
  }
  const entries =
    surface === 'both' ? (['project', 'assistant'] as const) : [surface]
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
            <select
              data-testid="hosting-review-scenario"
              value={scenario}
              onChange={(event) => {
                setScenario(event.target.value as HostingPreviewScenario)
                setDestination(null)
              }}
            >
              {[
                ...Object.keys(scenarios),
                'loading',
                'error',
                'manager',
                'featureOff',
              ].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            {messages.width}
            <select
              data-testid="hosting-review-width"
              value={width}
              onChange={(event) => setWidth(Number(event.target.value))}
            >
              {[390, 900, 1440].map((value) => (
                <option key={value} value={value}>
                  {value}px
                </option>
              ))}
            </select>
          </label>
          <label>
            {messages.theme}
            <select
              data-testid="hosting-review-theme"
              value={theme}
              onChange={(event) =>
                setTheme(event.target.value as 'light' | 'dark')
              }
            >
              <option value="light">{messages.light}</option>
              <option value="dark">{messages.dark}</option>
            </select>
          </label>
          <label>
            {messages.surface}
            <select
              data-testid="hosting-review-surface"
              value={surface}
              onChange={(event) =>
                setSurface(event.target.value as typeof surface)
              }
            >
              {(['project', 'assistant', 'both'] as const).map((value) => (
                <option key={value} value={value}>
                  {messages[value]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {entries.map((entry) => (
          <section
            key={entry}
            data-testid={`hosting-preview-${entry}`}
            aria-label={messages[entry]}
          >
            <h1>{messages[entry]}</h1>
            <ProjectAssistantStatusPanel
              status={panelStatus}
              projectName={messages.projectName}
              copy={copy}
              locale={locale}
              loading={scenario === 'loading'}
              error={scenario === 'error'}
              featureEnabled={scenario !== 'featureOff'}
              audience={scenario === 'manager' ? 'manager' : 'self'}
              onOpenSettings={(value) => open('settings', value)}
              onOpenRules={(value) => open('rules', value)}
              onOpenReceipt={(value) => open('receipt', value)}
            />
          </section>
        ))}
        <p role="status" data-testid="hosting-review-feedback">
          {scenario === 'featureOff'
            ? messages.hidden
            : destination
              ? messages[destination]
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
                {copy.scope}: {openedSnapshot.projectStore} /{' '}
                {openedSnapshot.projectId} ·{' '}
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
                {openedSnapshot.receipt?.deliveryRef ?? copy.incompleteEvidence}{' '}
                ·{' '}
                {formatReceiptTime(
                  openedSnapshot.lastReceiptAt,
                  copy.noReceiptTime,
                  locale,
                )}
              </p>
            )}
            <button
              type="button"
              data-testid="hosting-demo-close"
              onClick={() => setDestination(null)}
            >
              {messages.close}
            </button>
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
export const Manager = { args: { scenario: 'manager' } }
export const FeatureOff = { args: { scenario: 'featureOff' } }
export const Mobile = { args: { scenario: 'waitingDevice', width: 390 } }
export const Dark = { args: { scenario: 'waitingDevice', theme: 'dark' } }
export const Matrix = { args: { scenario: 'waitingDevice', surface: 'both' } }
export const Review = { args: { scenario: 'waitingDevice', locale: 'zh-CN' } }
