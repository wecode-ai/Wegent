import type { StandInLearningDimension } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'

type Axis = StandInLearningDimension & {
  label: string
  chartLabel: string
  result: string
  note?: string
}

type ScoredAxis = Axis & { baselineScore: number; candidateScore: number }
const scored = (axis: Axis): axis is ScoredAxis =>
  axis.baselineScore != null && axis.candidateScore != null

const radarLabels = {
  3: [
    [130, 1, 'center'],
    [239, 155, 'left'],
    [7, 155, 'right'],
  ],
  4: [
    [130, 1, 'center'],
    [260, 96, 'left'],
    [130, 195, 'center'],
    [0, 96, 'right'],
  ],
  5: [
    [130, 1, 'center'],
    [260, 76, 'left'],
    [216, 190, 'left'],
    [34, 190, 'right'],
    [0, 76, 'right'],
  ],
} as const

function Radar({ axes, format }: { axes: ScoredAxis[]; format: Intl.NumberFormat }) {
  const positions = radarLabels[axes.length as keyof typeof radarLabels]
  const point = (index: number, score: number) => {
    const angle = (index * 2 * Math.PI) / axes.length - Math.PI / 2
    const radius = 18 + (score * 51) / 100
    return { x: 180 + Math.cos(angle) * radius, y: 111 + Math.sin(angle) * radius }
  }
  const outline = (values: number[]) =>
    values
      .map((value, index) => {
        const { x, y } = point(index, value)
        return x + ',' + y
      })
      .join(' ')

  return (
    <svg
      viewBox="0 0 360 243"
      className="mx-auto block w-full max-w-sm overflow-visible"
      aria-hidden="true"
    >
      {[0, 25, 50, 75, 100].map(level => (
        <polygon
          key={level}
          points={outline(axes.map(() => level))}
          className="fill-none stroke-text-secondary/30"
          strokeWidth={0.7}
        />
      ))}
      {axes.map((axis, index) => {
        const start = point(index, 0)
        const end = point(index, 100)
        return (
          <line
            key={axis.id}
            x1={start.x}
            y1={start.y}
            x2={end.x}
            y2={end.y}
            className="stroke-text-secondary/25"
            strokeWidth={0.7}
          />
        )
      })}
      <polygon
        points={outline(axes.map(axis => axis.candidateScore))}
        className="fill-focus/10 stroke-focus"
        strokeWidth={1.6}
      />
      <polygon
        points={outline(axes.map(axis => axis.baselineScore))}
        className="fill-none stroke-text-secondary"
        strokeWidth={1.25}
        strokeDasharray="3 3"
      />
      <text
        x={180}
        y={111}
        textAnchor="middle"
        dominantBaseline="central"
        className="fill-text-secondary text-xs"
      >
        0
      </text>
      {axes.map((axis, index) => {
        const before = point(index, axis.baselineScore)
        const after = point(index, axis.candidateScore)
        const [x, y, textAlign] = positions[index]
        return (
          <g key={axis.id}>
            <rect
              x={before.x - 2.7}
              y={before.y - 2.7}
              width={5.4}
              height={5.4}
              className="fill-surface stroke-text-secondary"
            />
            <circle
              cx={after.x}
              cy={after.y}
              r={axis.baselineScore === axis.candidateScore ? 1.7 : 3.1}
              className="fill-focus"
            />
            <foreignObject x={x} y={y} width={100} height={52}>
              <div style={{ textAlign }}>
                <p className="text-sm font-medium leading-tight">{axis.chartLabel}</p>
                <p className="mt-0.5 text-xs tabular-nums text-text-secondary">
                  {format.format(axis.baselineScore)} <span className="px-0.5">→</span>{' '}
                  <strong className="font-semibold text-text-primary">
                    {format.format(axis.candidateScore)}
                  </strong>
                </p>
                {axis.note && (
                  <p className="whitespace-nowrap text-xs leading-tight text-text-secondary">
                    {axis.note}
                  </p>
                )}
              </div>
            </foreignObject>
          </g>
        )
      })}
    </svg>
  )
}

function ScoreTrack({ axis }: { axis: ScoredAxis }) {
  const { baselineScore: before, candidateScore: after } = axis
  return (
    <div className="relative mt-1 h-3" aria-hidden="true">
      <span className="absolute inset-x-0 top-1/2 h-px bg-border" />
      <span
        className="absolute top-1/2 h-px bg-focus"
        style={{ left: Math.min(before, after) + '%', width: Math.abs(after - before) + '%' }}
      />
      <span
        className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 border border-text-secondary bg-surface"
        style={{ left: before + '%' }}
      />
      <span
        className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-focus ${before === after ? 'size-1' : 'size-2'}`}
        style={{ left: after + '%' }}
      />
    </div>
  )
}

export function StandInLearningDimensions({ axes }: { axes: StandInLearningDimension[] }) {
  const { t, i18n } = useTranslation('common')
  const format = new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 1 })
  const prefix = 'standIn.workspace.learning_report.dimensions'
  const rows = axes.map<Axis>(axis => {
    const total = axis.sampleCount + axis.insufficientCount + axis.notApplicableCount
    const notApplicable = axis.notApplicableCount > 0 && axis.insufficientCount === 0
    const hasScores = axis.baselineScore != null && axis.candidateScore != null
    return {
      ...axis,
      label: t(`${prefix}.${axis.id}`),
      chartLabel: t(`${prefix}.axis.${axis.id}`, { defaultValue: t(`${prefix}.${axis.id}`) }),
      result: hasScores
        ? t(`${prefix}.change`, {
            before: format.format(axis.baselineScore!),
            after: format.format(axis.candidateScore!),
          })
        : t(`${prefix}.${notApplicable ? 'not_applicable' : 'insufficient'}`),
      note:
        hasScores && axis.sampleCount < total
          ? t(`${prefix}.coverage`, { scored: axis.sampleCount, total })
          : undefined,
    }
  })
  const rated = rows.filter(scored)
  const unrated = rows.filter(axis => !scored(axis))
  const hasRadar = rated.length >= 3
  return (
    <section
      className="space-y-2 border-t border-border pt-3"
      data-testid="stand-in-learning-dimensions"
    >
      <h4 className="font-medium">{t(`${prefix}.title`)}</h4>
      {hasRadar && <Radar axes={rated} format={format} />}
      {rated.length > 0 && (
        <div
          className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary ${hasRadar ? 'justify-center' : ''}`}
        >
          <span className="inline-flex items-center gap-1.5">
            <i
              className={
                hasRadar
                  ? 'w-3 border-t border-dashed border-text-secondary'
                  : 'size-2 border border-text-secondary'
              }
              aria-hidden="true"
            />
            {t(`${prefix}.before`)}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i
              className={hasRadar ? 'w-3 border-t border-focus' : 'size-2 rounded-full bg-focus'}
              aria-hidden="true"
            />
            {t(`${prefix}.after`)}
          </span>
          <span>{t(`${prefix}.scale`)}</span>
        </div>
      )}
      <dl className="divide-y divide-border">
        {[...rated, ...unrated].map(axis => (
          <div
            key={axis.id}
            className={
              hasRadar && scored(axis) ? 'sr-only' : 'grid grid-cols-[1fr_auto] gap-x-2 py-1.5'
            }
            data-testid={`stand-in-learning-dimension-${axis.id}`}
          >
            <dt className={scored(axis) ? 'min-w-0' : 'min-w-0 text-text-secondary'}>
              {axis.label}
            </dt>
            <dd className="self-baseline text-xs tabular-nums text-text-secondary">
              {axis.result}
            </dd>
            {!hasRadar && scored(axis) && (
              <div className="col-span-2 px-1">
                <ScoreTrack axis={axis} />
              </div>
            )}
            {!scored(axis) && (
              <div className="col-span-2 mt-1.5 border-t border-dotted border-border" />
            )}
            {axis.note && <dd className="col-span-2 text-xs text-text-secondary">{axis.note}</dd>}
          </div>
        ))}
      </dl>
    </section>
  )
}
