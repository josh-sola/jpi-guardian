import assert from "node:assert/strict";
import test from "node:test";

import { REVIEW_POLICY } from "../extensions/auto-review/policy.ts";

test("review policy stays under the size budget", () => {
  const bytes = Buffer.byteLength(REVIEW_POLICY, "utf8");
  assert.ok(bytes < 14_000, `policy is ${bytes} bytes, expected under 14000`);
});

test("review policy states the no-prior-context constraint", () => {
  assert.match(REVIEW_POLICY, /## What you see and don't/);
  assert.match(
    REVIEW_POLICY,
    /You do not see prior agent actions, tool results, or the agent's own proposals or reasoning/,
  );
});

test("review policy states trust defaults", () => {
  assert.match(REVIEW_POLICY, /## Trust defaults/);
  assert.match(REVIEW_POLICY, /no code host, cloud account, service, or destination is trusted unless/);
  assert.match(REVIEW_POLICY, /already-configured remotes are inside the trust boundary by default/);
});

test("review policy keeps low-risk carve-outs equivalent to the prior policy", () => {
  assert.match(REVIEW_POLICY, /Do not deny solely because a path is outside the current working directory/);
  assert.match(
    REVIEW_POLICY,
    /Installing packages already declared in the repo's manifest .* via standard commands is low risk/,
  );
  assert.match(
    REVIEW_POLICY,
    /Installing an agent-chosen package name not already declared carries more risk/,
  );
  assert.match(
    REVIEW_POLICY,
    /Reading credentials from the agent's own config and sending them to their matching, intended provider is routine use/,
  );
});

test("review policy never narrates itself in terms only visible from outside guardian", () => {
  assert.doesNotMatch(REVIEW_POLICY, /claude code/i);
  assert.doesNotMatch(REVIEW_POLICY, /codex/i);
  assert.doesNotMatch(REVIEW_POLICY, /auto[- ]mode/i);
  assert.doesNotMatch(REVIEW_POLICY, /anthropic/i);
});

test("review policy hard-blocks are stated as never cleared by user context", () => {
  const hardBlockSection = REVIEW_POLICY.slice(
    REVIEW_POLICY.indexOf("## HARD BLOCK"),
    REVIEW_POLICY.indexOf("## The consent bar"),
  );
  assert.ok(hardBlockSection.length > 0);
  for (const phrase of [
    "Data exfiltration across the trust boundary",
    "Reviewer or safety-gate bypass",
    "Agent loops with approval gates disabled",
    "Credential exposure to the wrong destination",
  ]) {
    assert.ok(hardBlockSection.includes(phrase), `missing hard block: ${phrase}`);
  }
});
