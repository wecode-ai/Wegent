import { AlarmClock, Cloud, Grid3X3, Plug, type LucideIcon, type LucideProps } from 'lucide-react'
import { DynamicIcon, iconNames, type IconName } from 'lucide-react/dynamic.js'

const DSH_ICON_NAMES = new Set<string>(iconNames)
const DSH_ICON_ALIASES: Record<string, LucideIcon> = {
  'alarm-clock': AlarmClock,
  applications: Grid3X3,
  cloud: Cloud,
  plug: Plug,
}

interface DshIconProps extends LucideProps {
  name?: string
}

export function DshIcon({ name, ...props }: DshIconProps) {
  const AliasIcon = name ? DSH_ICON_ALIASES[name] : undefined
  if (AliasIcon) return <AliasIcon {...props} />
  if (!name || !DSH_ICON_NAMES.has(name)) return <Grid3X3 {...props} />

  const className = [props.className, `lucide-${name}`].filter(Boolean).join(' ')
  return (
    <DynamicIcon
      {...props}
      className={className}
      name={name as IconName}
      fallback={() => <Grid3X3 {...props} />}
    />
  )
}
