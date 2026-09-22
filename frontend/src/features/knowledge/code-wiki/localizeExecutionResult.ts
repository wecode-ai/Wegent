import type { TFunction } from 'i18next'

const RESULT_KEYS: Record<string, string> = {
  'repository unchanged since last run': 'repositoryUnchanged',
  'Skipped because scheduled update was deleted': 'deleted',
  'Skipped because scheduled update was disabled': 'disabled',
  'Skipped because another generation is running': 'generationRunning',
  'Code Wiki no longer exists or its reference no longer matches': 'wikiUnavailable',
}

/** Translate known scheduler results, preserving arbitrary diagnostic text. */
export function localizeExecutionResult(summary: string, t: TFunction): string {
  const key = RESULT_KEYS[summary]
  if (key) return t(`knowledge:codeWiki.scheduledUpdate.results.${key}`)
  const started = /^(full|incremental) generation started$/.exec(summary)
  if (started) {
    return t('knowledge:codeWiki.scheduledUpdate.results.generationStarted', {
      mode: t(`knowledge:codeWiki.history.mode.${started[1]}`),
    })
  }
  return summary
}
