import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { AtSign, Check, UserRound, Bot, UsersRound } from "lucide-react";
import { useCollaborationPortalTheme } from "../theme";
import type { IssueHomeOwnerOption } from "./issueHomeOwners";
import type { CollaborationTranslate } from "../i18n";

export function IssueOwnerPicker({
  owners,
  value,
  onChange,
  disabled,
  translate,
}: {
  owners: IssueHomeOwnerOption[];
  value: string | null;
  onChange(id: string | null): void;
  disabled: boolean;
  translate: CollaborationTranslate;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const theme = useCollaborationPortalTheme();
  const owner = owners.find((candidate) => candidate.id === value);
  const label = translate("issue_creation.owner", "Assignee");
  const choose = (id: string | null) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };
  const options = [
    {
      id: null,
      name: translate("issue_creation.unassigned", "Unassigned"),
      kind: null,
      testId: "none",
    },
    ...owners
      .filter((member) =>
        member.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
      )
      .map((member) => ({
        id: member.id,
        name: member.title,
        kind: member.owner.kind,
        testId: member.owner.kind === "user" ? member.owner.id : member.id,
      })),
  ];
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          data-testid="collaboration-issue-owner"
          disabled={disabled}
          aria-label={owner ? `${label}: ${owner.title}` : label}
          title={owner ? `${label}: ${owner.title}` : label}
          className="inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-base text-text-secondary hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 md:h-7 md:min-w-7"
        >
          <AtSign aria-hidden="true" className="h-4 w-4 shrink-0" />
          {owner && <span className="max-w-32 truncate">{owner.title}</span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...theme}
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label={label}
          data-testid="collaboration-issue-owner-menu"
          className={`${theme.className ?? ""} z-system-popover w-64 rounded-xl border border-border/70 bg-popover p-1.5 text-text-primary shadow-lg`}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="menuitemradio"]',
              ),
            );
            const current = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              (current +
                (event.key === "ArrowDown" ? 1 : -1) +
                buttons.length) %
              buttons.length;
            buttons[next]?.focus();
            event.preventDefault();
          }}
        >
          <input
            data-testid="collaboration-issue-owner-search"
            aria-label={label}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={translate(
              "issue_creation.search_members",
              "Search members",
            )}
            className="mb-1 w-full rounded-md bg-transparent px-2 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
          <div
            role="menu"
            aria-label={label}
            className="max-h-64 overflow-y-auto"
          >
            {options.map((option, index) => {
              const Icon =
                option.kind === "agent"
                  ? Bot
                  : option.kind === "group"
                    ? UsersRound
                    : UserRound;
              return (
                <div key={option.id ?? "none"}>
                  {option.kind && option.kind !== options[index - 1]?.kind && (
                    <p className="px-2 pb-1 pt-2 text-xs text-text-muted">
                      {translate(`issue_creation.${option.kind}`)}
                    </p>
                  )}
                  <button
                    key={option.id ?? "none"}
                    type="button"
                    role="menuitemradio"
                    aria-checked={option.id === value}
                    data-testid={`collaboration-issue-owner-${option.testId}`}
                    onClick={() => choose(option.id)}
                    className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none md:min-h-8"
                  >
                    <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      {option.name}
                    </span>
                    {option.id === value && (
                      <Check aria-hidden="true" className="h-4 w-4" />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
