function stripTrailingCommas(input: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escaped = false;
  while (i < input.length) {
    const ch = input[i] as string;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j] as string)) j += 1;
      const next = input[j];
      if (next === "}" || next === "]") {
        i += 1; // Drop the comma; whitespace is kept by the outer loop.
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

// Tolerantly strips `//` and `/* */` comments and trailing commas outside
// string literals so JSONC config parses like JSON. Only `"` strings exist in
// JSON; a `\` escape inside a string never starts a comment. Node built-ins
// only.
export function stripJsonc(input: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escaped = false;
  while (i < input.length) {
    const ch = input[i] as string;
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    const next = input[i + 1];
    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        i += 1;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return stripTrailingCommas(out);
}
