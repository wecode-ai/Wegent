// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";

interface ResourceAuthorizationMessages {
  authorize: string;
  chooseAgent: string;
  chooseEnvironment: string;
  noCandidates: string;
  operationFailed: string;
}

export function ResourceAuthorizationForm<
  T extends { id: string; name: string },
>({
  kind,
  candidates,
  messages,
  getValue,
  onAuthorize,
}: {
  kind: "agent" | "environment";
  candidates: T[];
  messages: ResourceAuthorizationMessages;
  getValue(resource: T): string;
  onAuthorize(resource: T): Promise<unknown>;
}) {
  const [resourceId, setResourceId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = candidates.find(
    (candidate) => getValue(candidate) === resourceId,
  );
  const prefix =
    kind === "agent"
      ? "collaboration-workspace-agent"
      : "collaboration-workspace-environment";

  return (
    <div className="collaboration-resource-authorization">
      <select
        aria-label={
          kind === "agent" ? messages.chooseAgent : messages.chooseEnvironment
        }
        data-testid={`${prefix}-candidate`}
        value={resourceId}
        onChange={(event) => setResourceId(event.target.value)}
      >
        <option value="">
          {candidates.length
            ? kind === "agent"
              ? messages.chooseAgent
              : messages.chooseEnvironment
            : messages.noCandidates}
        </option>
        {candidates.map((candidate) => (
          <option key={candidate.id} value={getValue(candidate)}>
            {candidate.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="collaboration-primary-button"
        data-testid={`${prefix}-authorize`}
        disabled={!selected || saving}
        onClick={() => {
          if (!selected) return;
          setSaving(true);
          setError(null);
          void onAuthorize(selected)
            .then(() => setResourceId(""))
            .catch(() => setError(messages.operationFailed))
            .finally(() => setSaving(false));
        }}
      >
        {messages.authorize}
      </button>
      {error ? (
        <div className="collaboration-alert" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
