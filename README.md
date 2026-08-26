# jpi-guardian

A Pi coding-agent plugin that reviews risky tool calls before they run.

## What it does

The `auto-review` extension sits in front of every tool call Pi's agent
makes. Before a non-allowlisted call runs, it sends the call (tool name,
arguments, current directory, and a bounded whole-session transcript) to
a separate reviewer model and asks for a single allow-or-deny decision. The
transcript holds the user's messages with the assistant prose adjacent to
them — so "shall I do X?" followed by "yes" reads as consent to X — plus the
human's answers to questions the agent asked through `ask_user_question`,
marked as such; an answer only authorizes exactly what its question asked.
Tool calls and tool results never enter the transcript. The request also
carries guardian's own recent denials, so a user's go-ahead after a denial
reads as informed consent to the denied action. A
denial blocks the call and tells the agent not to work around it; three
denials in a row without an approved call in between stop the run so the
agent asks the user instead of retrying.

The reviewer follows a bundled policy covering data exfiltration, credential
probing, security weakening, and destructive or hard-to-reverse actions, with
rules for resolving low-risk exceptions and treating omitted or truncated
context as something that can never grant authorization on its own. You can
add trusted, environment-specific rules on top of it without replacing it.

Calls listed in `allow.tools`, bash commands matching a pattern in
`allow.bash`, tools from an MCP server listed in `allow.mcp`, or a built-in
list of read-only tools (see `allow.readonly` below), skip the reviewer
entirely. `write` and `edit` calls also skip review when their
target path resolves inside the shared scratchpad root from `jpi-scratchpad`
— see `allow.scratchpad` below. Once a call passes review, its arguments are
frozen so nothing downstream can change what actually runs.

A bash command only skips the reviewer as a whole if every part of it does.
Guardian parses the command and, when it has a simple shape — one command, or
several joined by `&&`, `||`, `;`, or `|` — splits it into its individual
commands and checks each one on its own. A command stays whole (and needs a
full `allow.bash` match, exactly as before) whenever the split would be
ambiguous: shell operators it doesn't parse, variable expansion, command
substitution, redirects, globs, background jobs, subshells, loops, and
anything else it can't fully account for. Every split part must clear the
gate — matching an `allow.bash` pattern, or landing on the built-in read-only
command list — or the reviewer still sees the call.

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

Auto-review reads its config from the `guardian` section of the shared
`${PI_CODING_AGENT_DIR:-~/.pi/agent}/jpi.kdl`, the config file for the whole
jpi plugin family. It ignores project-local config on purpose. The section is
created with defaults the first time auto-review loads if it's missing:

```kdl
guardian {
  // model that runs the reviews
  model "anthropic/claude-sonnet-5"
  // set to #false to disable reviews
  enabled #true
  // per-review timeout in milliseconds
  timeout-ms 10000
  allow {
    // tool names that skip review (repeat: tool "name")
    // regexes; a full command match skips review
    // MCP servers whose tools skip review (repeat: mcp "server")
    // set to #false to disable the built-in read-only command and tool allowlists
    readonly #true
    // set to #false to review scratchpad writes too
    scratchpad #true
  }
  // extra review policy lines
}
```

Edit the file directly, then run `/auto-review reload` in a Pi session to
pick up the change without restarting. Set `model` to the reviewer model Pi
should call. Keep `allow.tool` and `allow.bash` small — repeat the node for
each entry, for example `tool "read"` or `bash "^npm test$"`. `allow.bash`
entries are regular expressions that must match a whole command or a whole
split part, so anchor them. `allow.readonly` turns off the built-in read-only
command list (`ls`, `git status`, `cat`, and the like — see the splitting
paragraph above) without turning off splitting itself; set it to `#false` if
you want every part of a split command to need an explicit `allow.bash`
match. The same toggle also gates a built-in list of read-only tool names
that skip review: `read`, `grep`, `find`, `ls`, `ask_user_question`,
`bg_status`, `bg_logs`, `TaskList`, `TaskGet`, `get_subagent_result`,
`web_search`, and `web_fetch`. `web_search`/`web_fetch` are included as
read-only, but a fetched URL can still carry data outward; if that matters to
you, set `allow.readonly` to `#false` and add explicit `allow.tool` entries
for the rest of the list. `policy` adds trusted rules on top of the bundled
policy (repeat the node per line); it does not replace it.

`allow.mcp` skips review for every tool from a named MCP server — repeat the
node per server, for example `mcp "datadog-prod"`. Use the server name as
written in `mcp.json`; this covers both the single proxy tool Pi exposes for
the server and any tools registered directly under that server's name.

`allow.scratchpad` exempts `write` and `edit` calls whose target path
resolves inside the per-session scratchpad directory that `jpi-scratchpad`
steers the model to use (`jpi-base`'s `scratchpadRoot()`, under the OS temp
directory). The check resolves the path and requires it to land inside that
root — a lookalike sibling directory or a `..`-escape still gets reviewed.
Bash always stays reviewed, even when a command names a scratchpad path, since
guardian does not parse paths out of shell commands. Set `allow.scratchpad` to
`#false` if you want scratchpad writes reviewed like everything else.

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
