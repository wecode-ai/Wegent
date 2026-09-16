import {
  isLoopItemExecutionActive as isSharedLoopItemExecutionActive,
  isMyWorkExecutionActive as isSharedMyWorkExecutionActive,
  myWorkGroupOf as sharedMyWorkGroupOf,
  type MyWorkGroupKey,
} from '@wegent/collaboration'
import type { CloudLoopItem, CloudMyWorkItem } from '@/api/deliveries'
import { isExecutionActive } from './executionStatus'

export type { MyWorkGroupKey }

export function isLoopItemExecutionActive(
  item: Pick<CloudLoopItem, 'status' | 'execution_state'>
): boolean {
  return isSharedLoopItemExecutionActive(item, isExecutionActive)
}

export function isMyWorkExecutionActive(item: CloudMyWorkItem): boolean {
  return isSharedMyWorkExecutionActive(item, isExecutionActive)
}

export function myWorkGroupOf(item: CloudMyWorkItem): MyWorkGroupKey {
  return sharedMyWorkGroupOf(item, isExecutionActive)
}
