import { Grid3X3, type LucideProps } from 'lucide-react'
import { DynamicIcon, iconNames, type IconName } from 'lucide-react/dynamic.js'

const DSH_ICON_NAMES = new Set<string>(iconNames)

export default function DynamicDshIcon({ name, ...props }: LucideProps & { name: string }) {
  if (!DSH_ICON_NAMES.has(name)) return <Grid3X3 {...props} />

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
