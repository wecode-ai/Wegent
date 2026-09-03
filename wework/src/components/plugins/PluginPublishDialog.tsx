import {
  Building2,
  Check,
  ChevronLeft,
  ChevronRight,
  Globe2,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type SetStateAction,
} from 'react'
import type { PluginShareGroupSearchItem, PluginShareUserSearchItem } from '@/api/plugins'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { PluginAccessResponse, PluginAccessTarget } from '@/types/api'
import { PluginShareTargetSearch } from './PluginShareTargetSearch'

export interface PluginPublicationRiskDeclaration {
  externalNetworkAccess: boolean
  externalDomains: string[]
  executesCommands: boolean
  commandExamples: string[]
  readsOrWritesLocalFiles: boolean
  usesCredentials: boolean
  applicationPermissions: string[]
  additionalNotes: string
}

export type PluginPublishRequest =
  | {
      intent: 'restricted'
      visibility: 'personal'
      targets: PluginAccessTarget[]
      allowCopy: boolean
    }
  | {
      intent: 'enterprise'
      visibility: 'workspace'
      targets: []
      allowCopy: false
      operationAttemptId: string
      releaseNotes: string
      testNotes: string
      riskDeclaration: PluginPublicationRiskDeclaration
    }

export interface ActivePluginPublicationSummary {
  id: number
  version: string
  status: string
  canCreateRevision: boolean
}

interface PluginPublishDialogProps {
  pluginName: string
  pluginVersion?: string
  publishing: boolean
  error?: string | null
  initialAccess?: PluginAccessResponse | null
  activePublication?: ActivePluginPublicationSummary | null
  shareRecoveryLabel?: string | null
  onShareRecovery?: () => void
  onViewPublication?: (requestId: number) => void
  onClose: () => void
  onPublish: (request: PluginPublishRequest) => void
  searchUsers: (query: string) => Promise<PluginShareUserSearchItem[]>
  searchGroups: (query: string) => Promise<PluginShareGroupSearchItem[]>
}

type Screen = 'intent' | 'restricted' | 'enterprise'
type EnterpriseStep = 1 | 2 | 3

const EMPTY_RISK_DECLARATION: PluginPublicationRiskDeclaration = {
  externalNetworkAccess: false,
  externalDomains: [],
  executesCommands: false,
  commandExamples: [],
  readsOrWritesLocalFiles: false,
  usesCredentials: false,
  applicationPermissions: [],
  additionalNotes: '',
}

function createOperationAttemptId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `attempt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )
}

const RISK_ROWS = [
  {
    key: 'executesCommands',
    label: '执行系统命令或脚本',
    hint: '包括 Shell、Node、Python、Hook 和 bin',
  },
  {
    key: 'readsOrWritesLocalFiles',
    label: '读取或写入本地文件',
    hint: '包括配置、文档、日志或生成文件',
  },
  {
    key: 'usesCredentials',
    label: '使用凭据',
    hint: '例如 API Key、Token 或账号密码',
  },
] as const

function normalizeDomains(value: string): string[] {
  return value
    .split(/[\s,，;；]+/)
    .map(domain => domain.trim().toLowerCase())
    .filter(Boolean)
}

function normalizeList(value: string): string[] {
  return value
    .split(/[\n,，;；]+/)
    .map(item => item.trim())
    .filter(Boolean)
}

interface PluginPublicationRiskStepProps {
  riskDeclaration: PluginPublicationRiskDeclaration
  setRiskDeclaration: Dispatch<SetStateAction<PluginPublicationRiskDeclaration>>
  applicationAuthorization: boolean
  setApplicationAuthorization: Dispatch<SetStateAction<boolean>>
  domainsText: string
  setDomainsText: Dispatch<SetStateAction<string>>
  commandExamplesText: string
  setCommandExamplesText: Dispatch<SetStateAction<string>>
  applicationPermissionsText: string
  setApplicationPermissionsText: Dispatch<SetStateAction<string>>
  testNotes: string
  setTestNotes: Dispatch<SetStateAction<string>>
}

function PluginPublicationRiskStep({
  riskDeclaration,
  setRiskDeclaration,
  applicationAuthorization,
  setApplicationAuthorization,
  domainsText,
  setDomainsText,
  commandExamplesText,
  setCommandExamplesText,
  applicationPermissionsText,
  setApplicationPermissionsText,
  testNotes,
  setTestNotes,
}: PluginPublicationRiskStepProps) {
  const { t } = useTranslation('common')
  const testNotesAreBlank = testNotes.length > 0 && !testNotes.trim()

  return (
    <div data-testid="plugin-publication-step-risk" className="space-y-5">
      <p className="text-sm leading-5 text-text-secondary">
        {t(
          'workbench.plugins_publication_risk_intro',
          '请如实声明插件行为。系统会把声明与 Manifest 和包扫描结果交叉校验。'
        )}
      </p>
      <div className="overflow-hidden rounded-xl border border-border/30">
        <label className="flex items-start justify-between gap-4 border-b border-border/25 px-4 py-4">
          <span>
            <span className="block text-sm font-medium text-text-primary">
              {t('workbench.plugins_publication_risk_network', '访问外部网络')}
            </span>
            <span className="mt-1 block text-xs text-text-muted">
              {t('workbench.plugins_publication_risk_network_hint', '访问企业外部服务或域名')}
            </span>
          </span>
          <input
            type="checkbox"
            checked={riskDeclaration.externalNetworkAccess}
            data-testid="plugin-publication-risk-network"
            className="mt-1 h-4 w-4 accent-neutral-900"
            onChange={event =>
              setRiskDeclaration(current => ({
                ...current,
                externalNetworkAccess: event.target.checked,
              }))
            }
          />
        </label>
        {riskDeclaration.externalNetworkAccess ? (
          <label className="block border-b border-border/25 bg-surface/50 px-4 py-3">
            <span className="text-xs font-medium text-text-secondary">
              {t('workbench.plugins_publication_external_domains', '外部域名')}
            </span>
            <input
              value={domainsText}
              data-testid="plugin-publication-external-domains"
              className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-focus/70 focus:ring-2 focus:ring-focus/15"
              placeholder="api.example.com"
              onChange={event => setDomainsText(event.target.value)}
            />
          </label>
        ) : null}
        {RISK_ROWS.map(row => {
          const testId =
            row.key === 'executesCommands'
              ? 'plugin-publication-risk-command'
              : row.key === 'readsOrWritesLocalFiles'
                ? 'plugin-publication-risk-files'
                : 'plugin-publication-risk-credentials'
          return (
            <div key={row.key} className="border-b border-border/25">
              <label className="flex items-start justify-between gap-4 px-4 py-4">
                <span>
                  <span className="block text-sm font-medium text-text-primary">
                    {t('workbench.plugins_publication_risk_' + row.key, row.label)}
                  </span>
                  <span className="mt-1 block text-xs text-text-muted">
                    {t('workbench.plugins_publication_risk_' + row.key + '_hint', row.hint)}
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={riskDeclaration[row.key]}
                  data-testid={testId}
                  className="mt-1 h-4 w-4 accent-neutral-900"
                  onChange={event =>
                    setRiskDeclaration(current => ({
                      ...current,
                      [row.key]: event.target.checked,
                    }))
                  }
                />
              </label>
              {row.key === 'executesCommands' && riskDeclaration.executesCommands ? (
                <label className="block bg-surface/50 px-4 pb-3">
                  <span className="text-xs font-medium text-text-secondary">
                    {t('workbench.plugins_publication_command_examples', '命令或脚本示例')}
                  </span>
                  <textarea
                    value={commandExamplesText}
                    rows={3}
                    data-testid="plugin-publication-command-examples"
                    className="mt-2 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-focus/70 focus:ring-2 focus:ring-focus/15"
                    placeholder="node scripts/check.js"
                    onChange={event => setCommandExamplesText(event.target.value)}
                  />
                </label>
              ) : null}
            </div>
          )
        })}
        <div>
          <label className="flex items-start justify-between gap-4 px-4 py-4">
            <span>
              <span className="block text-sm font-medium text-text-primary">
                {t('workbench.plugins_publication_risk_application', '需要应用授权')}
              </span>
              <span className="mt-1 block text-xs text-text-muted">
                {t(
                  'workbench.plugins_publication_risk_application_hint',
                  '例如 OAuth、连接器或本地二维码授权'
                )}
              </span>
            </span>
            <input
              type="checkbox"
              checked={applicationAuthorization}
              data-testid="plugin-publication-risk-application"
              className="mt-1 h-4 w-4 accent-neutral-900"
              onChange={event => setApplicationAuthorization(event.target.checked)}
            />
          </label>
          {applicationAuthorization ? (
            <label className="block bg-surface/50 px-4 pb-3">
              <span className="text-xs font-medium text-text-secondary">
                {t('workbench.plugins_publication_application_permissions', '应用与权限列表')}
              </span>
              <textarea
                value={applicationPermissionsText}
                rows={3}
                data-testid="plugin-publication-application-permissions"
                className="mt-2 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-focus/70 focus:ring-2 focus:ring-focus/15"
                placeholder="GitLab OAuth: read_api"
                onChange={event => setApplicationPermissionsText(event.target.value)}
              />
            </label>
          ) : null}
        </div>
      </div>
      <label className="block space-y-2">
        <span className="text-sm font-medium text-text-primary">
          {t('workbench.plugins_publication_test_notes', '测试说明')}
        </span>
        <textarea
          value={testNotes}
          data-testid="plugin-publication-test-notes"
          rows={5}
          required
          maxLength={1000}
          aria-invalid={testNotesAreBlank}
          aria-describedby="plugin-publication-test-notes-help"
          className={cn(
            'w-full resize-none rounded-xl border bg-background px-3 py-2 text-sm outline-none focus:ring-2',
            testNotesAreBlank
              ? 'border-red-500/50 focus:border-red-500/70 focus:ring-red-500/15'
              : 'border-border focus:border-focus/70 focus:ring-focus/15'
          )}
          placeholder={t(
            'workbench.plugins_publication_test_notes_placeholder',
            '说明已验证的平台、场景和结果'
          )}
          onChange={event => setTestNotes(event.target.value)}
        />
        <span
          id="plugin-publication-test-notes-help"
          data-testid="plugin-publication-test-notes-help"
          className={cn('block text-xs', testNotesAreBlank ? 'text-red-600' : 'text-text-muted')}
        >
          {testNotesAreBlank
            ? t('workbench.plugins_publication_test_notes_required', '测试说明不能为空')
            : t(
                'workbench.plugins_publication_test_notes_hint',
                '必填，请说明已验证的平台、场景和结果'
              )}
        </span>
      </label>
      <label className="block space-y-2">
        <span className="text-sm font-medium text-text-primary">
          {t('workbench.plugins_publication_additional_notes', '补充说明')}
        </span>
        <textarea
          value={riskDeclaration.additionalNotes}
          data-testid="plugin-publication-additional-notes"
          rows={3}
          maxLength={2000}
          className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-focus/70 focus:ring-2 focus:ring-focus/15"
          onChange={event =>
            setRiskDeclaration(current => ({
              ...current,
              additionalNotes: event.target.value,
            }))
          }
        />
      </label>
    </div>
  )
}

export function PluginPublishDialog({
  pluginName,
  pluginVersion = '0.1.0',
  publishing,
  error,
  initialAccess,
  activePublication,
  shareRecoveryLabel,
  onShareRecovery,
  onViewPublication,
  onClose,
  onPublish,
  searchUsers,
  searchGroups,
}: PluginPublishDialogProps) {
  const { t } = useTranslation('common')
  const [screen, setScreen] = useState<Screen>('intent')
  const [intent, setIntent] = useState<'restricted' | 'enterprise'>('restricted')
  const [enterpriseStep, setEnterpriseStep] = useState<EnterpriseStep>(1)
  const [targets, setTargets] = useState<PluginAccessTarget[]>(initialAccess?.targets ?? [])
  const [allowCopy, setAllowCopy] = useState(initialAccess?.allowCopy ?? false)
  const [releaseNotes, setReleaseNotes] = useState('')
  const [riskDeclaration, setRiskDeclaration] =
    useState<PluginPublicationRiskDeclaration>(EMPTY_RISK_DECLARATION)
  const [domainsText, setDomainsText] = useState('')
  const [commandExamplesText, setCommandExamplesText] = useState('')
  const [applicationAuthorization, setApplicationAuthorization] = useState(false)
  const [applicationPermissionsText, setApplicationPermissionsText] = useState('')
  const [testNotes, setTestNotes] = useState('')
  const [declarationAccepted, setDeclarationAccepted] = useState(false)
  // The id stays stable while this dialog remains open so a transport retry
  // replays the same logical submit. Reopening the dialog starts a new request.
  const publicationAttemptIdRef = useRef(createOperationAttemptId())
  const restrictedIntentRef = useRef<HTMLButtonElement>(null)
  const enterpriseIntentRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || publishing) return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose, publishing])

  const normalizedDomains = useMemo(() => normalizeDomains(domainsText), [domainsText])
  const normalizedCommandExamples = useMemo(
    () => normalizeList(commandExamplesText),
    [commandExamplesText]
  )
  const normalizedApplicationPermissions = useMemo(
    () => normalizeList(applicationPermissionsText),
    [applicationPermissionsText]
  )
  const riskStepInvalid =
    !testNotes.trim() ||
    (riskDeclaration.externalNetworkAccess && normalizedDomains.length === 0) ||
    (riskDeclaration.executesCommands && normalizedCommandExamples.length === 0) ||
    (applicationAuthorization && normalizedApplicationPermissions.length === 0)
  const addTarget = (target: PluginAccessTarget) => {
    setTargets(current =>
      current.some(
        item => item.entityType === target.entityType && item.entityId === target.entityId
      )
        ? current
        : [...current, target]
    )
  }

  const handleIntentKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(event.key)) return
    event.preventDefault()
    const enabledIntents = [
      { value: 'restricted' as const, ref: restrictedIntentRef },
      { value: 'enterprise' as const, ref: enterpriseIntentRef },
    ]
    const currentIndex = Math.max(
      0,
      enabledIntents.findIndex(item => item.value === intent)
    )
    const offset = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1
    const next =
      enabledIntents[(currentIndex + offset + enabledIntents.length) % enabledIntents.length]
    setIntent(next.value)
    next.ref.current?.focus()
  }

  const continueFromIntent = () => {
    if (
      intent === 'enterprise' &&
      publicationRequiresProgress &&
      activePublication &&
      onViewPublication
    ) {
      onViewPublication(activePublication.id)
      return
    }
    setScreen(intent)
  }

  const normalizedPluginVersion = pluginVersion.trim().replace(/^v/i, '')
  const normalizedPublicationVersion = activePublication?.version.trim().replace(/^v/i, '')
  const publicationRequiresProgress = Boolean(
    activePublication &&
    !activePublication.canCreateRevision &&
    !['withdrawn', 'closed'].includes(activePublication.status) &&
    !(
      activePublication.status === 'published' &&
      normalizedPublicationVersion !== normalizedPluginVersion
    )
  )
  const activePublicationStatusLabel = activePublication
    ? t(
        'workbench.plugins_publication_status_' + activePublication.status,
        activePublication.status
      )
    : ''

  const errorContent = error ? (
    <div role="alert" className="space-y-2 rounded-xl bg-red-500/5 px-3 py-2 text-sm text-red-600">
      <p>{error}</p>
      {shareRecoveryLabel && onShareRecovery ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          data-testid="plugin-publish-share-recovery"
          onClick={onShareRecovery}
        >
          {shareRecoveryLabel}
        </Button>
      ) : null}
    </div>
  ) : null

  if (screen === 'enterprise') {
    const stepLabels = [
      t('workbench.plugins_publication_step_version', '确认版本'),
      t('workbench.plugins_publication_step_risk', '权限与风险'),
      t('workbench.plugins_publication_step_confirm', '确认提交'),
    ]
    return (
      <div
        data-testid="plugin-publication-overlay"
        className="plugin-dialog-overlay fixed inset-0 z-modal flex justify-end"
        onClick={event => {
          if (!publishing && event.target === event.currentTarget) onClose()
        }}
      >
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="plugin-publication-title"
          data-testid="plugin-publication-drawer"
          className="flex h-full w-full max-w-[480px] flex-col border-l border-border/30 bg-background shadow-xl"
        >
          <header className="border-b border-border/25 px-5 pb-4 pt-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="plugin-publication-title" className="heading-small text-text-primary">
                  {t('workbench.plugins_publication_title', '申请企业全员发布')}
                </h2>
                <p className="mt-1 text-sm text-text-secondary">
                  {pluginName} · v{pluginVersion}
                </p>
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                data-testid="plugin-publication-close"
                aria-label={t('common.close', '关闭')}
                disabled={publishing}
                onClick={onClose}
              >
                <X />
              </Button>
            </div>
            <ol
              className="mt-5 grid grid-cols-3 gap-2"
              aria-label={t('workbench.plugins_publication_steps', '发布申请步骤')}
            >
              {stepLabels.map((label, index) => {
                const step = (index + 1) as EnterpriseStep
                const current = enterpriseStep === step
                const completed = enterpriseStep > step
                return (
                  <li key={label} className="min-w-0">
                    <div
                      className={cn(
                        'h-1 rounded-full',
                        current || completed ? 'bg-blue-500' : 'bg-border/60'
                      )}
                    />
                    <p
                      className={cn(
                        'mt-2 truncate text-xs',
                        current ? 'font-medium text-text-primary' : 'text-text-muted'
                      )}
                      aria-current={current ? 'step' : undefined}
                    >
                      {completed ? <Check className="mr-1 inline h-3.5 w-3.5" /> : null}
                      {label}
                    </p>
                  </li>
                )
              })}
            </ol>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 [contain:layout_paint]">
            {enterpriseStep === 1 ? (
              <div data-testid="plugin-publication-step-version" className="space-y-5">
                <div className="rounded-2xl bg-surface px-4 py-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-muted text-text-secondary">
                      <Building2 className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-text-primary">{pluginName}</p>
                      <p className="mt-0.5 text-xs text-text-muted">
                        {t('workbench.plugins_personal_created', '个人创建')} · v{pluginVersion}
                      </p>
                    </div>
                  </div>
                </div>
                <label className="block space-y-2">
                  <span className="text-sm font-medium text-text-primary">
                    {t('workbench.plugins_publication_release_notes', '版本说明')}
                  </span>
                  <textarea
                    value={releaseNotes}
                    data-testid="plugin-publication-release-notes"
                    rows={6}
                    maxLength={2000}
                    className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-focus/70 focus:ring-2 focus:ring-focus/15"
                    placeholder={t(
                      'workbench.plugins_publication_release_notes_placeholder',
                      '说明本版本解决的问题、主要能力和测试结果'
                    )}
                    onChange={event => setReleaseNotes(event.target.value)}
                  />
                </label>
                <div className="flex gap-3 rounded-xl bg-blue-500/5 px-3 py-3 text-sm text-text-secondary">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
                  <p>
                    {t(
                      'workbench.plugins_publication_snapshot_hint',
                      '提交后将生成独立快照，后续编辑个人插件不会更新本次申请。'
                    )}
                  </p>
                </div>
              </div>
            ) : null}

            {enterpriseStep === 2 ? (
              <PluginPublicationRiskStep
                riskDeclaration={riskDeclaration}
                setRiskDeclaration={setRiskDeclaration}
                applicationAuthorization={applicationAuthorization}
                setApplicationAuthorization={setApplicationAuthorization}
                domainsText={domainsText}
                setDomainsText={setDomainsText}
                commandExamplesText={commandExamplesText}
                setCommandExamplesText={setCommandExamplesText}
                applicationPermissionsText={applicationPermissionsText}
                setApplicationPermissionsText={setApplicationPermissionsText}
                testNotes={testNotes}
                setTestNotes={setTestNotes}
              />
            ) : null}
            {enterpriseStep === 3 ? (
              <div data-testid="plugin-publication-step-confirm" className="space-y-5">
                <dl className="overflow-hidden rounded-xl border border-border/30 text-sm">
                  {[
                    [t('workbench.plugins_publication_confirm_plugin', '插件'), pluginName],
                    [
                      t('workbench.plugins_publication_confirm_version', '版本'),
                      'v' + pluginVersion,
                    ],
                    [
                      t('workbench.plugins_publication_confirm_scope', '发布范围'),
                      t('workbench.plugins_publication_enterprise_everyone', '企业全员'),
                    ],
                    [
                      t('workbench.plugins_publication_confirm_network', '外部网络'),
                      riskDeclaration.externalNetworkAccess
                        ? normalizedDomains.join(', ')
                        : t('common.no', '否'),
                    ],
                    [
                      t('workbench.plugins_publication_confirm_commands', '命令与脚本'),
                      riskDeclaration.executesCommands
                        ? normalizedCommandExamples.join(', ')
                        : t('common.no', '否'),
                    ],
                    [
                      t('workbench.plugins_publication_confirm_files', '本地文件'),
                      riskDeclaration.readsOrWritesLocalFiles
                        ? t('common.yes', '是')
                        : t('common.no', '否'),
                    ],
                    [
                      t('workbench.plugins_publication_confirm_credentials', '凭据使用'),
                      riskDeclaration.usesCredentials
                        ? t('common.yes', '是')
                        : t('common.no', '否'),
                    ],
                    [
                      t('workbench.plugins_publication_confirm_application', '应用授权'),
                      applicationAuthorization
                        ? normalizedApplicationPermissions.join(', ')
                        : t('common.no', '否'),
                    ],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 border-b border-border/25 px-4 py-3 last:border-b-0"
                    >
                      <dt className="text-text-muted">{label}</dt>
                      <dd className="break-words text-text-primary">{value}</dd>
                    </div>
                  ))}
                </dl>
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-text-primary">
                    {t('workbench.plugins_publication_release_notes', '版本说明')}
                  </h3>
                  <p className="whitespace-pre-wrap rounded-xl bg-surface px-3 py-3 text-sm leading-5 text-text-secondary">
                    {releaseNotes}
                  </p>
                </div>
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-text-primary">
                    {t('workbench.plugins_publication_test_notes', '测试说明')}
                  </h3>
                  <p className="whitespace-pre-wrap rounded-xl bg-surface px-3 py-3 text-sm leading-5 text-text-secondary">
                    {testNotes.trim()}
                  </p>
                </div>
                {riskDeclaration.additionalNotes.trim() ? (
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium text-text-primary">
                      {t('workbench.plugins_publication_additional_notes', '补充说明')}
                    </h3>
                    <p className="whitespace-pre-wrap rounded-xl bg-surface px-3 py-3 text-sm leading-5 text-text-secondary">
                      {riskDeclaration.additionalNotes.trim()}
                    </p>
                  </div>
                ) : null}
                <label className="flex items-start gap-3 rounded-xl border border-border/30 px-4 py-4">
                  <input
                    type="checkbox"
                    checked={declarationAccepted}
                    data-testid="plugin-publication-declaration"
                    className="mt-1 h-4 w-4 accent-neutral-900"
                    onChange={event => setDeclarationAccepted(event.target.checked)}
                  />
                  <span className="text-sm leading-5 text-text-secondary">
                    {t(
                      'workbench.plugins_publication_declaration',
                      '我确认声明与插件行为一致，并理解提交后该版本快照不可修改；管理员接受后仍需 GitLab 代码评审与跨平台检查。'
                    )}
                  </span>
                </label>
              </div>
            ) : null}
            <div className="mt-4">{errorContent}</div>
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-border/25 bg-background px-5 py-4">
            <Button
              type="button"
              variant="ghost"
              data-testid="plugin-publication-back"
              disabled={publishing}
              onClick={() => {
                if (enterpriseStep === 1) {
                  setScreen('intent')
                  return
                }
                setEnterpriseStep(current => (current - 1) as EnterpriseStep)
              }}
            >
              <ChevronLeft />
              {enterpriseStep === 1
                ? t('common.back', '返回')
                : t('common.previous_step', '上一步')}
            </Button>
            {enterpriseStep === 1 ? (
              <Button
                type="button"
                data-testid="plugin-publication-next-risk"
                disabled={!releaseNotes.trim()}
                onClick={() => setEnterpriseStep(2)}
              >
                {t('workbench.plugins_publication_next_risk', '下一步：权限与风险')}
              </Button>
            ) : enterpriseStep === 2 ? (
              <Button
                type="button"
                data-testid="plugin-publication-next-confirm"
                disabled={riskStepInvalid}
                onClick={() => setEnterpriseStep(3)}
              >
                {t('workbench.plugins_publication_review_submit', '查看并提交')}
              </Button>
            ) : (
              <Button
                type="button"
                data-testid="plugin-publication-submit"
                disabled={!declarationAccepted || publishing}
                onClick={() =>
                  onPublish({
                    intent: 'enterprise',
                    visibility: 'workspace',
                    targets: [],
                    allowCopy: false,
                    operationAttemptId: publicationAttemptIdRef.current,
                    releaseNotes,
                    testNotes: testNotes.trim(),
                    riskDeclaration: {
                      ...riskDeclaration,
                      externalDomains: riskDeclaration.externalNetworkAccess
                        ? normalizedDomains
                        : [],
                      commandExamples: riskDeclaration.executesCommands
                        ? normalizedCommandExamples
                        : [],
                      applicationPermissions: applicationAuthorization
                        ? normalizedApplicationPermissions
                        : [],
                      additionalNotes: riskDeclaration.additionalNotes.trim(),
                    },
                  })
                }
              >
                {publishing
                  ? t('workbench.plugins_publication_submitting', '正在创建快照…')
                  : t('workbench.plugins_publication_submit', '提交全员发布申请')}
              </Button>
            )}
          </footer>
        </section>
      </div>
    )
  }

  return (
    <div className="plugin-dialog-overlay fixed inset-0 z-modal flex items-end justify-center p-0 sm:items-center sm:p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-share-intent-title"
        data-testid={screen === 'intent' ? 'plugin-share-intent-dialog' : 'plugin-share-dialog'}
        className="plugin-dialog-surface w-full max-w-lg rounded-b-none p-5 sm:rounded-b-[20px]"
      >
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 id="plugin-share-intent-title" className="heading-small text-text-primary">
              {screen === 'intent'
                ? t('workbench.plugins_share_and_publish_title', '分享与发布')
                : t('workbench.plugins_share_members_title', '指定成员或部门')}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {pluginName} · v{pluginVersion}
            </p>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            data-testid="plugin-publish-close"
            aria-label={t('common.close', '关闭')}
            disabled={publishing}
            onClick={onClose}
          >
            <X />
          </Button>
        </header>

        {screen === 'intent' ? (
          <div
            className="mt-5 space-y-3"
            role="radiogroup"
            aria-labelledby="plugin-share-intent-title"
          >
            <button
              ref={restrictedIntentRef}
              type="button"
              role="radio"
              aria-checked={intent === 'restricted'}
              tabIndex={intent === 'restricted' ? 0 : -1}
              data-testid="plugin-share-intent-restricted"
              className={cn(
                'flex w-full items-start gap-3 rounded-xl border px-4 py-4 text-left transition-colors',
                intent === 'restricted'
                  ? 'border-blue-500/50 bg-blue-500/5'
                  : 'border-border/30 hover:bg-surface'
              )}
              onClick={() => setIntent('restricted')}
              onKeyDown={handleIntentKeyDown}
            >
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-text-secondary">
                <Users className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-text-primary">
                  {t('workbench.plugins_share_selected_people', '指定成员或部门')}
                </span>
                <span className="mt-1 block text-xs leading-4 text-text-muted">
                  {initialAccess && initialAccess.targets.length > 0
                    ? t('workbench.plugins_share_existing_summary', {
                        defaultValue: '当前已选择 {{count}} 个成员或部门',
                        count: initialAccess.targets.length,
                      })
                    : t(
                        'workbench.plugins_share_selected_people_hint',
                        '选择成员或部门，扫描通过后立即生效，无需审核'
                      )}
                </span>
              </span>
              <span
                aria-hidden="true"
                className={cn(
                  'mt-1 flex h-4 w-4 items-center justify-center rounded-full border',
                  intent === 'restricted'
                    ? 'border-blue-500 bg-blue-500 text-white'
                    : 'border-border'
                )}
              >
                {intent === 'restricted' ? <Check className="h-3 w-3" /> : null}
              </span>
            </button>

            <button
              ref={enterpriseIntentRef}
              type="button"
              role="radio"
              aria-checked={intent === 'enterprise'}
              tabIndex={intent === 'enterprise' ? 0 : -1}
              data-testid="plugin-share-intent-enterprise"
              className={cn(
                'flex w-full items-start gap-3 rounded-xl border px-4 py-4 text-left transition-colors',
                intent === 'enterprise'
                  ? 'border-blue-500/50 bg-blue-500/5'
                  : 'border-border/30 hover:bg-surface'
              )}
              onClick={() => setIntent('enterprise')}
              onKeyDown={handleIntentKeyDown}
            >
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-text-secondary">
                <Globe2 className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-text-primary">
                  {t('workbench.plugins_share_enterprise_everyone', '全员可见')}
                </span>
                <span className="mt-1 block text-xs leading-4 text-text-muted">
                  {activePublication
                    ? publicationRequiresProgress
                      ? t('workbench.plugins_publication_active_summary', {
                          defaultValue: 'v{{version}} · {{status}}',
                          version: activePublication.version,
                          status: activePublicationStatusLabel,
                        })
                      : t('workbench.plugins_publication_next_revision_summary', {
                          defaultValue:
                            'Next v{{version}} · previous request v{{previousVersion}} {{status}}',
                          version: pluginVersion,
                          previousVersion: activePublication.version,
                          status: activePublicationStatusLabel,
                        })
                    : t(
                        'workbench.plugins_share_enterprise_everyone_hint',
                        '提交企业发布申请，通过检查与审核后向全员发布'
                      )}
                </span>
              </span>
              <span
                aria-hidden="true"
                className={cn(
                  'mt-1 flex h-4 w-4 items-center justify-center rounded-full border',
                  intent === 'enterprise'
                    ? 'border-blue-500 bg-blue-500 text-white'
                    : 'border-border'
                )}
              >
                {intent === 'enterprise' ? <Check className="h-3 w-3" /> : null}
              </span>
            </button>
            {intent === 'enterprise' ? (
              <div
                data-testid="plugin-share-enterprise-flow"
                className="space-y-3 rounded-xl bg-surface px-4 py-3"
              >
                <p className="text-xs font-medium text-text-primary">
                  {t('workbench.plugins_publication_flow_title', '发布流程')}
                </p>
                <ol
                  className="flex items-center gap-1 text-xs leading-4 text-text-secondary"
                  aria-label={t('workbench.plugins_publication_flow_title', '发布流程')}
                >
                  {[
                    t('workbench.plugins_publication_stage_automatic_checks', '自动检查'),
                    t('workbench.plugins_publication_stage_administrator_review', '管理员审核'),
                    t('workbench.plugins_publication_stage_code_review', '代码审核'),
                    t('workbench.plugins_publication_stage_release', '发布'),
                  ].map((stage, index, stages) => (
                    <li key={stage} className="contents">
                      <span className="min-w-0 flex-1 text-center">{stage}</span>
                      {index < stages.length - 1 ? (
                        <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                      ) : null}
                    </li>
                  ))}
                </ol>
                <p className="flex items-start gap-2 text-xs leading-4 text-text-muted">
                  <ShieldCheck aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {t(
                      'workbench.plugins_publication_not_immediate',
                      '提交后不会立即向全员开放；审核期间仍可继续使用和编辑个人插件。'
                    )}
                  </span>
                </p>
              </div>
            ) : null}
            {errorContent}
          </div>
        ) : (
          <div className="mt-5">
            <PluginShareTargetSearch
              searchUsers={searchUsers}
              searchGroups={searchGroups}
              onSelect={addTarget}
            />

            <div className="mt-3 flex flex-wrap gap-2" data-testid="plugin-share-targets">
              {targets.map(target => (
                <span
                  key={target.entityType + '-' + target.entityId}
                  className="inline-flex h-8 items-center gap-1 rounded-lg bg-surface pl-2.5 pr-1 text-sm"
                >
                  {target.displayName}
                  <button
                    type="button"
                    data-testid={
                      'plugin-share-target-remove-' + target.entityType + '-' + target.entityId
                    }
                    aria-label={t('common.remove', '移除') + ' ' + target.displayName}
                    className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                    onClick={() =>
                      setTargets(current =>
                        current.filter(
                          item =>
                            item.entityType !== target.entityType ||
                            item.entityId !== target.entityId
                        )
                      )
                    }
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              ))}
            </div>

            <label className="mt-4 flex min-h-11 items-center justify-between gap-4 rounded-xl border border-border/30 px-3 py-3 transition-colors hover:bg-surface">
              <span>
                <strong className="block text-sm font-medium">
                  {t('workbench.plugins_share_allow_copy', '允许复制为个人插件')}
                </strong>
                <small className="block text-xs text-text-muted">
                  {t('workbench.plugins_share_allow_copy_hint', '接收者可创建独立的本地副本')}
                </small>
              </span>
              <input
                type="checkbox"
                checked={allowCopy}
                data-testid="plugin-share-allow-copy"
                className="h-4 w-4 accent-neutral-900"
                onChange={event => setAllowCopy(event.target.checked)}
              />
            </label>
            {targets.length === 0 && initialAccess?.scope === 'restricted' ? (
              <p className="mt-3 text-xs text-text-muted">
                {t(
                  'workbench.plugins_share_empty_private_hint',
                  '保存后将清空现有分享范围并恢复为仅自己可用。'
                )}
              </p>
            ) : null}
            <div className="mt-4">{errorContent}</div>
          </div>
        )}

        <footer className="mt-5 flex justify-end gap-2">
          {screen === 'restricted' ? (
            <Button
              type="button"
              variant="ghost"
              data-testid="plugin-share-back"
              disabled={publishing}
              onClick={() => setScreen('intent')}
            >
              {t('common.back', '返回')}
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              data-testid="plugin-share-intent-cancel"
              disabled={publishing}
              onClick={onClose}
            >
              {t('common.cancel', '取消')}
            </Button>
          )}
          {screen === 'intent' ? (
            <Button
              type="button"
              data-testid="plugin-share-intent-continue"
              onClick={continueFromIntent}
            >
              {intent === 'enterprise' && publicationRequiresProgress
                ? t('workbench.plugins_publication_view_progress', '查看申请进度')
                : intent === 'restricted'
                  ? t('workbench.plugins_share_select_people', '选择成员或部门')
                  : activePublication?.canCreateRevision
                    ? t('workbench.plugins_publication_create_revision', '提交新修订版')
                    : t('workbench.plugins_publication_continue', '继续填写发布申请')}
            </Button>
          ) : (
            <Button
              type="button"
              data-testid="plugin-share-save-scope"
              disabled={publishing}
              onClick={() =>
                onPublish({
                  intent: 'restricted',
                  visibility: 'personal',
                  targets,
                  allowCopy: targets.length > 0 && allowCopy,
                })
              }
            >
              {publishing
                ? t('workbench.plugins_share_scanning', '正在扫描…')
                : t('workbench.plugins_share_save_scope', '保存分享范围')}
            </Button>
          )}
        </footer>
      </section>
    </div>
  )
}
