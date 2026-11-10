import { loadProfiles } from "@plugin-detector/profiles";

export interface ListProfilesResult {
  exitCode: number;
}

// `profiles list`: print the built-in profile ids and display names.
export async function listProfiles(
  argv: string[] = [],
): Promise<ListProfilesResult> {
  if (argv.length > 0) {
    console.error(`usage: plugin-detector profiles list`);
    return { exitCode: 2 };
  }
  for (const profile of loadProfiles()) {
    console.log(`${profile.id}\t${profile.displayName}`);
  }
  return { exitCode: 0 };
}
