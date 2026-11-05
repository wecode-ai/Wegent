import type {
  RuntimeConversationItem,
  RuntimeConversationTurn,
} from "./runtime-conversation";

function metadata(
  item: RuntimeConversationItem,
  identities: Map<string, number>,
) {
  const createdAt =
    item.type === "block"
      ? item.block.createdAt
      : item.type === "assistant_text"
        ? item.createdAt
        : undefined;
  return {
    id: item.id.slice(0, 128),
    idTruncated: item.id.length > 128 || undefined,
    identityIndex: item.id.length > 128 ? identities.get(item.id) : undefined,
    type: item.type,
    position: item.position,
    createdAt:
      typeof createdAt === "string" ? createdAt.slice(0, 48) : createdAt,
  };
}

/** Keep the first changed window inside the desktop's 2,000-character argument budget. */
export function transcriptOrderDiagnostic(
  previous: RuntimeConversationTurn,
  current: RuntimeConversationTurn,
  page: RuntimeConversationItem[],
): string | undefined {
  const existing = new Set(previous.items.map((item) => item.id));
  const incoming = new Set(current.items.map((item) => item.id));
  const before = previous.items.filter((item) => incoming.has(item.id));
  const after = current.items.filter((item) => existing.has(item.id));
  // Full-ID indexes distinguish clipped labels without logging more identifier data.
  const identities = new Map(before.map((item, index) => [item.id, index]));
  const describe = (item: RuntimeConversationItem) =>
    metadata(item, identities);
  const offset = before.findIndex(
    (item, index) => item.id !== after[index]?.id,
  );
  if (offset < 0) return undefined;
  for (let size = 4; size >= 1; size -= 1) {
    const beforeWindow = before.slice(offset, offset + size);
    const afterWindow = after.slice(offset, offset + size);
    const selected = new Set(
      [...beforeWindow, ...afterWindow].map((item) => item.id),
    );
    const evidence = JSON.stringify({
      turnId: current.id?.slice(0, 128) ?? null,
      total: before.length,
      offset,
      before: beforeWindow.map(describe),
      after: afterWindow.map(describe),
      page: page
        .filter((item) => selected.has(item.id))
        .slice(0, size * 2)
        .map(describe),
    });
    if (evidence.length <= 1900) return evidence;
  }
  return undefined;
}
