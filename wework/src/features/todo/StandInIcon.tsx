/** A single theatrical face distinguishes a stand-in from members and groups. */
export function StandInIcon({
  enabled = false,
  className = 'h-5 w-5',
}: {
  enabled?: boolean
  className?: string
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-state={enabled ? 'enabled' : 'disabled'}
    >
      <path d="M5 5.5C7 4.5 9.5 4 12 4s5 .5 7 1.5V12c0 4.5-3 7.5-7 8-4-.5-7-3.5-7-8Z" />
      {enabled ? (
        <g>
          <path d="M6.5 10q2-2 4 0-2 2-4 0Zm7 0q2-2 4 0-2 2-4 0Z" strokeWidth="1.25" />
          <g className="text-focus" fill="currentColor" stroke="none">
            <circle cx="8.5" cy="10" r=".8" />
            <circle cx="15.5" cy="10" r=".8" />
          </g>
        </g>
      ) : (
        <path d="M6.5 10q2 2 4 0m3 0q2 2 4 0" />
      )}
    </svg>
  )
}
