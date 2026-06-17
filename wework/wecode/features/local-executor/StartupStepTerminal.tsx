import { ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

interface StartupStepTerminalProps {
  logs: string
  running: boolean
}

export function StartupStepTerminal({ logs, running }: StartupStepTerminalProps) {
  // null = follow `running`; once the user toggles, their choice wins.
  const [override, setOverride] = useState<boolean | null>(null)
  const expanded = override ?? running
  const scrollRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (!expanded) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs, expanded])

  return (
    <div className="mt-1.5 overflow-hidden rounded-md border border-border/60 bg-[#1e1e1e]">
      <button
        type="button"
        onClick={() => setOverride(!expanded)}
        className="flex w-full items-center gap-1 px-2 py-1 text-[11px] font-medium text-zinc-300 hover:bg-white/5"
        data-testid="device-onboarding-terminal-toggle"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span>安装日志</span>
        {running && <span className="ml-auto animate-pulse text-emerald-400">运行中</span>}
      </button>
      {expanded && (
        <pre
          ref={scrollRef}
          className="max-h-48 overflow-auto px-2.5 pb-2 text-[11px] leading-4 text-zinc-200 whitespace-pre-wrap break-words font-mono"
          data-testid="device-onboarding-terminal-output"
        >
          {logs || '正在等待输出...'}
        </pre>
      )}
    </div>
  )
}
