import { useEffect, useRef, type RefObject } from "react";
import { isImeComposingEvent } from "@wegent/chat-core/ime";

const layers = new Set<RefObject<HTMLElement | null>>();

function topLayer() {
  let top: HTMLElement | null = null;
  for (const ref of layers) {
    const node = ref.current;
    if (!node?.isConnected) continue;
    // Children stay above their parent even when their effects mount first.
    if (!top || !node.contains(top)) top = node;
  }
  return top;
}

export function useEscapeKey(
  onEscape: () => void,
  enabled = true,
  scope?: RefObject<HTMLElement | null>,
) {
  const callback = useRef(onEscape);
  useEffect(() => {
    callback.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!enabled) return;
    if (scope) layers.add(scope);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const top = topLayer();
      if (event.defaultPrevented || isImeComposingEvent(event)) return;
      if (top && top !== scope?.current) return;
      event.preventDefault();
      event.stopPropagation();
      callback.current();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      if (scope) layers.delete(scope);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [enabled, scope]);
}
