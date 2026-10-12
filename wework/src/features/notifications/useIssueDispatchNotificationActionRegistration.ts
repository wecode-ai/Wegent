import { useCallback, useContext, useEffect, useRef } from 'react'
import {
  NotificationTaskContext,
  type IssueDispatchNotificationAction,
} from './NotificationTaskSourceContext'

export function useIssueDispatchNotificationActionRegistration(
  id: string,
  active: boolean,
  action: IssueDispatchNotificationAction
) {
  const context = useContext(NotificationTaskContext)
  const registerIssueDispatchAction = context?.registerIssueDispatchAction
  const actionRef = useRef(action)
  const stableAction = useCallback<IssueDispatchNotificationAction>(
    input => actionRef.current(input),
    []
  )

  useEffect(() => {
    actionRef.current = action
  }, [action])

  useEffect(() => {
    if (!registerIssueDispatchAction) return
    registerIssueDispatchAction(id, stableAction, active)
    return () => registerIssueDispatchAction(id, null, active)
  }, [active, id, registerIssueDispatchAction, stableAction])
}
