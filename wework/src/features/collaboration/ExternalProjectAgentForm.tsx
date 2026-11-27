import { useState, type FormEvent } from 'react'

import { Button } from '@wegent/collaboration/markdown/Button'
import { TextField as Input } from '@wegent/collaboration/controls/TextField'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  ExternalAgentRegistration,
  ExternalAgentRegistrationResult,
} from '@/api/agentResources'

const templates = {
  'application/json': [
    '{',
    '  "input": {{input}},',
    '  "callbackUrl": {{callbackUrl}},',
    '  "callbackToken": {{callbackToken}},',
    '  "invocationId": {{invocationId}},',
    '  "deliveryId": {{deliveryId}}',
    '}',
  ].join('\n'),
  'application/xml': [
    '<task>',
    '  <input>{{input}}</input>',
    '  <callbackUrl>{{callbackUrl}}</callbackUrl>',
    '  <callbackToken>{{callbackToken}}</callbackToken>',
    '  <invocationId>{{invocationId}}</invocationId>',
    '  <deliveryId>{{deliveryId}}</deliveryId>',
    '</task>',
  ].join('\n'),
  'application/x-www-form-urlencoded':
    'input={{input}}&callbackUrl={{callbackUrl}}&callbackToken={{callbackToken}}&invocationId={{invocationId}}&deliveryId={{deliveryId}}',
  'text/plain':
    '{{input}}\n\nCallback: {{callbackUrl}}\nToken: {{callbackToken}}\nInvocation: {{invocationId}}\nDelivery: {{deliveryId}}',
}

type ContentType = keyof typeof templates

type Props = {
  create(input: ExternalAgentRegistration): Promise<ExternalAgentRegistrationResult>
  checkConnection(agentId: string): Promise<{ connected: boolean }>
  onBack(): void
  onCreated(keepOpen?: boolean): Promise<void>
}

export function ExternalProjectAgentForm({ create, checkConnection, onBack, onCreated }: Props) {
  const { t, i18n } = useTranslation('collaborationExp')
  const [name, setName] = useState('')
  const [type, setType] = useState<'hook' | 'worker'>('hook')
  const [url, setUrl] = useState('')
  const [method, setMethod] = useState('POST')
  const [contentType, setContentType] = useState<ContentType>('application/json')
  const [template, setTemplate] = useState(templates[contentType])
  const [authorization, setAuthorization] = useState('')
  const [saved, setSaved] = useState<ExternalAgentRegistrationResult>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [checking, setChecking] = useState(false)
  const [connected, setConnected] = useState(false)

  async function checkWorker() {
    if (!saved || checking) return
    setChecking(true)
    setError('')
    try {
      setConnected((await checkConnection(saved.id)).connected)
    } catch {
      setError(t('externalAgent.connectionCheckFailed'))
    } finally {
      setChecking(false)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result =
        saved ??
        (await create(
          type === 'worker'
            ? { name: name.trim(), type }
            : {
                name: name.trim(),
                type,
                hook: {
                  url: url.trim(),
                  method,
                  contentType,
                  template,
                  headers: authorization ? { Authorization: authorization } : {},
                },
              }
        ))
      setSaved(result)
      await onCreated(Boolean(result.workerToken && !saved))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('externalAgent.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const selectClass = 'h-9 min-w-0 rounded-md border border-border bg-background px-2 text-sm'
  return (
    <form className="flex min-h-0 flex-col" onSubmit={submit} data-testid="external-agent-form">
      <div className="grid min-h-0 gap-4 overflow-auto px-5 py-4">
        {saved?.workerToken ? (
          <>
            <p
              role="status"
              className="text-sm text-text-primary"
              data-testid="external-agent-worker-status"
            >
              {t(connected ? 'externalAgent.workerConnected' : 'externalAgent.workerCreated')}
            </p>
            <p className="text-sm text-text-secondary">{t('externalAgent.workerTokenHint')}</p>
            <label className="grid gap-1 text-sm">
              {t('externalAgent.workerEndpoint')}
              <Input
                value={saved.workerEndpoint}
                readOnly
                data-testid="external-agent-worker-endpoint"
              />
            </label>
            <label className="grid gap-1 text-sm">
              {t('externalAgent.workerToken')}
              <Input
                type="password"
                value={saved.workerToken}
                readOnly
                data-testid="external-agent-worker-token"
              />
            </label>
            <Button
              type="button"
              variant={copied ? 'secondary' : 'primary'}
              className="justify-self-start"
              data-testid="external-agent-copy-token"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(saved.workerToken!)
                  setCopied(true)
                } catch {
                  setError(t('externalAgent.copyFailed'))
                }
              }}
            >
              {t(copied ? 'externalAgent.copied' : 'externalAgent.copyToken')}
            </Button>
            <p className="text-sm text-text-secondary">{t('externalAgent.workerStartHint')}</p>
            <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-code">
              <code>
                {[
                  'createWorker({',
                  '  endpoint: process.env.WEWORK_ENDPOINT,',
                  '  token: process.env.WEWORK_WORKER_TOKEN,',
                  '})',
                ].join('\n')}
              </code>
            </pre>
            <a
              className="justify-self-start text-sm text-text-primary underline underline-offset-4"
              data-testid="external-agent-worker-guide"
              href={`https://github.com/wecode-ai/Wegent/blob/main/docs/${i18n.language.startsWith('zh') ? 'zh' : 'en'}/wework/external-agent-protocol.md`}
              target="_blank"
              rel="noreferrer"
            >
              {t('externalAgent.workerGuide')}
            </a>
            <Button
              type="button"
              variant="secondary"
              className="justify-self-start"
              disabled={checking}
              onClick={checkWorker}
              data-testid="external-agent-check-connection"
            >
              {t(checking ? 'externalAgent.checking' : 'externalAgent.checkConnection')}
            </Button>
          </>
        ) : (
          <>
            <label className="grid gap-1 text-sm">
              {t('externalAgent.name')}
              <Input
                required
                maxLength={100}
                value={name}
                onChange={event => setName(event.target.value)}
                data-testid="external-agent-name"
              />
            </label>
            <label className="grid gap-1 text-sm">
              {t('externalAgent.transport')}
              <select
                className={selectClass}
                value={type}
                onChange={event => setType(event.target.value === 'hook' ? 'hook' : 'worker')}
                data-testid="external-agent-transport"
              >
                <option value="hook">{t('externalAgent.hook')}</option>
                <option value="worker">{t('externalAgent.worker')}</option>
              </select>
            </label>
            {type === 'hook' ? (
              <>
                <label className="grid gap-1 text-sm">
                  {t('externalAgent.hookUrl')}
                  <Input
                    required
                    type="url"
                    placeholder="https://hooks.example.com/tasks"
                    value={url}
                    onChange={event => setUrl(event.target.value)}
                    data-testid="external-agent-hook-url"
                  />
                </label>
                <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
                  <label className="grid gap-1 text-sm">
                    {t('externalAgent.method')}
                    <select
                      className={selectClass}
                      value={method}
                      onChange={event => setMethod(event.target.value)}
                      data-testid="external-agent-hook-method"
                    >
                      {['POST', 'PUT', 'PATCH'].map(value => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-sm">
                    {t('externalAgent.format')}
                    <select
                      className={selectClass}
                      value={contentType}
                      onChange={event => {
                        const next = event.target.value as ContentType
                        if (template === templates[contentType]) setTemplate(templates[next])
                        setContentType(next)
                      }}
                      data-testid="external-agent-hook-format"
                    >
                      <option value="application/json">JSON</option>
                      <option value="application/xml">XML</option>
                      <option value="application/x-www-form-urlencoded">
                        {t('externalAgent.form')}
                      </option>
                      <option value="text/plain">{t('externalAgent.text')}</option>
                    </select>
                  </label>
                </div>
                <label className="grid gap-1 text-sm">
                  {t('externalAgent.authorization')}
                  <Input
                    type="password"
                    autoComplete="off"
                    value={authorization}
                    onChange={event => setAuthorization(event.target.value)}
                    data-testid="external-agent-hook-authorization"
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  {t('externalAgent.template')}
                  <textarea
                    required
                    rows={6}
                    className="rounded-md border border-border bg-background p-2 font-mono text-code"
                    value={template}
                    onChange={event => setTemplate(event.target.value)}
                    data-testid="external-agent-hook-template"
                  />
                  <span className="text-text-secondary">{t('externalAgent.templateHint')}</span>
                </label>
              </>
            ) : (
              <p className="text-sm text-text-secondary">{t('externalAgent.workerHint')}</p>
            )}
          </>
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">
        {!saved ? (
          <Button
            variant="ghost"
            type="button"
            disabled={busy}
            onClick={onBack}
            data-testid="external-agent-back"
          >
            {t('externalAgent.back')}
          </Button>
        ) : null}
        <Button
          type="submit"
          variant={saved?.workerToken && !copied ? 'secondary' : 'primary'}
          disabled={busy || !name.trim()}
          data-testid="external-agent-save"
        >
          {t(busy ? 'externalAgent.saving' : saved ? 'externalAgent.done' : 'externalAgent.save')}
        </Button>
      </footer>
    </form>
  )
}
