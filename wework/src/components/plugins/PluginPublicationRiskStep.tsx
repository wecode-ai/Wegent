import { type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

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

export function PluginPublicationRiskStep({
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
            className="mt-1 h-4 w-4 accent-[rgb(var(--color-text-primary))] wework:accent-neutral-900"
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
              className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none keyboard:focus:border-focus/70 keyboard:focus:ring-2 keyboard:focus:ring-focus/15"
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
                  className="mt-1 h-4 w-4 accent-[rgb(var(--color-text-primary))] wework:accent-neutral-900"
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
                    className="mt-2 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none keyboard:focus:border-focus/70 keyboard:focus:ring-2 keyboard:focus:ring-focus/15"
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
              className="mt-1 h-4 w-4 accent-[rgb(var(--color-text-primary))] wework:accent-neutral-900"
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
                className="mt-2 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none keyboard:focus:border-focus/70 keyboard:focus:ring-2 keyboard:focus:ring-focus/15"
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
            'w-full resize-none rounded-xl border bg-background px-3 py-2 text-sm outline-none',
            testNotesAreBlank
              ? 'border-destructive/50 focus:border-destructive/70 focus:ring-2 focus:ring-destructive/15 wework:border-red-500/50 wework:focus:border-red-500/70 wework:focus:ring-red-500/15'
              : 'border-border keyboard:focus:border-focus/70 keyboard:focus:ring-2 keyboard:focus:ring-focus/15'
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
          className={cn(
            'block text-xs',
            testNotesAreBlank ? 'text-destructive wework:text-red-600' : 'text-text-muted'
          )}
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
          className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none keyboard:focus:border-focus/70 keyboard:focus:ring-2 keyboard:focus:ring-focus/15"
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
