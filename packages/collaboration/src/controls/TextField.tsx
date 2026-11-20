import { Input } from '@ui-sdk/react/input'
import type { ComponentPropsWithRef } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import {
  controlFieldAppearance,
  controlFieldDensity,
  controlInput,
  type ControlAppearance,
  type ControlDensity,
} from './recipes'

export interface TextFieldProps extends ComponentPropsWithRef<'input'> {
  density?: ControlDensity
  appearance?: ControlAppearance
}

export function TextField({
  value,
  defaultValue,
  className,
  onSelect,
  density = 'default',
  appearance = 'outline',
  ...props
}: TextFieldProps) {
  return (
    <Input
      {...props}
      render={<input onSelect={onSelect} />}
      value={value === undefined ? undefined : String(value)}
      defaultValue={defaultValue === undefined ? undefined : String(defaultValue)}
      className={cn(
        controlInput,
        controlFieldDensity[density],
        controlFieldAppearance[appearance],
        className
      )}
    />
  )
}
