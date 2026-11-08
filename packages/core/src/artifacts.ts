import { z } from "zod";

// The four harnesses v1 ships adapters for, plus unknown for undetected trees.
export const HarnessId = z.enum([
  "opencode",
  "claude-code",
  "codex",
  "cursor",
  "unknown",
]);
export type HarnessId = z.infer<typeof HarnessId>;

// Artifact classes the discovery pipeline probes (spec: Discovery architecture).
export const ArtifactType = z.enum([
  "skill",
  "plugin",
  "mcp-server",
  "hook",
  "command",
  "tool",
]);
export type ArtifactType = z.infer<typeof ArtifactType>;
