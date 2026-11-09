import {
  refreshSnapshot,
  type RefreshOptions,
  type RefreshResult,
} from "@plugin-detector/registry";
import { loadProfiles, type V1Profile } from "@plugin-detector/profiles";

export interface RegistryRefreshResult {
  exitCode: number;
  message: string;
}

export interface RegistryRefreshDeps {
  // Test seam: no live network in CLI tests.
  refresh?: ((opts: RefreshOptions) => Promise<RefreshResult>) | undefined;
  profiles?: V1Profile[] | undefined;
}

// `plugin-detector registry refresh`: on-demand snapshot refresh with
// graceful degradation. Total network failure exits 2 and mutates nothing;
// partial failure exits 0 after writing the refreshed subset. `--use-case`
// appends profile signal terms to discovery queries only (never evidence).
export async function registryRefresh(
  argv: string[] = [],
  deps: RegistryRefreshDeps = {},
): Promise<RegistryRefreshResult> {
  let cacheDir: string | undefined;
  let limit: number | undefined;
  let useCase: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === "--cache-dir" || arg === "--cacheDir") && i + 1 < argv.length) {
      cacheDir = argv[i + 1];
      i += 1;
    } else if (arg === "--limit" && i + 1 < argv.length) {
      const parsed = Number(argv[i + 1]);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return { exitCode: 1, message: `--limit must be a non-negative integer` };
      }
      limit = parsed;
      i += 1;
    } else if (arg === "--use-case" && i + 1 < argv.length) {
      useCase = argv[i + 1];
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      return {
        exitCode: 0,
        message:
          "usage: plugin-detector registry refresh [--cache-dir <dir>] [--limit <n>] [--use-case <id>]",
      };
    } else {
      return { exitCode: 1, message: `unknown argument: ${arg}` };
    }
  }

  let extraQueries: string[] | undefined;
  if (useCase !== undefined) {
    const profiles = deps.profiles ?? loadProfiles();
    const profile = profiles.find((entry) => entry.id === useCase);
    if (profile === undefined) {
      const validIds = profiles.map((entry) => entry.id);
      return {
        exitCode: 2,
        message: `unknown --use-case "${useCase}". Valid ids: ${validIds.join(", ")}`,
      };
    }
    extraQueries = [...profile.signalQueries];
  }

  const refresh = deps.refresh ?? refreshSnapshot;
  const result = await refresh({
    ...(cacheDir ? { cacheDir } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(extraQueries === undefined ? {} : { extraQueries }),
  });
  if (!result.ok) {
    const details = Object.entries(result.failures)
      .map(([url, err]) => `${url}: ${err}`)
      .join("; ");
    const message = `registry refresh failed: all sources failed (${details})`;
    console.error(message);
    return { exitCode: 2, message };
  }
  const count = result.snapshot?.candidates.length ?? 0;
  const failed = Object.keys(result.failures).length;
  const message =
    failed > 0
      ? `registry refreshed ${count} candidates with ${failed} source failure(s)`
      : `registry refreshed ${count} candidates`;
  console.log(message);
  return { exitCode: 0, message };
}
