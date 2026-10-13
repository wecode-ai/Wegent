import { AlarmClock, Cloud, Grid3X3, Plug, type LucideIcon, type LucideProps } from 'lucide-react'
import { lazy, Suspense } from 'react'

const DynamicDshIcon = lazy(() => import('./DynamicDshIcon'))
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
  if (!name) return <Grid3X3 {...props} />

  return (
    <Suspense fallback={<Grid3X3 {...props} />}>
      <DynamicDshIcon {...props} name={name} />
    </Suspense>
  )
}
