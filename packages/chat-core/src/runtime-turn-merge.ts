import {
  processingBlocks,
  assistantTextContent,
  preserveProcessingBlockTiming,
  completeRuntimeTurnTiming,
} from "./runtime-turn-helpers";
import { preserveRequestUserInputResponse } from "./runtime-user-input";
import { commandExecutionPayload } from "./command-execution";

import {
  getLatestThinkingContent,
  nestWorkbenchProcessingBlocks,
} from "./workbench-message-reducer";

import type {
  ProcessingBlock,
  RuntimeConversationItem,
  RuntimeConversationTurn,
} from "./runtime-conversation";

export function mergeRuntimeConversationTurn(
  local: RuntimeConversationTurn,
  snapshot: RuntimeConversationTurn,
): RuntimeConversationTurn {
  // A user-only read can finish after turn/start. It cannot retract the native
  // identity or lifecycle already observed by the live stream.
  if (snapshot.id === null && local.id !== null) {
    return {
      ...local,
      items: mergeRuntimeConversationItems(snapshot.items, local.items),
    };
  }
  const preserveLocalTerminal =
    isTerminalTurnStatus(local.status) &&
    isUnsettledTurnStatus(snapshot.status);
  const items =
    snapshot.itemMerge === "prepend"
      ? prependRuntimeConversationItems(
          local.items,
          snapshot.items,
          preserveLocalTerminal,
        )
      : mergeRuntimeConversationItems(
          local.items,
          snapshot.items,
          preserveLocalTerminal,
        );
  const preserveLocalFailure =
    local.status === "failed" && Boolean(local.error) && !snapshot.error;
  const preserveStreamingThinking =
    snapshot.status === "streaming" &&
    assistantTextContent(local.items) === assistantTextContent(snapshot.items);
  const timing = isTerminalTurnStatus(local.status)
    ? {
        startedAt: local.startedAt ?? snapshot.startedAt,
        durationMs: local.durationMs ?? snapshot.durationMs,
        completedAt: local.completedAt ?? snapshot.completedAt,
      }
    : isTerminalTurnStatus(snapshot.status) && local.startedAt !== undefined
      ? completeRuntimeTurnTiming(local, snapshot)
      : {
          startedAt: local.startedAt ?? snapshot.startedAt,
          durationMs: snapshot.durationMs,
          completedAt: snapshot.completedAt,
        };
  return {
    ...local,
    ...snapshot,
    clientUserMessageId:
      snapshot.clientUserMessageId ?? local.clientUserMessageId,
    runtimeMessageIndex: earliestRuntimeMessageIndex(local, snapshot),
    itemMerge: undefined,
    items: orderRuntimeConversationItems(items),
    position:
      Math.min(local.position ?? Infinity, snapshot.position ?? Infinity) ===
      Infinity
        ? undefined
        : Math.min(local.position ?? Infinity, snapshot.position ?? Infinity),
    fileChanges:
      local.fileChanges &&
      snapshot.fileChanges &&
      local.fileChanges.artifact_id === snapshot.fileChanges.artifact_id &&
      local.fileChanges.device_id === snapshot.fileChanges.device_id &&
      local.fileChanges.workspace_path ===
        snapshot.fileChanges.workspace_path &&
      local.fileChanges.status !== "active" &&
      snapshot.fileChanges.status === "active"
        ? local.fileChanges
        : (snapshot.fileChanges ?? local.fileChanges),
    status:
      preserveLocalTerminal || preserveLocalFailure
        ? local.status
        : snapshot.status,
    ...timing,
    error:
      preserveLocalTerminal || preserveLocalFailure
        ? local.error
        : snapshot.error,
    errorType:
      preserveLocalTerminal || preserveLocalFailure
        ? local.errorType
        : snapshot.errorType,
    stoppedNotice: preserveLocalTerminal
      ? local.stoppedNotice
      : snapshot.stoppedNotice,
    streamingThinkingContent: preserveLocalTerminal
      ? undefined
      : preserveStreamingThinking
        ? getLatestThinkingContent(processingBlocks(items))
        : snapshot.streamingThinkingContent,
  };
}

export function prependRuntimeConversationItems(
  localItems: RuntimeConversationItem[],
  snapshotItems: RuntimeConversationItem[],
  preserveLocalTerminal: boolean,
): RuntimeConversationItem[] {
  const matchedLocalIndexes = new Set<number>();
  const mergedSnapshotItems = snapshotItems.map((snapshotItem) => {
    const localIndex = localItems.findIndex(
      (localItem, index) =>
        !matchedLocalIndexes.has(index) && localItem.id === snapshotItem.id,
    );
    if (localIndex < 0) return snapshotItem;
    matchedLocalIndexes.add(localIndex);
    return mergeRuntimeConversationItem(
      localItems[localIndex],
      snapshotItem,
      preserveLocalTerminal,
    );
  });
  const remainingLocalItems = localItems.filter(
    (_, index) => !matchedLocalIndexes.has(index),
  );
  const leadingUserCount = remainingLocalItems.findIndex(
    (item) => item.type !== "user_message",
  );
  const insertionIndex =
    leadingUserCount < 0 ? remainingLocalItems.length : leadingUserCount;
  return [
    ...remainingLocalItems.slice(0, insertionIndex),
    ...mergedSnapshotItems,
    ...remainingLocalItems.slice(insertionIndex),
  ];
}

export function isTerminalTurnStatus(
  status: RuntimeConversationTurn["status"],
): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

export function isUnsettledTurnStatus(
  status: RuntimeConversationTurn["status"],
): boolean {
  return status === "pending" || status === "streaming";
}

export function earliestRuntimeMessageIndex(
  local: RuntimeConversationTurn,
  snapshot: RuntimeConversationTurn,
): number | undefined {
  const indexes = [
    local.runtimeMessageIndex,
    snapshot.runtimeMessageIndex,
  ].filter((index): index is number => typeof index === "number");
  return indexes.length > 0 ? Math.min(...indexes) : undefined;
}

export function orderRuntimeConversationTurns(
  turns: RuntimeConversationTurn[],
  sources: RuntimeConversationTurn[][] = [turns],
): RuntimeConversationTurn[] {
  const pendingOptimisticTurns = turns.filter((turn) => turn.id === null);
  const indexedTurns = turns
    .filter((turn) => turn.id !== null)
    .map((turn, index) => ({
      turn,
      index,
      timestamp: runtimeConversationTurnTimestamp(turn),
    }));
  let orderedTurns: RuntimeConversationTurn[];
  if (indexedTurns.some(({ turn }) => turn.position !== undefined)) {
    orderedTurns = orderNativePositionEntries(
      indexedTurns.map(({ turn }) => turn),
      observedNativePositionAnchors(turns, sources),
    );
  } else if (
    indexedTurns.every(({ turn }) => turn.runtimeMessageIndex !== undefined)
  ) {
    orderedTurns = indexedTurns
      .sort(
        (left, right) =>
          left.turn.runtimeMessageIndex! - right.turn.runtimeMessageIndex! ||
          left.index - right.index,
      )
      .map(({ turn }) => turn);
  } else if (indexedTurns.every(({ timestamp }) => timestamp !== undefined)) {
    orderedTurns = indexedTurns
      .sort(
        (left, right) =>
          left.timestamp! - right.timestamp! || left.index - right.index,
      )
      .map(({ turn }) => turn);
  } else {
    orderedTurns = indexedTurns.map(({ turn }) => turn);
  }
  return [...orderedTurns, ...pendingOptimisticTurns];
}

export function runtimeConversationTurnTimestamp(
  turn: RuntimeConversationTurn,
): number | undefined {
  const itemTimestamps = turn.items.map((item) =>
    item.type === "user_message"
      ? item.message.createdAt
      : item.type === "assistant_text"
        ? item.createdAt
        : item.block.createdAt,
  );
  // Failed turns can have no items while retaining their lifecycle timestamps.
  for (const value of [...itemTimestamps, turn.startedAt, turn.completedAt]) {
    const timestamp =
      typeof value === "number" ? value : Date.parse(value ?? "");
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return undefined;
}

export function mergeRuntimeConversationItems(
  localItems: RuntimeConversationItem[],
  snapshotItems: RuntimeConversationItem[],
  preserveLocalTerminal = false,
): RuntimeConversationItem[] {
  snapshotItems = removeEquivalentAssistantTextItems(
    snapshotItems,
    localItems.filter((item) => item.position !== undefined),
  );
  const snapshotUserIds = new Map(
    snapshotItems.flatMap((item) =>
      item.type === "user_message" ? [[item.message.id, item.id] as const] : [],
    ),
  );
  const localUsers = new Map(
    localItems.flatMap((item) =>
      item.type === "user_message" ? [[item.message.id, item] as const] : [],
    ),
  );
  const reconciledLocalItems = removeEquivalentAssistantTextItems(
    localItems,
    snapshotItems,
  );
  const canonicalLocalItems = reconciledLocalItems.filter(
    (item) =>
      item.type !== "user_message" ||
      !snapshotUserIds.has(item.message.id) ||
      snapshotUserIds.get(item.message.id) === item.id,
  );
  const localById = new Map(canonicalLocalItems.map((item) => [item.id, item]));
  const mergedSnapshotItems = snapshotItems.map((item) =>
    mergeRuntimeConversationItem(
      localById.get(item.id) ??
        (item.type === "user_message"
          ? localUsers.get(item.message.id)
          : undefined),
      item,
      preserveLocalTerminal,
    ),
  );
  const snapshotById = new Map(
    mergedSnapshotItems.map((item) => [item.id, item]),
  );
  const mergedLocalItems = canonicalLocalItems.map(
    (item) => snapshotById.get(item.id) ?? item,
  );
  const items = insertMissingSnapshotItems(
    mergedLocalItems,
    mergedSnapshotItems,
  );
  const anchors = observedNativePositionAnchors(items, [
    canonicalLocalItems,
    snapshotItems,
  ]);
  return orderRuntimeConversationItems(items, anchors);
}

function observedNativePositionAnchors<
  T extends { id: string | null; position?: number },
>(entries: T[], sources: T[][]): Map<string, number> {
  const positions = new Map(
    entries.flatMap((entry) =>
      entry.id === null || entry.position === undefined
        ? []
        : [[entry.id, entry.position] as const],
    ),
  );
  const anchors = new Map<string, number>();
  // Only original source sequences witness adjacency, never the merged union.
  for (const source of sources) {
    const hasNativeBoundary = source.some(
      (entry) => entry.id !== null && positions.has(entry.id),
    );
    let nextPosition = Infinity;
    for (let index = source.length - 1; index >= 0; index--) {
      const id = source[index].id;
      if (id === null) continue;
      const position = positions.get(id);
      if (position !== undefined) nextPosition = position;
      // A later source can explicitly observe output after its last native
      // boundary. Preserve that trailing placement instead of an older gap.
      else if (hasNativeBoundary || !anchors.has(id))
        anchors.set(id, nextPosition);
    }
  }
  return anchors;
}

/** Persisted positions are authoritative; items still in flight remain provisional. */
export function orderRuntimeConversationItems(
  items: RuntimeConversationItem[],
  observedAnchors?: ReadonlyMap<string, number>,
): RuntimeConversationItem[] {
  if (!items.some((item) => item.position !== undefined)) return items;
  const anchors = new Map(
    observedAnchors ?? observedNativePositionAnchors(items, [items]),
  );
  for (const item of items) {
    if (
      item.type === "user_message" &&
      !item.message.runtimeGuidance &&
      item.position === undefined
    )
      anchors.set(item.id, -Infinity);
  }
  return orderNativePositionEntries(items, anchors);
}

function orderNativePositionEntries<
  T extends { id: string | null; position?: number },
>(entries: T[], anchors: ReadonlyMap<string, number>): T[] {
  let nextPosition = Infinity;
  const ordered = entries.map((entry, index) => ({
    entry,
    index,
    anchor: Infinity,
  }));
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const item = ordered[index];
    if (item.entry.position !== undefined) nextPosition = item.entry.position;
    item.anchor =
      item.entry.position ??
      (item.entry.id === null ? undefined : anchors.get(item.entry.id)) ??
      nextPosition;
  }
  return ordered
    .sort(
      (left, right) =>
        left.anchor - right.anchor ||
        Number(left.entry.position !== undefined) -
          Number(right.entry.position !== undefined) ||
        left.index - right.index,
    )
    .map(({ entry }) => entry);
}

export function removeEquivalentAssistantTextItems(
  localItems: RuntimeConversationItem[],
  snapshotItems: RuntimeConversationItem[],
): RuntimeConversationItem[] {
  const localById = new Map(localItems.map((item) => [item.id, item]));
  const candidateGroups = new Map<string, AssistantTextCandidateGroup>();
  snapshotItems.forEach((item, index) => {
    // Exact provisional identities receive their native positions before text alias matching.
    if (
      item.position !== undefined &&
      localById.has(item.id) &&
      localById.get(item.id)?.position === undefined
    ) {
      return;
    }
    const content = assistantTextRepresentationContent(item);
    if (content === undefined) return;
    const group =
      candidateGroups.get(content) ?? createAssistantTextCandidateGroup();
    const queue = assistantTextCandidateQueue(group, item);
    queue.candidates.push({
      item,
      queueIndex: queue.candidates.length,
      snapshotIndex: index,
    });
    candidateGroups.set(content, group);
  });
  return localItems.filter((localItem) => {
    const content = assistantTextRepresentationContent(localItem);
    if (content === undefined) return true;
    const group = candidateGroups.get(content);
    if (!group) return true;
    const match = assistantTextCandidateQueues(group, localItem)
      .map((queue) => ({
        queue,
        candidate: peekAssistantTextCandidate(queue, localItem),
      }))
      .filter(
        (
          entry,
        ): entry is {
          queue: AssistantTextCandidateQueue;
          candidate: AssistantTextCandidate;
        } => entry.candidate !== undefined,
      )
      .sort(
        (left, right) =>
          left.candidate.snapshotIndex - right.candidate.snapshotIndex,
      )[0];
    if (!match) return true;
    consumeAssistantTextCandidate(match.queue, match.candidate);
    return false;
  });
}

export interface AssistantTextCandidate {
  item: RuntimeConversationItem;
  queueIndex: number;
  snapshotIndex: number;
}

export interface AssistantTextCandidateQueue {
  candidates: AssistantTextCandidate[];
  cursor: number;
  consumedIndexes: Set<number>;
}

export interface AssistantTextCandidateGroup {
  assistantText: AssistantTextCandidateQueue;
  textBlock: AssistantTextCandidateQueue;
}

export function createAssistantTextCandidateGroup(): AssistantTextCandidateGroup {
  const queue = (): AssistantTextCandidateQueue => ({
    candidates: [],
    cursor: 0,
    consumedIndexes: new Set(),
  });
  return { assistantText: queue(), textBlock: queue() };
}

export function assistantTextCandidateQueue(
  group: AssistantTextCandidateGroup,
  item: RuntimeConversationItem,
): AssistantTextCandidateQueue {
  return item.type === "assistant_text" ? group.assistantText : group.textBlock;
}

export function assistantTextCandidateQueues(
  group: AssistantTextCandidateGroup,
  localItem: RuntimeConversationItem,
): AssistantTextCandidateQueue[] {
  return localItem.type === "assistant_text"
    ? [group.assistantText, group.textBlock]
    : [group.assistantText];
}

export function peekAssistantTextCandidate(
  queue: AssistantTextCandidateQueue,
  localItem: RuntimeConversationItem,
): AssistantTextCandidate | undefined {
  while (queue.consumedIndexes.has(queue.cursor)) queue.cursor += 1;
  for (let index = queue.cursor; index < queue.candidates.length; index += 1) {
    if (queue.consumedIndexes.has(index)) continue;
    const candidate = queue.candidates[index];
    if (
      candidate &&
      isEquivalentAssistantTextRepresentation(localItem, candidate.item)
    ) {
      return candidate;
    }
  }
  return undefined;
}

export function consumeAssistantTextCandidate(
  queue: AssistantTextCandidateQueue,
  candidate: AssistantTextCandidate,
): void {
  queue.consumedIndexes.add(candidate.queueIndex);
  while (queue.consumedIndexes.has(queue.cursor)) queue.cursor += 1;
}

export interface RuntimeConversationItemNode {
  item: RuntimeConversationItem;
  previous: RuntimeConversationItemNode | null;
  next: RuntimeConversationItemNode | null;
}

export function insertMissingSnapshotItems(
  localItems: RuntimeConversationItem[],
  snapshotItems: RuntimeConversationItem[],
): RuntimeConversationItem[] {
  const list = runtimeConversationItemList(localItems);
  const initialIds = new Set(list.firstById.keys());
  const nextInitialId = nextInitialSnapshotItemIds(snapshotItems, initialIds);
  let previousSnapshotNode: RuntimeConversationItemNode | null = null;
  snapshotItems.forEach((item, index) => {
    const existing = list.firstById.get(item.id);
    if (existing) {
      previousSnapshotNode = existing;
      return;
    }
    const nextNode = list.firstById.get(nextInitialId[index] ?? "");
    const node = insertRuntimeConversationItemNode(
      list,
      item,
      nextNode ?? null,
      nextNode ? null : (previousSnapshotNode ?? list.tail),
    );
    list.firstById.set(item.id, node);
    previousSnapshotNode = node;
  });
  return runtimeConversationItemsFromList(list.head);
}

export function nextInitialSnapshotItemIds(
  snapshotItems: RuntimeConversationItem[],
  initialIds: Set<string>,
): Array<string | null> {
  const nextIds = Array<string | null>(snapshotItems.length).fill(null);
  let nextId: string | null = null;
  for (let index = snapshotItems.length - 1; index >= 0; index -= 1) {
    nextIds[index] = nextId;
    const id = snapshotItems[index]?.id;
    if (id && initialIds.has(id)) nextId = id;
  }
  return nextIds;
}

export function runtimeConversationItemList(items: RuntimeConversationItem[]): {
  head: RuntimeConversationItemNode | null;
  tail: RuntimeConversationItemNode | null;
  firstById: Map<string, RuntimeConversationItemNode>;
} {
  const list = {
    head: null as RuntimeConversationItemNode | null,
    tail: null as RuntimeConversationItemNode | null,
    firstById: new Map<string, RuntimeConversationItemNode>(),
  };
  items.forEach((item) => {
    const node = insertRuntimeConversationItemNode(list, item, null, list.tail);
    if (!list.firstById.has(item.id)) list.firstById.set(item.id, node);
  });
  return list;
}

export function insertRuntimeConversationItemNode(
  list: {
    head: RuntimeConversationItemNode | null;
    tail: RuntimeConversationItemNode | null;
  },
  item: RuntimeConversationItem,
  before: RuntimeConversationItemNode | null,
  after: RuntimeConversationItemNode | null,
): RuntimeConversationItemNode {
  const previous = before?.previous ?? after;
  const next = before ?? after?.next ?? null;
  const node = { item, previous, next };
  if (previous) previous.next = node;
  else list.head = node;
  if (next) next.previous = node;
  else list.tail = node;
  return node;
}

export function runtimeConversationItemsFromList(
  head: RuntimeConversationItemNode | null,
): RuntimeConversationItem[] {
  const items: RuntimeConversationItem[] = [];
  let node = head;
  while (node) {
    items.push(node.item);
    node = node.next;
  }
  return items;
}

export function isEquivalentAssistantTextRepresentation(
  local: RuntimeConversationItem,
  snapshot: RuntimeConversationItem,
): boolean {
  if (local.id === snapshot.id) return false;
  // Native positions identify distinct output; only provisional items can be aliases.
  if (local.position !== undefined) return false;
  if (local.type === "assistant_text" && snapshot.type === "assistant_text") {
    return local.content === snapshot.content;
  }
  if (local.type === snapshot.type) return false;
  const localContent = assistantTextRepresentationContent(local);
  const snapshotContent = assistantTextRepresentationContent(snapshot);
  return localContent !== undefined && localContent === snapshotContent;
}

export function assistantTextRepresentationContent(
  item: RuntimeConversationItem,
): string | undefined {
  if (item.type === "assistant_text") return item.content;
  return item.type === "block" && item.block.type === "text"
    ? item.block.content
    : undefined;
}

export function mergeRuntimeConversationItem(
  local: RuntimeConversationItem | undefined,
  snapshot: Extract<RuntimeConversationItem, { type: "block" }>,
  preserveLocalTerminal: boolean,
): Extract<RuntimeConversationItem, { type: "block" }>;
export function mergeRuntimeConversationItem(
  local: RuntimeConversationItem | undefined,
  snapshot: RuntimeConversationItem,
  preserveLocalTerminal: boolean,
): RuntimeConversationItem;
export function mergeRuntimeConversationItem(
  local: RuntimeConversationItem | undefined,
  snapshot: RuntimeConversationItem,
  preserveLocalTerminal: boolean,
): RuntimeConversationItem {
  snapshot = { ...snapshot, position: snapshot.position ?? local?.position };
  if (local?.type === "user_message" && snapshot.type === "user_message") {
    return { ...snapshot, message: { ...local.message, ...snapshot.message } };
  }
  if (local?.type !== "block" || snapshot.type !== "block") return snapshot;
  let snapshotBlock = preserveToolOutput(
    local.block,
    preserveRequestUserInputResponse(local.block, snapshot.block),
  );

  if (
    local.block.type === "subagent" &&
    snapshotBlock.type === "subagent" &&
    !(
      local.block.agentThreadId &&
      snapshotBlock.agentThreadId &&
      local.block.agentThreadId !== snapshotBlock.agentThreadId
    )
  ) {
    snapshotBlock = nestWorkbenchProcessingBlocks([
      local.block,
      snapshotBlock,
    ])[0];
  }

  if (
    preserveLocalTerminal &&
    isTerminalProcessingBlockStatus(local.block.status) &&
    !isTerminalProcessingBlockStatus(snapshotBlock.status)
  ) {
    return {
      ...snapshot,
      block: {
        ...snapshotBlock,
        status: local.block.status,
        completedAt: local.block.completedAt,
        durationMs: local.block.durationMs,
      } as ProcessingBlock,
    };
  }

  return {
    ...snapshot,
    block: preserveProcessingBlockTiming(local.block, snapshotBlock),
  };
}

function preserveToolOutput(
  local: ProcessingBlock,
  snapshot: ProcessingBlock,
): ProcessingBlock {
  if (
    local.type !== "tool" ||
    snapshot.type !== "tool" ||
    local.toolName !== snapshot.toolName
  )
    return snapshot;
  const previous = local.toolOutput;
  const incoming = snapshot.toolOutput;
  if (previous === undefined || previous === null || previous === "")
    return snapshot;
  const missingOutput =
    incoming === undefined || incoming === null || incoming === "";
  const partialCommandOutput =
    commandExecutionPayload(local) &&
    commandExecutionPayload(snapshot)?.status === "inProgress" &&
    typeof previous === "string" &&
    typeof incoming === "string" &&
    previous.startsWith(incoming);
  if (!missingOutput && !partialCommandOutput) return snapshot;
  return {
    ...snapshot,
    toolOutput: previous,
    toolOutputTruncated: local.toolOutputTruncated,
    toolOutputOriginalBytes: local.toolOutputOriginalBytes,
    toolOutputOriginalChars: local.toolOutputOriginalChars,
    toolOutputLoadRef: local.toolOutputLoadRef,
  };
}

export function isTerminalProcessingBlockStatus(
  status: ProcessingBlock["status"],
): boolean {
  return status === "done" || status === "error";
}
