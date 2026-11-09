import { writeFileSync } from "node:fs";
import {
  buildReviewReport,
  loadSnapshotForReview,
  readCacheManifestStrict,
  type ReviewReport,
} from "@plugin-detector/registry";

export interface RegistryReviewResult {
  exitCode: number;
  message: string;
  report?: ReviewReport;
}

const USAGE =
  "usage: plugin-detector registry review [--cache-dir <dir>] [--json] [--out <file>]";

function printReport(report: ReviewReport): void {
  console.log(
    `registry review: ${report.counts.total} records (${report.counts.probed} probed, ${report.counts.unprobed} unprobed, ${report.counts.rejected} rejected)`,
  );
  console.log(`snapshot-generated-at: ${report.snapshotGeneratedAt}`);
  console.log(`report-generated-at: ${report.generatedAt}`);
  console.log("sources:");
  for (const source of report.sources) {
    console.log(
      `  ${source.sourceUrl}: probed=${source.probed} unprobed=${source.unprobed} rejected=${source.rejected}`,
    );
  }
  console.log("candidates:");
  for (const candidate of report.candidates) {
    console.log(
      `  ${candidate.id} (${candidate.name}) [${candidate.artifactType}] trust=${candidate.trust} provenance=${candidate.provenance}`,
    );
    console.log(`    source: ${candidate.sourceUrl}`);
    console.log(`    license: ${candidate.license}`);
    console.log(`    pin: ${candidate.pinnedRef}`);
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
  console.log(
    "note: this report is review evidence, not a certification; inspect the evidence before accepting a snapshot.",
  );
}

// `plugin-detector registry review`: read-only by default. It reports the
// accepted (probed) snapshot and the rejected/unprobed manifest records for a
// human decision; `--out` writes only the JSON report, never the snapshot.
export async function registryReview(
  argv: string[] = [],
): Promise<RegistryReviewResult> {
  let cacheDir: string | undefined;
  let json = false;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if ((arg === "--cache-dir" || arg === "--cacheDir") && i + 1 < argv.length) {
      cacheDir = argv[i + 1];
      i += 1;
    } else if (arg === "--out" && i + 1 < argv.length) {
      out = argv[i + 1];
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      return { exitCode: 0, message: USAGE };
    } else {
      const message = `unknown argument: ${arg}`;
      console.error(message);
      return { exitCode: 2, message };
    }
  }

  try {
    const snapshot = loadSnapshotForReview(
      cacheDir === undefined ? undefined : { cacheDir },
    );
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
