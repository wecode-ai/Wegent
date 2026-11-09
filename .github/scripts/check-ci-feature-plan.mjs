import {
  assertCurrentPlan,
  readCurrentPullRequest,
} from "./ci-feature-plan.mjs";

const plan = JSON.parse(process.env.CI_FEATURE_PLAN);
if (plan.errors.length) throw new Error(plan.errors.join("\n"));
if (plan.event === "pull_request") {
  const current = await readCurrentPullRequest(
    process.env.PR_NUMBER,
    process.env.GITHUB_TOKEN,
  );
  assertCurrentPlan(plan, current);
}
console.log(`CI feature coverage and current plan verified: ${plan.hash}`);
