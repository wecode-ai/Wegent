import { useMemo, useRef, useState } from "react";
import {
  issueMentionPayload,
  sameIssueMention,
  type IssueMentionGroup,
  type IssueMentionOption,
} from "./issueCommentMentions";

/**
 * The "@" picker state a composer drives: which list is open, which row is
 * highlighted, and which targets the draft being written picked.
 *
 * The picker only knows the groups it was given and the targets remembered
 * through {@link UseIssueMentionPicker.remember}; the composer owns the draft,
 * so insertion and submission stay with it.
 */
export function useIssueMentionPicker(mentionGroups?: IssueMentionGroup[]) {
  const groups = useMemo(() => mentionGroups ?? [], [mentionGroups]);
  const items = useMemo(
    () => groups.flatMap((group) => group.items),
    [groups],
  );
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  // Keys move the highlight and insert in the same event, before React has
  // re-rendered the state the previous key wrote.
  const activeIndexRef = useRef(0);
  const picked = useRef<IssueMentionOption[]>([]);

  function highlight(index: number) {
    activeIndexRef.current = index;
    setActiveIndex(index);
  }

  return {
    open,
    groups,
    items,
    activeIndex,
    /** Show the list with its first row highlighted. */
    openMenu() {
      highlight(0);
      setOpen(true);
    },
    closeMenu() {
      setOpen(false);
    },
    highlight,
    /** Walk the list, wrapping at both ends. */
    move(delta: number) {
      if (!items.length) return;
      highlight((activeIndexRef.current + delta + items.length) % items.length);
    },
    /** The row Enter or Tab inserts. */
    active() {
      return items[activeIndexRef.current] ?? items[0];
    },
    /** Remember a target the composer just wrote into the draft. */
    remember(option?: IssueMentionOption) {
      if (!option) return;
      picked.current = [
        ...picked.current.filter((current) => !sameIssueMention(current, option)),
        option,
      ];
    },
    /** The targets the submitted draft still mentions. */
    mentionsFor(draft: string) {
      return issueMentionPayload(draft, picked.current);
    },
  };
}

export type IssueMentionPicker = ReturnType<typeof useIssueMentionPicker>;
