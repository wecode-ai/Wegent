import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Read numeric checkpoint evidence only; never inspect profiles or request payloads. */
export function readPerformanceReports(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory()) return []
    const path = join(directory, entry.name, 'performance.json')
    try {
      return [JSON.parse(readFileSync(path, 'utf8'))]
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  })
}

export function renderPerformanceReport(reports) {
  const escape = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
  const lines = [
    '## Wework checkpoint diagnostics',
    '',
    'Baseline not established; these are observations, not a performance pass.',
    '',
    '| Checkpoint | Environment | Functional | Metric coverage | RPCs | Describe | Full task reads | Parse / protocol failures | DOM records |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |',
  ]
  const coverageNotes = []
  for (const report of reports) {
    const metrics = report.metrics ?? {}
    const sum = prefix =>
      Object.entries(metrics)
        .filter(([key]) => key.startsWith(prefix))
        .reduce((n, [, value]) => n + value, 0)
    const available = key => metrics[key] ?? 'unavailable'
    const values = [
      report.checkpoint,
      `${report.platform}/${report.arch}/${report.variant}`,
      report.functionalPassed ? 'passed' : 'failed',
      report.complete ? 'observed' : 'incomplete',
      sum('executor.requests.'),
      available('executor.requests.executor.describe'),
      available('executor.fullTaskListReads'),
      `${available('executor.parseFailures')} / ${available('executor.protocolFailures')}`,
      available('ui.document.mutationRecords'),
    ]
    lines.push(`| ${values.map(escape).join(' | ')} |`)
    for (const error of report.coverageErrors ?? [])
      coverageNotes.push(`- ${escape(report.checkpoint)} coverage: ${escape(error)}`)
  }
  if (coverageNotes.length) lines.push('', ...coverageNotes)
  if (!reports.length) lines.push('', 'No checkpoint evidence was produced.')
  return `${lines.join('\n')}\n`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2])
  const reports = readPerformanceReports(directory)
  const markdown = renderPerformanceReport(reports)
  writeFileSync(join(directory, 'performance-report.md'), markdown)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
  console.log(
    `Collected ${reports.length} checkpoint performance reports; baseline not established`
  )
}
