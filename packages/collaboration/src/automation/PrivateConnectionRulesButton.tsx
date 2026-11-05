import { useState } from "react";
import { ConnectionRuleDialog } from "./ConnectionRuleDialog";
import {
  ConnectionRulesPanel,
  type ConnectionRulesPanelProps,
} from "./ConnectionRulesPanel";
import { DialogForm } from "../controls/DialogForm";

type Props = Pick<
  ConnectionRulesPanelProps,
  "api" | "project" | "translate" | "onOpenIssue"
>;

export function PrivateConnectionRulesButton(props: Props) {
  return (
    <PrivateRulesButton
      key={JSON.stringify([
        props.api.ownerScope,
        props.project.store,
        props.project.id,
      ])}
      {...props}
    />
  );
}

function PrivateRulesButton({ api, project, translate, onOpenIssue }: Props) {
  const [returnFocus, setReturnFocus] = useState<HTMLButtonElement | null>(
    null,
  );
  const title = translate("automation_rules.my_rules", "我的来源规则");
  return (
    <>
      <button
        type="button"
        className="relative z-10 ml-2 min-h-11 rounded-lg border border-border bg-background px-3 text-sm text-text-primary hover:bg-muted md:min-h-8"
        data-testid="private-connection-rules-open"
        onClick={(event) => setReturnFocus(event.currentTarget)}
      >
        {title}
      </button>
      {returnFocus && (
        <ConnectionRuleDialog label={title} returnFocus={returnFocus}>
          <DialogForm
            className="flex min-h-0 flex-col"
            onSubmit={(event) => event.preventDefault()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setReturnFocus(null);
              }
            }}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
              <h2 className="text-sm font-medium">{title}</h2>
              <button
                type="button"
                autoFocus
                data-testid="private-connection-rules-close"
                className="min-h-11 px-2 text-sm md:min-h-8"
                onClick={() => setReturnFocus(null)}
              >
                {translate("common.close", "关闭")}
              </button>
            </div>
            <div
              className="min-h-0 overflow-y-auto px-5 py-4"
              data-testid="private-connection-rules-content"
            >
              <ConnectionRulesPanel
                api={api}
                project={project}
                translate={translate}
                targets={[]}
                canConfigureProject={false}
                className="space-y-3"
                onOpenIssue={
                  onOpenIssue
                    ? async (issueId) => {
                        await onOpenIssue(issueId);
                        setReturnFocus(null);
                      }
                    : undefined
                }
              />
            </div>
          </DialogForm>
        </ConnectionRuleDialog>
      )}
    </>
  );
}
