import type { SVGProps } from 'react'
import { COMPOSER_SKILL_ICON_PATHS } from './composerSkillIconPaths'

export function ComposerSkillIcon({ className = 'h-4 w-4', ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      {...props}
    >
      {COMPOSER_SKILL_ICON_PATHS.map(pathData => (
        <path key={pathData} d={pathData} />
      ))}
    </svg>
  )
}
