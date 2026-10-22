import { useRef, useState } from "react";
import type {
  RequestUserInputPayload,
  RequestUserInputResponse,
} from "@wegent/chat-core/runtime";
import { useConversationTranslation } from "./ConversationTranslation";
import { useMarkdownServices } from "../markdown/MarkdownServices";

export interface McpUrlAuthorizationCardProps {
  payload: RequestUserInputPayload;
  disabled?: boolean;
  onSubmit?: (
    response: RequestUserInputResponse,
  ) => boolean | void | Promise<boolean | void>;
  onOpenAuthorizationUrl?: (url: string) => void | boolean | Promise<unknown>;
}

export function McpUrlAuthorizationCard({
  payload,
  disabled,
  onSubmit,
  onOpenAuthorizationUrl,
}: McpUrlAuthorizationCardProps) {
  const { t } = useConversationTranslation();
  const { openExternalUrl, openAuthorizationUrl } = useMarkdownServices();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState(false);
  const url = authorizationUrl(payload.url);
  const isDisabled = disabled || pending || submitted || !onSubmit;

  const respond = async (action: "accept" | "cancel") => {
    if (isDisabled || inFlight.current || !onSubmit) return;
    inFlight.current = true;
    setPending(true);
    setError(false);
    try {
      if (action === "accept") {
        if (!url) throw new Error("Invalid authorization URL");
        const opened = await (
          onOpenAuthorizationUrl ??
          openAuthorizationUrl ??
          openExternalUrl
        )(url.href);
        if (opened === false) throw new Error("Browser did not open");
      }
      const accepted = await onSubmit({
        requestId: payload.requestId ?? payload.request_id,
        itemId: payload.itemId ?? payload.item_id,
        answers: { __mcp_url: { answers: [action] } },
      });
      if (accepted === false) setError(true);
      else setSubmitted(true);
    } catch {
      // Never expose the authorization URL or its secret query parameters in errors.
      setError(true);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <div
      data-testid="request-user-input-card"
      className="mx-auto w-full max-w-2xl rounded-2xl border border-border/70 bg-base p-3 shadow-sm"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        void respond("cancel");
      }}
    >
      <div
        data-testid="mcp-url-authorization-card"
        className="flex flex-col gap-2"
      >
        <div className="text-sm font-medium text-text-primary">
          {t("request_user_input.url_title", {
            server: payload.serverName ?? "MCP",
          })}
        </div>
        <p className="whitespace-pre-wrap text-sm text-text-secondary">
          {payload.message}
        </p>
        <p className="text-sm text-text-secondary">
          {t("request_user_input.url_destination", { host: url?.host ?? "" })}
        </p>
        <p className="text-sm text-text-muted">
          {t("request_user_input.url_hint")}
        </p>
        {error || !url ? (
          <p role="alert" className="text-sm text-error">
            {t("request_user_input.url_failed")}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid="mcp-url-authorization-cancel"
            disabled={isDisabled}
            onClick={() => void respond("cancel")}
            className="h-11 rounded-lg px-3 text-sm text-text-secondary hover:bg-muted disabled:opacity-40 md:h-8"
          >
            {t("request_user_input.ignore")}
          </button>
          <button
            type="button"
            data-testid="mcp-url-authorization-open"
            disabled={isDisabled || !url}
            onClick={() => void respond("accept")}
            className="h-11 rounded-lg bg-text-primary px-3 text-sm text-background hover:opacity-80 disabled:opacity-40 md:h-8"
          >
            {t("request_user_input.url_open")}
          </button>
        </div>
      </div>
    </div>
  );
}

function authorizationUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return !url.username &&
      !url.password &&
      (url.protocol === "https:" || (url.protocol === "http:" && loopback))
      ? url
      : null;
  } catch {
    return null;
  }
}
