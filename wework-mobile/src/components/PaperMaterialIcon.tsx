import Ionicons from '@expo/vector-icons/Ionicons'
import type { ComponentProps } from 'react'

type IoniconName = ComponentProps<typeof Ionicons>['name']
type PaperMaterialIconProps = Omit<ComponentProps<typeof Ionicons>, 'name'> & {
  name: string
}

const paperIconNames: Readonly<Record<string, IoniconName>> = {
  check: 'checkmark',
  close: 'close',
  'chevron-down': 'chevron-down',
  eye: 'eye',
  'eye-off': 'eye-off',
  'menu-down': 'chevron-down',
}

export function paperIoniconName(name: string): IoniconName {
  if (name in Ionicons.glyphMap) return name as IoniconName
  return paperIconNames[name] ?? 'ellipse-outline'
}

export default function PaperMaterialIcon({ name, ...props }: PaperMaterialIconProps) {
  return <Ionicons {...props} name={paperIoniconName(name)} />
}
