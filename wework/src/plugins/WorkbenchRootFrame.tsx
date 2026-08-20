import { Fragment, type ReactNode } from 'react'

export function WorkbenchRootFrame({
  children,
  renderSlot,
}: {
  children: ReactNode
  renderSlot: (
    key: 'wework.shell.before' | 'wework.shell.after' | 'wework.shell.overlay',
    owner: Record<string, unknown>
  ) => ReactNode
}) {
  return (
    <Fragment>
      {renderSlot('wework.shell.before', {})}
      {children}
      {renderSlot('wework.shell.after', {})}
      {renderSlot('wework.shell.overlay', {})}
    </Fragment>
  )
}
