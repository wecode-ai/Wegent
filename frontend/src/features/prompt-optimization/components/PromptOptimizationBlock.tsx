import React, { useState } from 'react'
import ReactDiffViewer from 'react-diff-viewer-continued'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { FileEdit, RotateCcw, Check, Loader2, ChevronRight, ChevronDown } from 'lucide-react'
import { getToken } from '@/apis/user'

interface PromptChange {
  type: 'ghost' | 'member'
  id: number
  name: string
  field: string
  original: string
  suggested: string
  index?: number
}

interface ApplyAction {
  endpoint: string
  method: string
  payload: {
    team_id: number
    changes: Array<{
      type: 'ghost' | 'member'
      id?: number
      team_id?: number
      index?: number
      field?: string
      value: string
    }>
  }
}

interface PromptOptimizationBlockProps {
  changes: PromptChange[]
  apply_action: ApplyAction
}

const diffStyles = {
  variables: {
    light: {
      diffViewerBackground: 'transparent',
      addedBackground: '#dcfce7',
      addedColor: '#166534',
      removedBackground: '#fee2e2',
      removedColor: '#991b1b',
      wordAddedBackground: '#bbf7d0',
      wordRemovedBackground: '#fecaca',
      addedGutterBackground: '#dcfce7',
      removedGutterBackground: '#fee2e2',
      gutterBackground: 'transparent',
      gutterBackgroundDark: 'transparent',
      codeFoldBackground: '#f5f5f5',
      codeFoldGutterBackground: '#f5f5f5',
      emptyLineBackground: 'transparent',
    },
  },
  line: {
    fontSize: '12px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  },
  contentText: {
    fontSize: '12px',
    lineHeight: '1.6',
  },
  gutter: {
    minWidth: '32px',
    padding: '0 8px',
  },
}

function buildSinglePayload(
  change: PromptChange,
  applyAction: ApplyAction,
  value: string
): ApplyAction['payload'] {
  const singleChange: ApplyAction['payload']['changes'][0] = {
    type: change.type,
    value,
  }
  if (change.type === 'ghost') {
    singleChange.id = change.id
    singleChange.field = change.field
  } else {
    singleChange.team_id = applyAction.payload.team_id
    singleChange.index = change.index
  }
  return { team_id: applyAction.payload.team_id, changes: [singleChange] }
}

async function sendChange(endpoint: string, method: string, payload: unknown) {
  const response = await fetch(endpoint, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
    },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const errorData = await response.json()
    throw new Error(errorData.detail || 'Failed to apply change')
  }
}

type CardStatus = 'idle' | 'loading' | 'applied' | 'rolledback' | 'error'

function ChangeCard({
  change,
  index,
  applyAction,
}: {
  change: PromptChange
  index: number
  applyAction: ApplyAction
}) {
  const { t } = useTranslation('promptOptimization')
  const [status, setStatus] = useState<CardStatus>('idle')
  const [showFull, setShowFull] = useState(false)

  const title =
    change.type === 'ghost'
      ? t('ghost_prompt_change', { name: change.name })
      : t('member_prompt_change', { name: change.name })

  const handleApply = async () => {
    setStatus('loading')
    try {
      const payload = buildSinglePayload(change, applyAction, change.suggested)
      await sendChange(applyAction.endpoint, applyAction.method, payload)
      setStatus('applied')
    } catch {
      setStatus('error')
    }
  }

  const handleRollback = async () => {
    setStatus('loading')
    try {
      const payload = buildSinglePayload(change, applyAction, change.original)
      await sendChange(applyAction.endpoint, applyAction.method, payload)
      setStatus('rolledback')
    } catch {
      setStatus('error')
    }
  }

  const isLoading = status === 'loading'

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <FileEdit className="h-4 w-4 text-primary" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="max-h-[300px] overflow-y-auto rounded-md border border-border">
          <ReactDiffViewer
            oldValue={change.original}
            newValue={change.suggested}
            splitView={false}
            useDarkTheme={false}
            showDiffOnly={false}
            styles={diffStyles}
            hideLineNumbers={false}
          />
        </div>

        <button
          type="button"
          className="flex cursor-pointer items-center gap-1 py-1 text-xs text-text-secondary hover:text-text-primary"
          onClick={() => setShowFull(!showFull)}
          data-testid={`prompt-opt-toggle-full-${index}`}
        >
          {showFull ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {showFull ? t('hide_full_prompt') : t('view_full_prompt')}
        </button>

        {showFull && (
          <pre className="max-h-[400px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface p-3 font-mono text-xs text-text-primary">
            {change.suggested}
          </pre>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          {status === 'applied' && (
            <span className="text-xs text-green-600">{t('apply_success')}</span>
          )}
          {status === 'rolledback' && (
            <span className="text-xs text-green-600">{t('rollback_success')}</span>
          )}
          {status === 'error' && <span className="text-xs text-red-500">{t('action_error')}</span>}
          <Button
            variant="outline"
            size="sm"
            onClick={handleRollback}
            disabled={isLoading}
            data-testid={`prompt-opt-rollback-${index}`}
          >
            {isLoading ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <RotateCcw className="mr-1 h-3 w-3" />
            )}
            {t('rollback')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleApply}
            disabled={isLoading}
            data-testid={`prompt-opt-apply-${index}`}
          >
            {isLoading ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Check className="mr-1 h-3 w-3" />
            )}
            {t('apply')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export const PromptOptimizationBlock: React.FC<PromptOptimizationBlockProps> = ({
  changes,
  apply_action,
}) => {
  if (!changes || changes.length === 0) {
    return null
  }

  return (
    <div className="space-y-3 py-2">
      {changes.map((change, index) => (
        <ChangeCard
          key={`${change.type}-${change.id}-${index}`}
          change={change}
          index={index}
          applyAction={apply_action}
        />
      ))}
    </div>
  )
}
