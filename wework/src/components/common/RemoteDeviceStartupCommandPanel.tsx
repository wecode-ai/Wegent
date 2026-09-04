import { Check, Copy } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { useTranslation } from '@/hooks/useTranslation'
import { copyTextToClipboard } from '@/lib/clipboard'
import type { DockerRemoteDeviceCommandResponse, RemoteDeviceStartupCommand } from '@/types/devices'

function normalizeStartupCommands(
  response: DockerRemoteDeviceCommandResponse
): RemoteDeviceStartupCommand[] {
  if (Array.isArray(response.commands) && response.commands.length > 0) {
    return response.commands.filter(command => command.command.trim())
  }
  return [
    {
      kind: 'docker',
      label: 'Docker',
      command: response.command,
    },
  ]
}

interface RemoteDeviceStartupCommandPanelProps {
  response: DockerRemoteDeviceCommandResponse
  actions?: ReactNode
  children?: ReactNode
  className?: string
  commandClassName?: string
  commandTestId?: string
  copyButtonTestId?: string
  onCopyError?: () => void
}

export function RemoteDeviceStartupCommandPanel({
  response,
  actions,
  children,
  className = '',
  commandClassName = 'max-h-[220px]',
  commandTestId = 'remote-device-startup-command',
  copyButtonTestId = 'copy-remote-device-startup-command',
  onCopyError,
}: RemoteDeviceStartupCommandPanelProps) {
  const { t } = useTranslation('common')
  const commands = useMemo(() => normalizeStartupCommands(response), [response])
  const [activeKind, setActiveKind] = useState(commands[0]?.kind ?? 'docker')
  const [copied, setCopied] = useState(false)
  const activeCommand = commands.find(command => command.kind === activeKind) ?? commands[0] ?? null

  if (!activeCommand) return null

  const copyCommand = async () => {
    try {
      await copyTextToClipboard(activeCommand.command)
      setCopied(true)
    } catch {
      onCopyError?.()
    }
  }

  return (
    <div className={className}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex h-10 w-full rounded-xl border border-border bg-surface p-1 sm:w-auto">
          {commands.map(command => {
            const isActive = command.kind === activeCommand.kind
            return (
              <button
                key={command.kind}
                type="button"
                data-testid={`remote-device-startup-tab-${command.kind}`}
                onClick={() => {
                  setActiveKind(command.kind)
                  setCopied(false)
                }}
                className={[
                  'flex h-8 flex-1 items-center justify-center rounded-lg px-3 text-sm font-medium sm:flex-none',
                  isActive
                    ? 'bg-background text-text-primary shadow-sm'
                    : 'text-text-secondary hover:text-text-primary',
                ].join(' ')}
              >
                {command.kind === 'process'
                  ? t('workbench.remote_device_startup_process', '脚本启动')
                  : command.kind === 'docker'
                    ? t('workbench.remote_device_startup_docker', 'Docker')
                    : command.label}
              </button>
            )
          })}
        </div>
        {actions}
      </div>

      <p className="mt-3 text-sm leading-5 text-text-secondary">
        {activeCommand.kind === 'process'
          ? t(
              'workbench.remote_device_startup_process_desc',
              '适用于 Linux 主机。自动安装并在后台启动云端设备连接程序。'
            )
          : activeCommand.kind === 'docker'
            ? t(
                'workbench.remote_device_startup_docker_desc',
                '推荐方式。用容器启动云端设备连接程序，适合云主机或远程服务器。'
              )
            : activeCommand.description}
      </p>

      <div className="mt-3 overflow-hidden rounded-lg border border-border bg-background">
        <div className="flex h-9 items-center justify-between gap-3 border-b border-border px-3">
          <span className="truncate text-xs font-semibold text-text-secondary">
            {t('workbench.remote_device_startup_script_title', '启动脚本')}
          </span>
          <button
            type="button"
            data-testid={copyButtonTestId}
            onClick={() => void copyCommand()}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied
              ? t('workbench.remote_device_startup_copied', '已复制')
              : t('workbench.remote_device_startup_copy', '复制')}
          </button>
        </div>
        <pre
          data-testid={commandTestId}
          className={`${commandClassName} overflow-auto whitespace-pre p-3 font-mono text-xs leading-5 text-text-primary`}
        >
          {activeCommand.command}
        </pre>
        {children}
      </div>
    </div>
  )
}
