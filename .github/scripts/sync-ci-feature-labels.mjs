import { readFileSync } from "node:fs";

const { features } = JSON.parse(
  readFileSync(new URL("../ci/features.json", import.meta.url), "utf8"),
);
const labels = Object.entries(features).map(([name, feature]) => ({
  name: feature.label,
  color: "1d76db",
  description: `Select the ${name} CI feature suite`,
}));
labels.push(
  {
    name: "ci:all",
    color: "b60205",
    description: "Run complete registered CI regression coverage",
  },
  {
    name: "ci:windows",
    color: "5319e7",
    description:
      "Add registered Windows Core coverage for the selected features",
  },
  {
    name: "ci:macos",
    color: "5319e7",
    description: "Add the existing macOS Inspector gate for desktop features",
  },
);
for (const label of labels) {
  const url = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/labels`;
  const headers = {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
  const current = await fetch(`${url}/${encodeURIComponent(label.name)}`, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  if (current.ok) {
    const value = await current.json();
    if (value.description === label.description && value.color === label.color)
      continue;
  } else if (current.status !== 404) {
    throw new Error(`Cannot read ${label.name}: HTTP ${current.status}`);
  }
  const response = await fetch(
    current.ok ? `${url}/${encodeURIComponent(label.name)}` : url,
    {
      method: current.ok ? "PATCH" : "POST",
      headers,
      body: JSON.stringify(label),
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok)
    throw new Error(
      `Cannot synchronize ${label.name}: HTTP ${response.status}`,
    );
  console.log(`Synchronized ${label.name}`);
}
