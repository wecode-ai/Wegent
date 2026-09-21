import { useEffect, useRef } from "react";
import type {
  IssueMentionGroup,
  IssueMentionOption,
} from "./issueCommentMentions";

/**
 * The "@" target list shared by the issue comment and reply composers.
 *
 * The popup floats above the composer that owns it, so it never covers the
 * draft the user is typing in.
 */
export function IssueMentionPopup({
  groups,
  highlightedId,
  testId,
  onHighlight,
  onPick,
}: {
  groups: IssueMentionGroup[];
  highlightedId: string | null;
  testId: string;
  onHighlight?(id: string): void;
  onPick(mention: IssueMentionOption): void;
}) {
  const list = useRef<HTMLDivElement>(null);

  // Keyboard navigation must keep the highlighted row visible.
  useEffect(() => {
    const row = list.current?.querySelector('[aria-selected="true"]');
    row?.scrollIntoView?.({ block: "nearest" });
  }, [highlightedId]);

  return (
    <div className="issue-comment-mention">
      <div
        ref={list}
        className="issue-comment-mention-popup"
        role="listbox"
        data-testid={testId}
      >
        {groups.map((group) => (
          <section key={group.label}>
            <h4>{group.label}</h4>
            {group.items.map((item) => {
              const highlighted = item.id === highlightedId;
              return (
                <button
                  type="button"
                  key={item.id}
                  role="option"
                  data-testid={
                    item.testId ?? `issue-comment-mention-${item.id}`
                  }
                  aria-selected={highlighted}
                  className={highlighted ? "is-highlighted" : undefined}
                  // Keep the caret in the textarea while the popup is clicked.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => onHighlight?.(item.id)}
                  onClick={() => {
                    if (item.mention) onPick(item.mention);
                  }}
                >
                  <span>{item.avatar ?? item.name.slice(0, 1)}</span>
                  {item.name}
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
