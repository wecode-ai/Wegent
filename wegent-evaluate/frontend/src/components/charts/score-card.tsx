'use client'

export interface ScoreCardProps {
  title: string
  score?: number
  subtitle?: string
}

export function ScoreCard({ title, score, subtitle }: ScoreCardProps) {
  // Check if score is a valid number (not null, undefined, or NaN)
  const hasValidScore = score != null && !Number.isNaN(score)
  const percentage = hasValidScore ? score * 100 : 0

  const getColor = (pct: number) => {
    if (pct >= 80) return 'bg-green-500'
    if (pct >= 60) return 'bg-yellow-500'
    return 'bg-red-500'
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      <div className="mt-2 flex items-end gap-2">
        <span className="text-2xl font-semibold">
          {hasValidScore ? `${percentage.toFixed(1)}%` : '-'}
        </span>
      </div>
      {hasValidScore && (
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-secondary">
          <div
            className={`h-full ${getColor(percentage)} transition-all`}
            style={{ width: `${percentage}%` }}
          />
        </div>
      )}
      {subtitle && (
        <p className="mt-2 text-xs text-muted-foreground">{subtitle}</p>
      )}
    </div>
  )
}
