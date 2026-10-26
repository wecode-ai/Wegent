import { useId } from 'react'

/** The right-hand shadow separates into a faceless double. */
export function StandInIcon({
  enabled = false,
  className = 'h-7 w-7',
}: {
  enabled?: boolean
  className?: string
}) {
  const id = useId()
  const figureId = `${id}-figure`
  const shadowMaskId = `${id}-shadow`
  const primaryTransform = 'translate(1.2 2.1) scale(0.85)'
  return (
    <svg
      className={`stand-in-icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-state={enabled ? 'enabled' : 'disabled'}
    >
      <defs>
        <g id={figureId}>
          <circle cx="8" cy="10" r="3.8" />
          <path d="M1 24v-4a7 7 0 0 1 14 0v4Z" />
        </g>
        <mask
          id={shadowMaskId}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="24"
          height="24"
        >
          <rect width="24" height="24" fill="white" stroke="none" />
          <use
            href={`#${figureId}`}
            transform={primaryTransform}
            fill="black"
            stroke="black"
          />
        </mask>
      </defs>
      <g className="text-text-primary" mask={`url(#${shadowMaskId})`}>
        <g className="stand-in-icon-shadow">
          <use href={`#${figureId}`} fill="currentColor" stroke="none" />
        </g>
      </g>
      <use href={`#${figureId}`} transform={primaryTransform} />
    </svg>
  )
}
