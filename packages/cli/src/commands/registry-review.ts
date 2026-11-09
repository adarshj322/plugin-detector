import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import {
  buildReviewReport,
  loadSnapshotForReview,
  MANIFEST_FILENAME,
  readCacheManifestStrict,
  SNAPSHOT_FILENAME,
  type ReviewReport,
} from "@plugin-detector/registry";

export interface RegistryReviewResult {
  exitCode: number;
  message: string;
  report?: ReviewReport;
}

export interface RegistryReviewOptions {
  // Test seam for the bundled snapshot fallback; production uses the package
  // data file resolved beside dist.
  bundledPath?: string;
}

const USAGE =
  "usage: plugin-detector registry review [--cache-dir <dir>] [--json] [--out <file>]";

const PROTECTED_OUT = new Set([SNAPSHOT_FILENAME, MANIFEST_FILENAME]);

function printReport(report: ReviewReport): void {
  console.log(
    `registry review: ${report.counts.total} records (${report.counts.probed} probed, ${report.counts.preserved} preserved, ${report.counts.unprobed} unprobed, ${report.counts.rejected} rejected)`,
  );
  console.log(`snapshot-generated-at: ${report.snapshotGeneratedAt}`);
  console.log(
    `manifest-generated-at: ${report.manifestGeneratedAt ?? "(none)"}`,
  );
  console.log(`report-generated-at: ${report.generatedAt}`);
  console.log("sources:");
  for (const source of report.sources) {
    console.log(
      `  ${source.sourceUrl}: probed=${source.probed} unprobed=${source.unprobed} rejected=${source.rejected}`,
    );
  }
  console.log("source-health:");
  if (report.sourceHealth.length === 0) {
    console.log("  (no manifest)");
  }
  for (const health of report.sourceHealth) {
    const facts = [
      health.ok ? "ok" : "FAILED",
      ...(health.count === undefined ? [] : [`count=${health.count}`]),
      ...(health.partial === true ? ["partial"] : []),
      ...(health.error === undefined ? [] : [`error=${health.error}`]),
    ];
    console.log(`  ${health.id}: ${facts.join(" ")}`);
    for (const failure of health.failures ?? []) {
      console.log(`    query "${failure.query}": ${failure.error}`);
    }
  }
  console.log("candidates:");
  for (const candidate of report.candidates) {
    console.log(
      `  ${candidate.id} (${candidate.name}) [${candidate.artifactType}] trust=${candidate.trust} provenance=${candidate.provenance}${candidate.preserved ? " PRESERVED" : ""}`,
    );
    console.log(`    source: ${candidate.sourceUrl}`);
    console.log(`    license: ${candidate.license}`);
    console.log(`    pin: ${candidate.pinnedRef}`);
    console.log(
      `    risk: ${candidate.risk} maintenance: ${candidate.maintenance} audit: ${candidate.auditStatus}`,
    );
    console.log(`    last-verified: ${candidate.lastVerified}`);
    console.log(`    evidence-retrieved-at: ${candidate.retrievedAt}`);
    console.log(
      `    evidence: ${candidate.evidenceSource} (ref ${candidate.evidenceRef}, hash ${candidate.contentHash})`,
    );
    console.log(
      `    capabilities: ${candidate.capabilities.length === 0 ? "(none)" : candidate.capabilities.join(", ")}`,
    );
    for (const snippet of candidate.evidenceSnippets) {
      console.log(`    snippet: ${snippet}`);
    }
  }
  if (report.unprobed.length > 0) {
    console.log("unprobed:");
    for (const record of report.unprobed) {
      console.log(`  ${record.id}: ${record.reason} (source: ${record.sourceUrl})`);
    }
  }
  if (report.rejected.length > 0) {
    console.log("rejected:");
    for (const record of report.rejected) {
      console.log(`  ${record.id}: ${record.reason} (source: ${record.sourceUrl})`);
    }
  }
  if (report.rejectedGroups.length > 0) {
    console.log("rejected-groups:");
    for (const group of report.rejectedGroups) {
      console.log(
        `  ${group.count}x ${group.reason} (source: ${group.sourceUrl}; ids: ${group.ids.join(", ")})`,
      );
    }
  }
  if (report.counts.rejectedAlsoPreserved > 0) {
    console.log(
      `note: ${report.counts.rejectedAlsoPreserved} rejected id(s) also appear as preserved candidates; total counts records, not unique ids.`,
    );
  }
  console.log(
    "note: this report is review evidence, not a certification; inspect the evidence before accepting a snapshot.",
  );
}

function usageError(message: string): RegistryReviewResult {
  console.error(message);
  return { exitCode: 2, message };
}

// `plugin-detector registry review`: read-only by default. It reports the
// accepted (probed) snapshot and the rejected/unprobed manifest records for a
// human decision; `--out` writes only the JSON report, never the snapshot.
export async function registryReview(
  argv: string[] = [],
  options: RegistryReviewOptions = {},
): Promise<RegistryReviewResult> {
  let cacheDir: string | undefined;
  let json = false;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--cache-dir" || arg === "--cacheDir") {
      const value = argv[i + 1];
      if (value === undefined) return usageError("missing value for --cache-dir");
      cacheDir = value;
      i += 1;
    } else if (arg === "--out") {
      const value = argv[i + 1];
      if (value === undefined) return usageError("missing value for --out");
      out = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      return { exitCode: 0, message: USAGE };
    } else {
      return usageError(`unknown argument: ${arg}`);
    }
  }

  // The report is JSON too; writing it over the cache inputs would destroy
  // the very evidence being reviewed.
  if (out !== undefined && PROTECTED_OUT.has(basename(out))) {
    return usageError(
      `refusing --out ${out}: it would overwrite ${basename(out)}; pass a report path instead`,
    );
  }

  try {
    const snapshot = loadSnapshotForReview({
      ...(cacheDir === undefined ? {} : { cacheDir }),
      ...(options.bundledPath === undefined
        ? {}
        : { bundledPath: options.bundledPath }),
    });
    const manifest = readCacheManifestStrict(
      cacheDir === undefined ? undefined : { cacheDir },
    );
    const report = buildReviewReport(snapshot, manifest);
    if (out !== undefined) {
      writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    }
    if (json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
    const message = `registry review: ${report.counts.probed} probed, ${report.counts.unprobed} unprobed, ${report.counts.rejected} rejected`;
    return { exitCode: 0, message, report };
  } catch (error) {
    const message = `registry review failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    console.error(message);
    return { exitCode: 1, message };
  }
}
