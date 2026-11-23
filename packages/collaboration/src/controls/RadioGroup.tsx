import { isComposing } from '@ui-sdk/core'
import {
  createRadioGroupController,
  Radio as UiRadio,
  RadioGroup as UiRadioGroup,
  RadioIndicator as UiRadioIndicator,
} from '@ui-sdk/react/radio'
import { useMemo, type ComponentProps } from 'react'

export { RadioIndicator } from '@ui-sdk/react/radio'

export function Radio({
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof UiRadio>, 'className'> & { className?: string }) {
  return (
    <UiRadio
      {...props}
      data-control-value={props.value}
      className={
        children === undefined
          ? [
              'group/radio inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/40 data-[disabled]:opacity-40 md:min-h-6 md:min-w-6',
              className,
            ]
              .filter(Boolean)
              .join(' ')
          : className
      }
    >
      {children ?? (
        <span className="flex h-4 w-4 items-center justify-center rounded-full border border-border bg-background group-data-[checked]/radio:border-text-primary">
          <UiRadioIndicator className="h-2 w-2 rounded-full bg-text-primary" />
        </span>
      )}
    </UiRadio>
  )
}

export function RadioGroup({
  onKeyDown,
  controller: suppliedController,
  ...props
}: ComponentProps<typeof UiRadioGroup>) {
  const localController = useMemo(() => createRadioGroupController(), [])
  const controller = suppliedController ?? localController
  return (
    <UiRadioGroup
      {...props}
      controller={controller}
      onKeyDown={event => {
        onKeyDown?.(event)
        // Model lists retain their Home/End shortcuts; the SDK owns arrows and selection.
        if (
          event.defaultPrevented ||
          isComposing(event.nativeEvent) ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          !['Home', 'End'].includes(event.key)
        )
          return
        if (
          !(event.target instanceof HTMLElement) ||
          event.target.closest('[role="radiogroup"]') !== event.currentTarget ||
          !event.target.matches('[role="radio"]')
        )
          return
        const items = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            '[role="radio"][data-control-value]'
          ),
        ].filter(
          item =>
            item.closest('[role="radiogroup"]') === event.currentTarget &&
            !item.matches(':disabled,[aria-disabled="true"]')
        )
        const target = event.key === 'Home' ? items[0] : items.at(-1)
        if (!target) return
        event.preventDefault()
        controller.setValue(target.dataset.controlValue!, {
          reason: 'list-navigation',
          event: event.nativeEvent,
        })
        target.focus()
      }}
    />
  )
}
