import type { ProcessingDisplayRow } from "./toolBlockActivity";
import type { ProcessingBlock } from "./types";

/**
 * Identity of every disclosure a reader can open inside one message.
 *
 * A key is the scope of the message plus the id of the item that owns the disclosure.
 * The scope is the message identity alone (a section rendered without one owns its
 * disclosures for its own lifetime): process sections are derived from the answer while it
 * streams — segment indexes, ordered-timeline coordinates, filtered blocks — so any
 * position in a key changes under the reader and silently drops what they opened.
 */
export function messageDisclosureKey(
  scope: string | undefined,
  name: string,
): string | undefined {
  return scope ? `${scope}:${name}` : undefined;
}

export function processingSummaryDisclosureKey(
  scope: string | undefined,
  anchorBlockId: string | undefined,
): string | undefined {
  return scope && anchorBlockId
    ? `${scope}:process:${anchorBlockId}`
    : undefined;
}

export function processingBlockDisclosureKey(
  scope: string | undefined,
  blockId: string | undefined,
): string | undefined {
  return scope && blockId ? `${scope}:block:${blockId}` : undefined;
}

export function processingBlockFileDisclosureKey(
  scope: string | undefined,
  blockId: string | undefined,
): string | undefined {
  return scope && blockId ? `${scope}:block:${blockId}:file` : undefined;
}

/**
 * Every disclosure the given rows can own, so a container can ask the store whether the
 * reader has something open inside it.
 */
export function getRowDisclosureKeys(
  scope: string | undefined,
  rows: readonly ProcessingDisplayRow[],
): string[] {
  const keys: Array<string | undefined> = [];
  rows.forEach((row) => {
    const blocks: ProcessingBlock[] =
      row.type === "activity_group" ? row.blocks : [row.block];
    blocks.forEach((block) => {
      keys.push(processingBlockDisclosureKey(scope, block.id));
      if (block.type === "file_changes") {
        keys.push(processingBlockFileDisclosureKey(scope, block.id));
      }
    });
  });
  return keys.filter((key): key is string => key !== undefined);
}
