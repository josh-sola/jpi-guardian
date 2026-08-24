import Parser from "tree-sitter";
import Bash from "tree-sitter-bash";

export type Segment = { argv: string[]; text: string };
export type SplitResult = { kind: "split"; segments: Segment[] } | { kind: "opaque" };

type SyntaxNode = Parser.SyntaxNode;

const OPAQUE: SplitResult = { kind: "opaque" };

// Globs, brace expansion, and backslash escapes all parse as plain `word`
// nodes, but the shell rewrites them before execution — a `word`'s text is
// not what the command receives. Any of them makes the command opaque.
const UNSAFE_WORD_CHARS = /[*?[\\{}]/;

const LIST_OPERATORS = new Set(["&&", "||"]);
const PIPELINE_OPERATORS = new Set(["|"]);

const parser = new Parser();
parser.setLanguage(Bash);

function containsComment(node: SyntaxNode): boolean {
  if (node.type === "comment") return true;
  return node.children.some(containsComment);
}

function collectStringContent(node: SyntaxNode): string | undefined {
  let value = "";
  for (const child of node.children) {
    if (!child.isNamed) continue;
    if (child.type !== "string_content") return undefined;
    value += child.text;
  }
  return value;
}

function collectCommand(node: SyntaxNode, out: Segment[]): boolean {
  let name: string | undefined;
  const argv: string[] = [];

  for (const child of node.children) {
    if (!child.isNamed) return false;

    switch (child.type) {
      case "command_name": {
        const nameWord = child.firstNamedChild;
        if (child.namedChildCount !== 1 || nameWord?.type !== "word") return false;
        if (UNSAFE_WORD_CHARS.test(nameWord.text)) return false;
        name = nameWord.text;
        break;
      }
      case "word": {
        if (UNSAFE_WORD_CHARS.test(child.text)) return false;
        argv.push(child.text);
        break;
      }
      case "raw_string": {
        argv.push(child.text.slice(1, -1));
        break;
      }
      case "string": {
        const value = collectStringContent(child);
        if (value === undefined) return false;
        argv.push(value);
        break;
      }
      default:
        // variable_assignment, every redirect kind, concatenation, number, and
        // anything else the grammar can produce is a deliberate rejection.
        return false;
    }
  }

  if (name === undefined) return false;
  argv.unshift(name);
  out.push({ argv, text: node.text.trim() });
  return true;
}

function walkChildren(node: SyntaxNode, operators: Set<string>, out: Segment[]): boolean {
  for (const child of node.children) {
    if (!child.isNamed) {
      if (!operators.has(child.type)) return false;
      continue;
    }
    if (!walkConnective(child, out)) return false;
  }
  return true;
}

function walkConnective(node: SyntaxNode, out: Segment[]): boolean {
  switch (node.type) {
    case "command":
      return collectCommand(node, out);
    case "list":
      return walkChildren(node, LIST_OPERATORS, out);
    case "pipeline":
      return walkChildren(node, PIPELINE_OPERATORS, out);
    default:
      return false;
  }
}

function walkProgram(root: SyntaxNode, out: Segment[]): boolean {
  for (const child of root.children) {
    if (!child.isNamed) {
      if (child.type !== ";") return false;
      continue;
    }
    if (!walkConnective(child, out)) return false;
  }
  return true;
}

export function splitCommand(command: string): SplitResult {
  if (!command.trim()) return OPAQUE;

  const tree = parser.parse(command);
  const root = tree.rootNode;
  if (root.hasError) return OPAQUE;
  if (root.childCount === 0) return OPAQUE;
  if (containsComment(root)) return OPAQUE;

  const segments: Segment[] = [];
  if (!walkProgram(root, segments)) return OPAQUE;
  if (segments.length === 0) return OPAQUE;

  return { kind: "split", segments };
}
