import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDirectory } from "jpi-base";

import { REVIEW_POLICY } from "./policy.ts";

export const GUARDIAN_PROMPT_FILENAME = "GUARDIAN.md";

export function getGuardianPromptPath(env?: NodeJS.ProcessEnv, homeDirectory?: string): string {
  return join(getAgentDirectory(env, homeDirectory), GUARDIAN_PROMPT_FILENAME);
}

// The exclusive-create flag makes the missing-file check and the write
// atomic, so a file that already exists is never touched.
export async function seedIfMissing(targetPath: string, defaultContent: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  try {
    await writeFile(targetPath, defaultContent, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
    throw err;
  }
}

export function buildSystemPrompt(basePrompt: string, policy: string[]): string {
  if (policy.length === 0) return basePrompt;
  return `${basePrompt}\n\nAdditional trusted reviewer instructions:\n${policy.map((line) => `- ${line}`).join("\n")}`;
}

export type PromptNotifier = (message: string, level: "warning") => void;

// Re-seeding here (on top of the session-start seed) means a file deleted
// mid-session comes back before the next review reads it.
export async function loadGuardianPromptBase(
  promptPath: string,
  notify?: PromptNotifier,
): Promise<string> {
  try {
    await seedIfMissing(promptPath, REVIEW_POLICY);
    return await readFile(promptPath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    notify?.(
      `Guardian: failed to load ${promptPath} (${message}); using the built-in review policy.`,
      "warning",
    );
    return REVIEW_POLICY;
  }
}
