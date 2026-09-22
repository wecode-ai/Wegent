import type { IssueMentionGroup } from "./issueCommentMentions";

/**
 * The "@" target list a desktop composer shows above its draft.
 *
 * The comment box and the card reply box share it so one picker serves both,
 * and so a host can style a single popup instead of two look-alikes.
 */
export function IssueCommentMentionPopup({
  groups,
  items,
  activeIndex,
  testId,
  onHover,
  onPick,
}: {
  groups: IssueMentionGroup[];
  items: IssueMentionGroup["items"];
  activeIndex: number;
  testId: string;
  onHover(index: number): void;
  onPick(item: IssueMentionGroup["items"][number]): void;
}) {
  return (
    <div className="issue-comment-mention">
      <div className="issue-comment-mention-popup" data-testid={testId}>
        {groups
          .filter((group) => group.items.length)
          .map((group) => {
            const groupStart = items.findIndex(
              (item) => item === group.items[0],
            );
            return (
              <section key={group.label}>
                <h4>{group.label}</h4>
                {group.items.map((item, itemIndex) => {
                  const flatIndex = groupStart + itemIndex;
                  const active = flatIndex === activeIndex;
                  return (
                    <button
                      type="button"
                      key={item.id}
                      data-testid={
                        item.testId ?? `issue-comment-mention-${item.id}`
                      }
                      data-active={active ? "true" : "false"}
                      aria-selected={active}
                      // Keep the caret in the draft the picker belongs to;
                      // a host that closes its picker on blur must not lose
                      // the click that selects a row.
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => onHover(flatIndex)}
                      onClick={() => onPick(item)}
                    >
                      <span>{item.avatar ?? item.name.slice(0, 1)}</span>
                      {item.name}
                    </button>
                  );
                })}
              </section>
            );
          })}
      </div>
    </div>
  );
}
