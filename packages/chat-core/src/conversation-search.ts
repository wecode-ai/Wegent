/** All search offsets are half-open UTF-16 positions in the original visible prose. */
export interface ConversationTextRange {
  start: number;
  end: number;
}

export interface ConversationSearchSource extends ConversationTextRange {
  itemId: string;
  sourceStart: number;
  sourceEnd: number;
}

export interface ConversationSearchRegion {
  id: string;
  text: string;
  sources: ConversationSearchSource[];
}

function foldedText(text: string) {
  let value = "";
  const boundaries = new Map<number, number>([[0, 0]]);
  let originalOffset = 0;
  for (const scalar of text) {
    value += scalar.toLowerCase();
    originalOffset += scalar.length;
    boundaries.set(value.length, originalOffset);
  }
  return { value, boundaries };
}

/** Case-insensitive literal matching never slices a scalar's lowercase expansion. */
export function matchConversationText(
  text: string,
  query: string,
): ConversationTextRange[] {
  const needle = foldedText(query.trim()).value;
  if (!needle) return [];
  const folded = foldedText(text);
  const matches: ConversationTextRange[] = [];
  let offset = 0;
  while (offset <= folded.value.length - needle.length) {
    const found = folded.value.indexOf(needle, offset);
    if (found < 0) break;
    const start = folded.boundaries.get(found);
    const end = folded.boundaries.get(found + needle.length);
    if (start !== undefined && end !== undefined) {
      matches.push({ start, end });
      offset = found + needle.length;
    } else {
      offset = found + 1;
    }
  }
  return matches;
}
