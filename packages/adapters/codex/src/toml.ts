// Minimal TOML subset parser for Codex `config.toml` files (node built-ins
// only). Supports what the adapter inventories: `[table]` and
// `[table.sub]` headers, `[[array-table]]` entries, dotted keys, basic and
// literal strings, booleans, integers, floats, arrays, and inline tables.
// Anything outside the subset — or any redefinition — throws a `TOML parse
// error` and the caller turns it into an inventory warning. Never executes
// anything from the file; values stay inert data.
export function parseToml(input: string): Record<string, unknown> {
  const text = input;
  let pos = 0;
  const root: Record<string, unknown> = {};
  const definedTables = new Set<string>();
  let current = root;

  const eof = (): boolean => pos >= text.length;
  const peek = (): string => text[pos] as string;
  const fail = (msg: string): never => {
    throw new Error(`TOML parse error at offset ${pos}: ${msg}`);
  };

  const isDelim = (ch: string | undefined): boolean =>
    ch === undefined ||
    ch === " " ||
    ch === "\t" ||
    ch === "\n" ||
    ch === "\r" ||
    ch === "," ||
    ch === "]" ||
    ch === "}" ||
    ch === "#";

  const skipHorizontal = (): void => {
    while (!eof() && (peek() === " " || peek() === "\t" || peek() === "\r")) {
      pos += 1;
    }
  };

  const skipTrivia = (): void => {
    while (!eof()) {
      const ch = peek();
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        pos += 1;
        continue;
      }
      if (ch === "#") {
        while (!eof() && peek() !== "\n") pos += 1;
        continue;
      }
      break;
    }
  };

  const parseBasicString = (): string => {
    pos += 1; // opening `"`
    let out = "";
    while (true) {
      if (eof()) fail("unterminated string");
      const ch = peek();
      if (ch === '"') {
        pos += 1;
        return out;
      }
      if (ch === "\n") fail("unterminated string");
      if (ch === "\\") {
        pos += 1;
        if (eof()) fail("unterminated escape");
        const esc = peek();
        if (esc === "n") out += "\n";
        else if (esc === "t") out += "\t";
        else if (esc === "r") out += "\r";
        else if (esc === "\\") out += "\\";
        else if (esc === '"') out += '"';
        else if (esc === "u" || esc === "U") {
          const len = esc === "u" ? 4 : 8;
          const hex = text.slice(pos + 1, pos + 1 + len);
          if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) {
            fail("bad unicode escape");
          }
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          pos += len;
        } else {
          fail(`bad escape \\${esc}`);
        }
        pos += 1;
        continue;
      }
      out += ch;
      pos += 1;
    }
  };

  const parseLiteralString = (): string => {
    pos += 1; // opening `'`
    let out = "";
    while (true) {
      if (eof()) fail("unterminated string");
      const ch = peek();
      if (ch === "'") {
        pos += 1;
        return out;
      }
      if (ch === "\n") fail("unterminated string");
      out += ch;
      pos += 1;
    }
  };

  const parseKeySegments = (): string[] => {
    const segments: string[] = [];
    while (true) {
      skipHorizontal();
      if (eof()) fail("expected key");
      const ch = peek();
      if (ch === '"') {
        segments.push(parseBasicString());
      } else if (ch === "'") {
        segments.push(parseLiteralString());
      } else {
        const match = /^[A-Za-z0-9_-]+/.exec(text.slice(pos));
        if (!match) throw fail("expected key");
        segments.push(match[0] as string);
        pos += (match[0] as string).length;
      }
      skipHorizontal();
      if (!eof() && peek() === ".") {
        pos += 1;
        continue;
      }
      break;
    }
    if (segments.length === 0) fail("expected key");
    return segments;
  };

  const assignDotted = (
    container: Record<string, unknown>,
    segments: string[],
    value: unknown,
  ): void => {
    let target = container;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i] as string;
      const existing = target[seg];
      if (existing === undefined) {
        const fresh: Record<string, unknown> = {};
        target[seg] = fresh;
        target = fresh;
      } else if (isRecord(existing)) {
        target = existing;
      } else {
        fail(`cannot redefine "${segments.join(".")}"`);
      }
    }
    const last = segments[segments.length - 1] as string;
    if (target[last] !== undefined) fail(`duplicate key "${last}"`);
    target[last] = value;
  };

  const parseValue = (): unknown => {
    skipTrivia();
    if (eof()) fail("expected value");
    const ch = peek();
    if (ch === '"') return parseBasicString();
    if (ch === "'") return parseLiteralString();
    if (ch === "[") return parseArray();
    if (ch === "{") return parseInlineTable();
    const rest = text.slice(pos);
    if (rest.startsWith("true") && isDelim(rest[4])) {
      pos += 4;
      return true;
    }
    if (rest.startsWith("false") && isDelim(rest[5])) {
      pos += 5;
      return false;
    }
    const num = /^(?:0x[0-9a-fA-F]+|0o[0-7]+|0b[01]+|[+-]?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?))/.exec(
      rest,
    );
    if (num) {
      const token = num[0] as string;
      if (!isDelim(rest[token.length])) fail(`bad value "${token}"`);
      pos += token.length;
      if (/^0[xX]/.test(token)) return Number.parseInt(token.slice(2), 16);
      if (/^0[oO]/.test(token)) return Number.parseInt(token.slice(2), 8);
      if (/^0[bB]/.test(token)) return Number.parseInt(token.slice(2), 2);
      return token.includes(".") || /[eE]/.test(token)
        ? Number.parseFloat(token)
        : Number.parseInt(token, 10);
    }
    return fail(`bad value near "${rest.slice(0, 12)}"`);
  };

  const parseArray = (): unknown[] => {
    pos += 1; // `[`
    const out: unknown[] = [];
    while (true) {
      skipTrivia();
      if (eof()) fail("unterminated array");
      if (peek() === "]") {
        pos += 1;
        return out;
      }
      out.push(parseValue());
      skipTrivia();
      if (!eof() && peek() === ",") {
        pos += 1;
        continue;
      }
      skipTrivia();
      if (!eof() && peek() === "]") {
        pos += 1;
        return out;
      }
      fail("expected , or ] in array");
    }
  };

  const parseInlineTable = (): Record<string, unknown> => {
    pos += 1; // `{`
    const out: Record<string, unknown> = {};
    while (true) {
      skipTrivia();
      if (eof()) fail("unterminated inline table");
      if (peek() === "}") {
        pos += 1;
        return out;
      }
      const segments = parseKeySegments();
      skipHorizontal();
      if (eof() || peek() !== "=") fail("expected = in inline table");
      pos += 1;
      assignDotted(out, segments, parseValue());
      skipTrivia();
      if (!eof() && peek() === ",") {
        pos += 1;
        continue;
      }
      skipTrivia();
      if (!eof() && peek() === "}") {
        pos += 1;
        return out;
      }
      fail("expected , or } in inline table");
    }
  };

  const navigateHeader = (segments: string[]): Record<string, unknown> => {
    let target = root;
    for (const seg of segments) {
      const existing = target[seg];
      if (existing === undefined) {
        const fresh: Record<string, unknown> = {};
        target[seg] = fresh;
        target = fresh;
      } else if (Array.isArray(existing)) {
        const lastEl = existing[existing.length - 1];
        if (!isRecord(lastEl)) fail(`cannot descend into "${seg}"`);
        target = lastEl;
      } else if (isRecord(existing)) {
        target = existing;
      } else {
        fail(`cannot redefine "${seg}" as a table`);
      }
    }
    return target;
  };

  const parseHeader = (): void => {
    pos += 1; // `[`
    let arrayTable = false;
    if (!eof() && peek() === "[") {
      arrayTable = true;
      pos += 1;
    }
    const segments = parseKeySegments();
    skipHorizontal();
    if (eof() || peek() !== "]") fail("expected ] to close table header");
    pos += 1;
    if (arrayTable) {
      if (eof() || peek() !== "]") fail("expected ]] to close array header");
      pos += 1;
    }
    const parent = navigateHeader(segments.slice(0, -1));
    const last = segments[segments.length - 1] as string;
    const key = JSON.stringify(segments);
    if (arrayTable) {
      const existing = parent[last];
      let arr: unknown[];
      if (existing === undefined) {
        arr = [];
        parent[last] = arr;
      } else if (
        Array.isArray(existing) &&
        existing.every((el) => isRecord(el))
      ) {
        arr = existing;
      } else {
        throw fail(`cannot redefine "${last}" as an array table`);
      }
      const fresh: Record<string, unknown> = {};
      arr.push(fresh);
      current = fresh;
    } else {
      const existing = parent[last];
      if (existing === undefined) {
        const fresh: Record<string, unknown> = {};
        parent[last] = fresh;
        current = fresh;
      } else if (isRecord(existing)) {
        if (definedTables.has(key)) fail(`duplicate table "${last}"`);
        current = existing;
      } else {
        fail(`cannot redefine "${last}" as a table`);
      }
      definedTables.add(key);
    }
  };

  while (true) {
    skipTrivia();
    if (eof()) break;
    if (peek() === "[") {
      parseHeader();
    } else {
      const segments = parseKeySegments();
      skipHorizontal();
      if (eof() || peek() !== "=") fail("expected = after key");
      pos += 1;
      assignDotted(current, segments, parseValue());
    }
    skipHorizontal();
    if (!eof()) {
      if (peek() === "#") {
        while (!eof() && peek() !== "\n") pos += 1;
      } else if (peek() !== "\n") {
        fail("expected newline after entry");
      }
    }
  }
  return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
