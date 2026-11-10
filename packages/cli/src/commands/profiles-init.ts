import { writeFileSync } from "node:fs";
import { basename } from "node:path";

export interface InitProfileResult {
  exitCode: number;
}

function starter(id: string): string {
  return `# Custom use-case profile. Edit the values, keep canonical capability IDs,
# then validate with: plugin-detector profiles validate <this-file>
id: ${id}
version: 1
displayName: Custom Workflow
description: Describe the workflow this profile should recommend tools for.
capabilities:
  - docs.writing
signalQueries:
  - project-readme
  - docs-site
  - markdown-files
  - changelog-updates
  - style-guide
negativeSignals:
  - media-editing-project
defaultDomains:
  - writing
expectedValueTiers:
  - time-saved
requiredThreshold: 10
`;
}

// `profiles init <file>`: write a starter profile, never overwrite an
// existing file, and print the edit -> validate -> recommend next steps.
export async function initProfile(argv: string[]): Promise<InitProfileResult> {
  if (argv.length !== 1) {
    console.error(`usage: plugin-detector profiles init <file>`);
    return { exitCode: 2 };
  }
  const file = argv[0] as string;
  const id = basename(file).replace(/\.ya?ml$/i, "") || "custom-profile";
  try {
    writeFileSync(file, starter(id), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      console.error(`refusing to overwrite existing profile: ${file}`);
    } else {
      console.error(
        `cannot write ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { exitCode: 1 };
  }
  console.log(`wrote starter profile ${file} (id: ${id})`);
  console.log("next:");
  console.log(
    "  1. set capabilities to canonical IDs from docs/profile-schema.md; never invent IDs",
  );
  console.log(`  2. plugin-detector profiles validate ${file}`);
  console.log(`  3. plugin-detector recommend --profile ${file} --signal <signal>`);
  console.log(
    `  4. optional discovery boost: plugin-detector registry refresh --profile ${file}`,
  );
  return { exitCode: 0 };
}
