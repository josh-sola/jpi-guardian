# jpi-guardian

A Pi coding-agent plugin that reviews risky tool calls before they run.

## What it does

The `auto-review` extension sits in front of every tool call Pi's agent
makes. Before a non-allowlisted call runs, it sends the call (tool name,
arguments, current directory, and a bounded slice of recent user messages) to
a separate reviewer model and asks for a single allow-or-deny decision. A
denial blocks the call and tells the agent not to work around it; three
denials in a row without an approved call in between stop the run so the
agent asks the user instead of retrying.

The reviewer follows a bundled policy covering data exfiltration, credential
probing, security weakening, and destructive or hard-to-reverse actions, with
rules for resolving low-risk exceptions and treating omitted or truncated
context as something that can never grant authorization on its own. You can
add trusted, environment-specific rules on top of it without replacing it.

Calls listed in `allow.tools`, or bash commands matching a pattern in
`allow.bash`, skip the reviewer entirely. Once a call passes review, its
arguments are frozen so nothing downstream can change what actually runs.

Reviewer failures (timeouts, errors, bad output) count separately from
denials and fail closed: the agent gets one retry, then the run stops.

Run `/auto-review status` in a Pi session to see whether the gate is on, and
`/auto-review on`, `/auto-review off`, or `/auto-review reload` to control it
for the current session.

## Install

```
pi install git:github.com/josh-sola/jpi-guardian
```

## Config

Auto-review reads its config from `${PI_CODING_AGENT_DIR:-~/.pi/agent}/review.json`.
It ignores project-local config on purpose. Copy `review.example.json` from
this repo to that path and edit it:

```json
{
  "model": "openai-codex/gpt-5.4-mini",
  "enabled": true,
  "allow": {
    "tools": ["read", "find", "grep", "ls"],
    "bash": ["^npm test$", "^git status --short$"]
  },
  "policy": [
    "Allow routine repository inspection and focused validation commands.",
    "Deny commands that publish code, secrets, or artifacts outside trusted destinations unless the user was explicit."
  ],
  "timeoutMs": 10000
}
```

Set `model` to the reviewer model Pi should call. Keep `allow.tools` and
`allow.bash` small: `allow.bash` entries are regular expressions that must
match the whole command, so anchor them (for example `^npm test$`). `enabled`
defaults to `true`. `policy` adds trusted rules on top of the bundled policy;
it does not replace it.

## Development

```sh
npm install
npm test
```

`npm install` also pulls in `jpi-base`, the shared config-loading library for
this plugin family, and the `@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent`
peer packages.

To try a local checkout inside a real Pi session:

```sh
pi -e .
```
