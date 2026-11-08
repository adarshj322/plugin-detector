import type { ArtifactType } from "@plugin-detector/core";

// Source-specific raw record as handed to the local pipeline (Task 5 owns
// fetching; this task only normalizes records already on disk). Free-text and
// self-declared fields (tags/topics/keywords/description/readme) are carried
// for diagnostics but never treated as evidence.
export interface RawArtifactRef {
  kind: string;
  file?: string | undefined;
  artifactId?: string | undefined;
  capabilities?: string[] | undefined;
  domains?: string[] | undefined;
}

export interface RawCandidate {
  id?: string | undefined;
  name?: string | undefined;
  artifact?: RawArtifactRef | null | undefined;
  sourceKind?: string | undefined;
  pinnedRef?: string | undefined;
  license?: string | undefined;
  repositoryUrl?: string | undefined;
  registryUrl?: string | undefined;
  packageName?: string | undefined;
  lastVerified?: string | undefined;
  maintenance?: "active" | "stale" | "archived" | "unknown" | undefined;
  auditStatus?: "clean" | "warning" | "critical" | "unknown" | undefined;
  risk?: "low" | "medium" | "high" | "critical" | undefined;
  popularity?:
    | {
        stars?: number | undefined;
        installs?: number | undefined;
        velocity30d?: number | undefined;
      }
    | undefined;
  tags?: string[] | undefined;
  topics?: string[] | undefined;
  keywords?: string[] | undefined;
  description?: string | undefined;
  readme?: string | undefined;
}

export interface ArtifactProbe {
  found: boolean;
  artifactType?: ArtifactType | undefined;
  evidence: string[];
  reason?: string | undefined;
}

function baseName(path: string): string {
  const slash = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return slash.toLowerCase();
}

// Local artifact fixtures only: recognized manifest files or kinds map to a
// closed ArtifactType. Anything else (bare tags, unknown files) is not
// evidence, with or without a marketplace id we cannot classify.
export function probeArtifact(input: RawCandidate): ArtifactProbe {
  const ref = input.artifact;
  if (!ref) {
    return {
      found: false,
      evidence: [],
      reason:
        "no artifact ref: self-declared tags/topics without a probed artifact are not evidence",
    };
  }
  const kind = ref.kind.trim().toLowerCase();
  const file = (ref.file ?? "").trim();
  const name = baseName(file);

  let artifactType: ArtifactType | undefined;
  if (kind === "skill" || name === "skill.md") artifactType = "skill";
  else if (
    kind === "plugin" ||
    name === "plugin.json" ||
    name === ".claude-plugin"
  )
    artifactType = "plugin";
  else if (
    kind === "mcp" ||
    kind === "mcp-server" ||
    name === "server.json" ||
    name === "mcp.json" ||
    name === ".mcp.json"
  )
    artifactType = "mcp-server";
  else if (kind === "hook" || kind === "hooks" || name === "hooks.json")
    artifactType = "hook";
  else if (kind === "command") artifactType = "command";
  else if (kind === "tool") artifactType = "tool";

  if (!artifactType) {
    return {
      found: false,
      evidence: [],
      reason: `unrecognized artifact kind ${JSON.stringify(ref.kind)} with no known manifest file`,
    };
  }

  const evidence: string[] = [];
  if (file) evidence.push(`artifact file ${JSON.stringify(ref.file)}`);
  evidence.push(`artifact kind ${JSON.stringify(ref.kind)}`);
  if (ref.artifactId) evidence.push(`marketplace artifact id ${ref.artifactId}`);
  return { found: true, artifactType, evidence };
}
