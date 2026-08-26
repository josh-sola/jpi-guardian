const ANY_ARGS = new Set([
  "cal",
  "uptime",
  "cat",
  "head",
  "tail",
  "wc",
  "stat",
  "strings",
  "hexdump",
  "od",
  "nl",
  "id",
  "uname",
  "free",
  "df",
  "du",
  "locale",
  "groups",
  "nproc",
  "basename",
  "dirname",
  "realpath",
  "cut",
  "paste",
  "tr",
  "column",
  "tac",
  "rev",
  "fold",
  "expand",
  "unexpand",
  "fmt",
  "comm",
  "cmp",
  "numfmt",
  "readlink",
  "diff",
  "true",
  "false",
  "sleep",
  "which",
  "type",
  "expr",
  "seq",
  "tsort",
  "pr",
  "echo",
  "ls",
  "cd",
]);

const ZERO_ARGS_ONLY = new Set(["pwd", "whoami", "alias"]);

export const BUILT_IN_READONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "ask_user_question",
  "bg_status",
  "bg_logs",
  "TaskList",
  "TaskGet",
  "get_subagent_result",
  "web_search",
  "web_fetch",
]);

const EXACT_ARGV_FORMS: readonly string[][] = [
  ["node", "-v"],
  ["node", "--version"],
  ["python", "--version"],
  ["python3", "--version"],
  ["git", "--version"],
];

const GIT_SUBCOMMANDS_WITH_ARGS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "shortlog",
  "describe",
  "rev-parse",
  "ls-files",
  "cat-file",
  "for-each-ref",
]);

const GH_SUBCOMMANDS: Record<string, Set<string>> = {
  pr: new Set(["view", "list", "diff", "checks", "status"]),
  issue: new Set(["view", "list", "status"]),
  run: new Set(["view", "list"]),
  workflow: new Set(["list", "view"]),
  repo: new Set(["view"]),
  release: new Set(["view", "list"]),
  auth: new Set(["status"]),
};

const DOCKER_SUBCOMMANDS = new Set(["ps", "images", "logs", "inspect"]);

function argvEquals(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// A command-execution vector disguised as a read: `-c core.pager=x` runs the pager,
// `--exec-path`/`-C` retarget git entirely. Rejecting anything before the subcommand
// closes all of these at once instead of enumerating each flag.
function isReadOnlyGit(argv: string[]): boolean {
  const subcommand = argv[1];
  if (subcommand === undefined) return false;

  if (GIT_SUBCOMMANDS_WITH_ARGS.has(subcommand)) {
    const rest = argv.slice(2);
    return !rest.some((arg) => arg === "-o" || arg === "--ext-diff" || arg.startsWith("--output"));
  }

  if (subcommand === "branch") {
    const rest = argv.slice(2);
    return rest.every(
      (arg) => arg === "--list" || arg === "-a" || arg === "-r" || arg === "-v" || arg === "-vv",
    );
  }

  if (subcommand === "tag") {
    const rest = argv.slice(2);
    return rest.every((arg) => arg === "--list" || arg === "-l");
  }

  if (subcommand === "remote") {
    const rest = argv.slice(2);
    return rest.length === 0 || (rest.length === 1 && rest[0] === "-v");
  }

  // `git reflog delete`/`expire` destroy the recovery log, so only the show form passes.
  if (subcommand === "reflog") return argv.length === 2 || argv[2] === "show";

  if (subcommand === "stash") return argv.length === 3 && argv[2] === "list";
  if (subcommand === "worktree") return argv.length === 3 && argv[2] === "list";
  if (subcommand === "config") return argv.length === 4 && argv[2] === "--get";

  // git fetch/pull/ls-remote and everything else stay off the built-in list:
  // --upload-pack and ext:: remotes turn a "read" into arbitrary command execution.
  return false;
}

function isReadOnlyGh(argv: string[]): boolean {
  const noun = argv[1];
  const verb = argv[2];
  if (noun === undefined || verb === undefined) return false;

  const allowedVerbs = GH_SUBCOMMANDS[noun];
  if (!allowedVerbs || !allowedVerbs.has(verb)) return false;

  return !argv.slice(3).includes("--web");
}

function isReadOnlyDocker(argv: string[]): boolean {
  const subcommand = argv[1];
  return subcommand !== undefined && DOCKER_SUBCOMMANDS.has(subcommand);
}

export function isReadOnlyCommand(argv: string[]): boolean {
  const name = argv[0];
  if (name === undefined) return false;

  if (ANY_ARGS.has(name)) return true;
  if (ZERO_ARGS_ONLY.has(name)) return argv.length === 1;
  if (EXACT_ARGV_FORMS.some((form) => argvEquals(form, argv))) return true;

  if (name === "git") return isReadOnlyGit(argv);
  if (name === "gh") return isReadOnlyGh(argv);
  if (name === "docker") return isReadOnlyDocker(argv);

  return false;
}
