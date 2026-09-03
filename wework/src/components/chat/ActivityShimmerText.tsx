import type { CSSProperties } from 'react'

const SHIMMER_DURATION_SECONDS = 1.6
const SHIMMER_TRAILING_SLOTS = 5
const MAX_ANIMATED_GRAPHEMES = 96
const SHIMMER_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
})

type ShimmerBandStyle = CSSProperties & {
  '--activity-shimmer-delay': string
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
  const segments = Array.from(
    SHIMMER_SEGMENTER.segment(children),
    segment => segment.segment
  ).slice(0, MAX_ANIMATED_GRAPHEMES)
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
          }

          return (
            <span
              key={`${segment}-${index}`}
              className="activity-shimmer-band"
              data-grapheme={segment}
              style={style}
            />
          )
        })}
      </span>
    </span>
  )
}
