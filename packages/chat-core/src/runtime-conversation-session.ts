import type { RuntimeConversationClient } from "./runtime-conversation-client";
import { createRuntimeContextUsageStore } from "./runtime-context-usage";
import type { RuntimeGuidanceAppliedPayload } from "./runtime-stream-types";
import type {
  RequestUserInputResponse,
  RuntimeTaskAddress,
  RuntimeTranscriptRequest,
  RuntimeTurnNavigationItem,
  TurnFileChangesSummary,
  RuntimeContextUsage,
} from "./runtime";
import { applyRequestUserInputResponseToBlock } from "./runtime-user-input";
import type {
  RuntimeConversationTurn,
  WorkbenchMessage,
} from "./runtime-conversation";
import {
  mergeRuntimeConversationTurns,
  projectRuntimeConversationTurns,
  reduceRuntimeConversationTurns,
  appendAcceptedRuntimeConversationUser,
  appendRuntimeConversationGuidance,
} from "./runtime-conversation-turns";
import {
  mergeTranscriptRanges,
  projectRuntimePaneTranscript,
  runtimeTurnNavigationLoadOptions,
  transcriptRangeFromPage,
  type LoadedTranscriptRange,
} from "./runtime-transcript-page";

export interface RuntimeConversationSnapshot {
  turns: RuntimeConversationTurn[];
  messages: WorkbenchMessage[];
  loading: boolean;
  loadingMoreBefore: boolean;
  error: string | null;
  title: string | null;
  runStatus: string | null;
  historyUnavailable: boolean;
  running: boolean | undefined;
  lifecycleRevision: number;
  hasMoreBefore: boolean;
  turnNavigation: RuntimeTurnNavigationItem[];
  loadedTranscriptRanges: LoadedTranscriptRange[];
  contextUsage: RuntimeContextUsage | null;
}

/** One mounted execution viewer. Pure turn reducers and paging rules are shared with desktop. */
export function createRuntimeConversationSession(
  client: RuntimeConversationClient,
  address: RuntimeTaskAddress,
) {
  let snapshot: RuntimeConversationSnapshot = {
    turns: [],
    messages: [],
    loading: true,
    loadingMoreBefore: false,
    error: null,
    title: null,
    runStatus: null,
    historyUnavailable: false,
    running: undefined,
    lifecycleRevision: 0,
    hasMoreBefore: false,
    turnNavigation: [],
    loadedTranscriptRanges: [],
    contextUsage: null,
  };
  let turns: RuntimeConversationTurn[] = [];
  let beforeCursor: string | null = null;
  let fullContent = false;
  let revision = 0;
  let generation = 0;
  let listening = false;
  let cleanup: (() => void) | undefined;
  let connection: Promise<void> | undefined;
  let latestRequest: Promise<void> | undefined;
  let invalidated = false;
  const listeners = new Set<() => void>();
  const guidanceListeners = new Set<
    (payload: RuntimeGuidanceAppliedPayload) => void
  >();
  const requests = new Map<string, Promise<void>>();
  const pageSize = 50;
  const contextUsageStore = createRuntimeContextUsageStore();

  function update(patch: Partial<RuntimeConversationSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  }
  contextUsageStore.subscribe(() =>
    update({ contextUsage: contextUsageStore.getSnapshot() }),
  );
  function publishTurns() {
    update({ turns, messages: projectRuntimeConversationTurns(turns) });
  }

  async function connect() {
    if (cleanup || connection || !listening) return connection;
    const owner = generation;
    const pending = client
      .subscribe(address, {
        onContextUsageUpdated(usage) {
          if (listening && owner === generation)
            contextUsageStore.receiveLive(usage);
        },
        onMessageAction(action) {
          if (!listening || owner !== generation) return;
          revision += 1;
          turns = reduceRuntimeConversationTurns(turns, action);
          publishTurns();
        },
        onAssistantStart() {
          if (listening && owner === generation) {
            revision += 1;
            update({
              running: true,
              runStatus: "running",
              lifecycleRevision: snapshot.lifecycleRevision + 1,
            });
          }
        },
        onAssistantSettled(_turnId, outcome) {
          if (listening && owner === generation) {
            revision += 1;
            update({
              running: false,
              runStatus: outcome,
              lifecycleRevision: snapshot.lifecycleRevision + 1,
            });
          }
        },
        onRuntimeTaskTitleUpdated(payload) {
          if (listening && owner === generation) {
            revision += 1;
            update({ title: payload.title });
          }
        },
        onGuidanceApplied(payload) {
          if (listening && owner === generation) {
            guidanceListeners.forEach((listener) => listener(payload));
            invalidateHistory();
          }
        },
        onHistoryInvalidated() {
          if (listening && owner === generation) invalidateHistory();
        },
      })
      .then((unsubscribe) => {
        if (!listening || owner !== generation) unsubscribe();
        else cleanup = unsubscribe;
      })
      .finally(() => {
        if (connection === pending) connection = undefined;
      });
    connection = pending;
    return pending;
  }

  async function loadPage(
    options: Omit<RuntimeTranscriptRequest, keyof RuntimeTaskAddress>,
    latest: boolean,
  ) {
    const owner = generation;
    const requestedRevision = revision;
    const usageRevision = contextUsageStore.getRevision();
    const response = await client.getTranscript({ ...address, ...options });
    if (!listening || owner !== generation) return;
    const page = projectRuntimePaneTranscript(response);
    turns = mergeRuntimeConversationTurns(turns, page.turns);
    const incomingRanges = transcriptRangeFromPage(page);
    const earlierPage =
      options.beforeCursor !== undefined &&
      (!snapshot.loadedTranscriptRanges.length ||
        (incomingRanges[0]?.start ?? Infinity) <
          snapshot.loadedTranscriptRanges[0].start);
    const updatesFirstPage = Boolean(
      (latest && !snapshot.loadedTranscriptRanges.length) ||
      earlierPage ||
      page.fullContent,
    );
    if (updatesFirstPage) {
      beforeCursor = page.beforeCursor ?? null;
    }
    fullContent = fullContent || page.fullContent === true;
    const patch: Partial<RuntimeConversationSnapshot> = {
      turns,
      messages: projectRuntimeConversationTurns(turns),
      loadedTranscriptRanges: mergeTranscriptRanges(
        snapshot.loadedTranscriptRanges,
        incomingRanges,
      ),
      turnNavigation: page.turnNavigation?.length
        ? page.turnNavigation
        : snapshot.turnNavigation,
      hasMoreBefore:
        !fullContent &&
        (updatesFirstPage
          ? Boolean(beforeCursor || page.hasMoreBefore)
          : snapshot.hasMoreBefore),
      error: null,
    };
    if (latest) {
      contextUsageStore.receiveTranscript(response.contextUsage, usageRevision);
      if (revision === requestedRevision) {
        patch.title = response.title ?? snapshot.title;
        patch.running = page.running;
        patch.historyUnavailable = page.historyUnavailable === true;
        const lastTurn = page.turns.at(-1);
        patch.runStatus = page.running
          ? "running"
          : lastTurn?.status === "failed"
            ? "failed"
            : lastTurn?.status === "cancelled"
              ? "cancelled"
              : page.running === false && lastTurn?.status === "done"
                ? "succeeded"
                : page.running === false
                  ? "unknown"
                  : snapshot.runStatus;
      }
    }
    update(patch);
  }

  function reportError(cause: unknown) {
    update({ error: cause instanceof Error ? cause.message : String(cause) });
  }

  function reload(): Promise<void> {
    if (!listening) return Promise.resolve();
    if (latestRequest) return latestRequest;
    const owner = generation;
    update({ loading: true, error: null });
    const pending = (async () => {
      try {
        await connect();
        if (!listening || owner !== generation) return;
        await loadPage({ limit: pageSize, refresh: true }, true);
      } catch (cause) {
        if (listening && owner === generation) reportError(cause);
      } finally {
        if (owner === generation) latestRequest = undefined;
        if (listening && owner === generation) {
          update({ loading: false });
          if (invalidated) {
            invalidated = false;
            void reload();
          }
        }
      }
    })();
    latestRequest = pending;
    return pending;
  }

  function invalidateHistory() {
    if (latestRequest) invalidated = true;
    else void reload();
  }

  function loadHistory(
    options: Omit<RuntimeTranscriptRequest, keyof RuntimeTaskAddress>,
  ): Promise<void> {
    if (!listening || fullContent) return Promise.resolve();
    const key = JSON.stringify(options);
    const previous = requests.get(key);
    if (previous) return previous;
    const owner = generation;
    const pending = loadPage(options, false)
      .catch((cause) => {
        if (listening && owner === generation) reportError(cause);
      })
      .finally(() => {
        if (requests.get(key) === pending) requests.delete(key);
      });
    requests.set(key, pending);
    return pending;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (listening) return;
      listening = true;
      generation += 1;
      void reload();
    },
    stop() {
      listening = false;
      generation += 1;
      cleanup?.();
      cleanup = undefined;
      connection = undefined;
      latestRequest = undefined;
      invalidated = false;
      requests.clear();
      update({ loadingMoreBefore: false });
    },
    reload,
    subscribeGuidance(
      listener: (payload: RuntimeGuidanceAppliedPayload) => void,
    ) {
      guidanceListeners.add(listener);
      return () => {
        guidanceListeners.delete(listener);
      };
    },
    acceptUserMessage(
      message: WorkbenchMessage & { role: "user" },
      turnIdsBeforeSend: ReadonlySet<string>,
      turnId?: string | null,
    ) {
      revision += 1;
      turns = appendAcceptedRuntimeConversationUser(
        turns,
        message,
        turnId ?? null,
        turnIdsBeforeSend,
      );
      publishTurns();
    },
    applyGuidance(
      message: WorkbenchMessage & { role: "user"; runtimeGuidance: true },
      turnId?: string,
    ) {
      revision += 1;
      turns =
        turnId && turns.some((turn) => turn.id === turnId)
          ? appendRuntimeConversationGuidance(turns, turnId, message)
          : reduceRuntimeConversationTurns(turns, {
              type: "user_added",
              message,
            });
      publishTurns();
    },
    addUserMessage(message: WorkbenchMessage & { role: "user" }) {
      revision += 1;
      turns = reduceRuntimeConversationTurns(turns, {
        type: "user_added",
        message,
      });
      publishTurns();
    },
    removeUserMessage(clientUserMessageId: string) {
      revision += 1;
      turns = turns.filter(
        (turn) =>
          turn.clientUserMessageId !== clientUserMessageId &&
          !turn.items.some(
            (item) =>
              item.type === "user_message" && item.id === clientUserMessageId,
          ),
      );
      publishTurns();
    },
    applyFileChanges(subtaskId: string, fileChanges: TurnFileChangesSummary) {
      revision += 1;
      turns = reduceRuntimeConversationTurns(turns, {
        type: "file_changes_updated",
        subtaskId,
        fileChanges,
      });
      publishTurns();
    },
    applyUserInputResponse(response: RequestUserInputResponse) {
      revision += 1;
      turns = turns.map((turn) => ({
        ...turn,
        items: turn.items.map((item) =>
          item.type === "block"
            ? {
                ...item,
                block: applyRequestUserInputResponseToBlock(
                  item.block,
                  response,
                ),
              }
            : item,
        ),
      }));
      publishTurns();
    },
    async loadMoreBefore() {
      if (!beforeCursor || snapshot.loadingMoreBefore || fullContent) return;
      const owner = generation;
      update({ loadingMoreBefore: true });
      try {
        await loadHistory({ limit: pageSize, beforeCursor });
      } finally {
        if (listening && owner === generation)
          update({ loadingMoreBefore: false });
      }
    },
    loadTurn(item: RuntimeTurnNavigationItem) {
      if (
        !item.cursor ||
        snapshot.messages.some((message) => message.id === item.id)
      )
        return Promise.resolve();
      return loadHistory(
        runtimeTurnNavigationLoadOptions(
          item,
          snapshot.loadedTranscriptRanges,
          pageSize,
        ),
      );
    },
    loadGap(gap: LoadedTranscriptRange) {
      if (gap.end <= gap.start) return Promise.resolve();
      return loadHistory({
        limit: Math.min(pageSize, gap.end - gap.start),
        afterCursor: `offset:${gap.start}`,
      });
    },
  };
}
