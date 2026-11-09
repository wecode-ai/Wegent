interface OrderedEntryNode<T> {
  item: T;
  previous: OrderedEntryNode<T> | null;
  next: OrderedEntryNode<T> | null;
}

export function insertMissingOrderedEntries<T extends { id: string }>(
  localItems: T[],
  snapshotItems: T[],
): T[] {
  const list = orderedEntryList(localItems);
  const initialIds = new Set(list.firstById.keys());
  const nextInitialId = nextInitialEntryIds(snapshotItems, initialIds);
  let previousSnapshotNode: OrderedEntryNode<T> | null = null;
  snapshotItems.forEach((item, index) => {
    const existing = list.firstById.get(item.id);
    if (existing) {
      previousSnapshotNode = existing;
      return;
    }
    const nextNode = list.firstById.get(nextInitialId[index] ?? "");
    const node = insertOrderedEntryNode<T>(
      list,
      item,
      nextNode ?? null,
      nextNode ? null : (previousSnapshotNode ?? list.tail),
    );
    list.firstById.set(item.id, node);
    previousSnapshotNode = node;
  });
  return orderedEntriesFromList(list.head);
}

function nextInitialEntryIds<T extends { id: string }>(
  snapshotItems: T[],
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

function orderedEntryList<T extends { id: string }>(
  items: T[],
): {
  head: OrderedEntryNode<T> | null;
  tail: OrderedEntryNode<T> | null;
  firstById: Map<string, OrderedEntryNode<T>>;
} {
  const list = {
    head: null as OrderedEntryNode<T> | null,
    tail: null as OrderedEntryNode<T> | null,
    firstById: new Map<string, OrderedEntryNode<T>>(),
  };
  items.forEach((item) => {
    const node = insertOrderedEntryNode<T>(list, item, null, list.tail);
    if (!list.firstById.has(item.id)) list.firstById.set(item.id, node);
  });
  return list;
}

function insertOrderedEntryNode<T>(
  list: {
    head: OrderedEntryNode<T> | null;
    tail: OrderedEntryNode<T> | null;
  },
  item: T,
  before: OrderedEntryNode<T> | null,
  after: OrderedEntryNode<T> | null,
): OrderedEntryNode<T> {
  const previous = before?.previous ?? after;
  const next = before ?? after?.next ?? null;
  const node = { item, previous, next };
  if (previous) previous.next = node;
  else list.head = node;
  if (next) next.previous = node;
  else list.tail = node;
  return node;
}

function orderedEntriesFromList<T extends { id: string }>(
  head: OrderedEntryNode<T> | null,
): T[] {
  const items: T[] = [];
  let node = head;
  while (node) {
    items.push(node.item);
    node = node.next;
  }
  return items;
}
