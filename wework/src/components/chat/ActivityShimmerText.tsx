import type { CSSProperties } from 'react'

const SHIMMER_DURATION_SECONDS = 1.6
const SHIMMER_TRAILING_SLOTS = 5
const SHIMMER_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
})

type ShimmerBandStyle = CSSProperties & {
  '--activity-shimmer-delay': string
  '--activity-shimmer-left': string
  '--activity-shimmer-right': string
}

export function ActivityShimmerText({
  children,
  variant,
  className = '',
}: {
  children: string
  variant: 'thinking' | 'tool'
  className?: string
}) {
  const segments = Array.from(SHIMMER_SEGMENTER.segment(children), segment => segment.segment)
  const cycleSlots = segments.length + SHIMMER_TRAILING_SLOTS

  return (
    <span
      className={`activity-shimmer-text ${variant === 'thinking' ? 'waiting-thinking-text' : 'tool-activity-shimmer'} ${className}`}
    >
      {children}
      <span aria-hidden="true" className="activity-shimmer-highlight">
        {segments.map((segment, index) => {
          const style: ShimmerBandStyle = {
            '--activity-shimmer-delay': `${-(
              ((segments.length - index) * SHIMMER_DURATION_SECONDS) /
              cycleSlots
            ).toFixed(4)}s`,
            '--activity-shimmer-left': `${((index / segments.length) * 100).toFixed(4)}%`,
            '--activity-shimmer-right': `${(100 - ((index + 1) / segments.length) * 100).toFixed(
              4
            )}%`,
          }

          return (
            <span
              key={`${segment}-${index}`}
              className="activity-shimmer-band"
              data-text={children}
              style={style}
            />
          )
        })}
      </span>
    </span>
  )
}
