import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { ZodError } from "zod";
import { parseProfileText } from "@plugin-detector/profiles";

export interface ValidateProfileResult {
  exitCode: number;
}

// Validate one YAML profile file against UseCaseProfileSchema. Field errors
// print as a table and exit 1; this command never touches the network.
export async function validateProfile(
  argv: string[],
): Promise<ValidateProfileResult> {
  if (argv.length !== 1) {
    console.error(`usage: plugin-detector profiles validate <file>`);
    return { exitCode: 2 };
  }
  const file = argv[0] as string;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    console.error(
      `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { exitCode: 1 };
  }
  try {
    const profile = parseProfileText(text, basename(file));
    console.log(`profile ${profile.id} valid (version ${profile.version})`);
    return { exitCode: 0 };
  } catch (error) {
    if (error instanceof ZodError) {
      const rows = error.issues.map((issue) => ({
        field: issue.path.map(String).join(".") || "(root)",
        error: issue.message,
      }));
      const width = Math.max(
        "field".length,
        ...rows.map((r) => r.field.length),
      );
      console.log(`field ${" ".repeat(Math.max(0, width - "field".length))} | error`);
      console.log(`${"-".repeat(width)}-+-${"-".repeat(40)}`);
      for (const row of rows) {
        console.log(`${row.field.padEnd(width)} | ${row.error}`);
      }
    } else {
      console.log(`error | ${error instanceof Error ? error.message : String(error)}`);
    }
    return { exitCode: 1 };
  }
}
