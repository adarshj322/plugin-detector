import { capabilityId } from "@plugin-detector/core";

// `name:` from a SKILL.md YAML frontmatter block. Returns null when the
// block is missing or unparseable so callers keep the directory name and
// warn; never throws on untrusted file text.
export function skillNameFromFrontmatter(text: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match?.[1]) return null;
  const body = match[1];
  for (const line of body.split("\n")) {
    const name = /^\s*name\s*:\s*(.+?)\s*$/.exec(line)?.[1];
    if (name && !/[[{\]]/.test(name)) return name.replace(/^["']|["']$/g, "");
    if (name) return null;
  }
  return null;
}

// `capabilities:` from a SKILL.md frontmatter block, in any of the three
// shapes authors actually use: comma-separated, flow list `[a, b]`, or a
// block list (`- a` on following indented lines). Null means malformed;
// absent key means no declared capabilities ([]).
export function skillCapabilitiesFromFrontmatter(text: string): string[] | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match?.[1]) return null;
  const lines = match[1].split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const inline = /^\s*capabilities\s*:\s*(.*?)\s*$/.exec(line);
    if (inline === null) continue;
    let raw = inline[1] ?? "";
    if (raw.startsWith("[")) {
      if (!raw.endsWith("]")) return null;
      raw = raw.slice(1, -1);
    } else if (raw.length === 0) {
      const items: string[] = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j] as string;
        if (next.trim().length === 0 || /^\s*#/.test(next)) continue;
        const item = /^\s*-\s*(.+?)\s*$/.exec(next);
        if (item === null) break;
        items.push(item[1] as string);
      }
      return mapCapabilities(items);
    }
    if (/[[{\]]/.test(raw)) return null;
    return mapCapabilities(raw.split(","));
  }
  return [];
}

function mapCapabilities(parts: string[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    const mapped = capabilityId(part.trim());
    if (mapped) out.push(mapped);
  }
  return out;
}
