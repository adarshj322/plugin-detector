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

// `capabilities:` (comma-separated local names mapped through the core
// taxonomy) from a SKILL.md frontmatter block. Null means malformed;
// absent key means no declared capabilities ([]).
export function skillCapabilitiesFromFrontmatter(text: string): string[] | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match?.[1]) return null;
  for (const line of match[1].split("\n")) {
    const raw = /^\s*capabilities\s*:\s*(.+?)\s*$/.exec(line)?.[1];
    if (raw === undefined) continue;
    if (/[[{\]]/.test(raw)) return null;
    const out: string[] = [];
    for (const part of raw.split(",")) {
      const mapped = capabilityId(part.trim());
      if (mapped) out.push(mapped);
    }
    return out;
  }
  return [];
}
