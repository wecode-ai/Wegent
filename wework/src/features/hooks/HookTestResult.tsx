import type { HookRunSummary } from './hooksTypes'

export function HookTestResult({ run }: { run: HookRunSummary }) {
  return (
    <div data-testid="hook-test-result" className="mt-3 rounded-lg bg-muted/50 p-3 text-xs">
      <div>
        {run.status} · {run.durationMs} ms · {run.exitCode ?? '—'}
      </div>
      {run.stdoutPreview && (
        <pre className="mt-2 overflow-auto whitespace-pre-wrap text-code">{run.stdoutPreview}</pre>
      )}
      {run.stderrPreview && (
        <pre className="mt-2 overflow-auto whitespace-pre-wrap text-code text-red-500">
          {run.stderrPreview}
        </pre>
      )}
    </div>
  )
}
