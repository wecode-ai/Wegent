import { TaskReplyQueueStore } from '@wegent/collaboration/execution/taskReplyQueue'
import {
  cacheRuntimeConversationQueuedMessagesByKey,
  getRuntimeConversationQueuedMessagesByKey,
} from '@/features/workbench/runtimeConversationCache'
export const taskReplyQueueStore = new TaskReplyQueueStore({
  read: getRuntimeConversationQueuedMessagesByKey,
  write: cacheRuntimeConversationQueuedMessagesByKey,
})
