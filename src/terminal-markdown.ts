import { stripVTControlCharacters } from "node:util";

export interface TerminalMarkdownOptions {
  isTTY?: boolean;
  colors?: boolean;
}

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  italic: "\u001b[3m",
  underline: "\u001b[4m",
  cyan: "\u001b[36m",
  yellow: "\u001b[33m",
} as const;

function sanitizeTerminalText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(/[\u202A-\u202E\u2066-\u2069]/gu, "");
}

export function terminalColorsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !("NO_COLOR" in env) && env.TERM !== "dumb";
}

function createStyler(colors: boolean): (...args: string[]) => string {
  return (text: string, ...codes: string[]): string => {
    if (!colors || text.length === 0) return text;
    return `${codes.join("")}${text}${ANSI.reset}`;
  };
}

function renderInline(
  value: string,
  style: (...args: string[]) => string,
): string {
  const protectedParts: string[] = [];
  const protect = (rendered: string): string => {
    const index = protectedParts.push(rendered) - 1;
    return `\uE000${index}\uE001`;
  };

  let rendered = value.replace(/`([^`\n]+)`/gu, (_match, code: string) => (
    protect(style(code, ANSI.yellow))
  ));

  rendered = rendered.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gu,
    (_match, label: string, url: string) => protect(
      `${style(label, ANSI.cyan, ANSI.underline)} ${style(`(${url})`, ANSI.dim)}`,
    ),
  );

  rendered = rendered.replace(/\*\*([^*\n]+)\*\*/gu, (_match, text: string) => (
    style(text, ANSI.bold)
  ));
  rendered = rendered.replace(/\*([^*\n]+)\*/gu, (_match, text: string) => (
    style(text, ANSI.italic)
  ));

  return rendered.replace(/\uE000(\d+)\uE001/gu, (_match, index: string) => (
    protectedParts[Number(index)] ?? ""
  ));
}

/**
 * Render the small Markdown subset used by console demo responses.
 * Non-interactive output keeps its Markdown so redirects remain useful.
 */
export function renderTerminalMarkdown(
  markdown: string,
  options: TerminalMarkdownOptions = {},
): string {
  const sanitized = sanitizeTerminalText(markdown);
  const isTTY = options.isTTY ?? Boolean(process.stdout.isTTY);
  if (!isTTY) return sanitized;

  const colors = options.colors ?? terminalColorsEnabled();
  const style = createStyler(colors);
  const output: string[] = [];
  let fence: "```" | "~~~" | null = null;

  for (const line of sanitized.split("\n")) {
    const fenceMatch = line.match(/^\s*(```|~~~)/u);
    if (fenceMatch) {
      const marker = fenceMatch[1] as "```" | "~~~";
      if (fence === null) {
        fence = marker;
      } else if (fence === marker) {
        fence = null;
      } else {
        output.push(`  ${style(line, ANSI.yellow)}`);
      }
      continue;
    }

    if (fence !== null) {
      output.push(line.length > 0 ? `  ${style(line, ANSI.yellow)}` : "");
      continue;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u);
    if (heading) {
      output.push(style(renderInline(heading[1], style), ANSI.bold, ANSI.cyan));
      continue;
    }

    if (/^\s{0,3}(?:(?:\*|-|_)\s*){3,}$/u.test(line)) {
      output.push(style("─".repeat(48), ANSI.dim));
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/u);
    if (quote) {
      output.push(`${style("│", ANSI.cyan)} ${style(renderInline(quote[1], style), ANSI.dim)}`);
      continue;
    }

    const unordered = line.match(/^(\s*)[-+*]\s+(.+)$/u);
    if (unordered) {
      output.push(`${unordered[1]}${style("•", ANSI.cyan)} ${renderInline(unordered[2], style)}`);
      continue;
    }

    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/u);
    if (ordered) {
      output.push(`${ordered[1]}${style(`${ordered[2]}.`, ANSI.cyan)} ${renderInline(ordered[3], style)}`);
      continue;
    }

    output.push(renderInline(line, style));
  }

  return output.join("\n");
}
