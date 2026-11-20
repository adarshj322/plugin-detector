import { z } from "zod";

// Closed set for installed-artifact freshness. Unknown is a first-class state:
// absence of version evidence must never be reported as outdated.
export const UpdateStatus = z.enum([
  "current",
  "outdated",
  "unknown",
  "modified",
]);
export type UpdateStatus = z.infer<typeof UpdateStatus>;

// Installed-artifact actions only. `install` is a registry recommendation and
// v1.0 has no standalone `remove` (replace carries the removal recipe).
export const LifecycleAction = z.enum(["keep", "upgrade", "replace", "review"]);
export type LifecycleAction = z.infer<typeof LifecycleAction>;

// Three-state: no recorded baseline is "unknown", never false.
export const ModifiedStatus = z.union([z.boolean(), z.literal("unknown")]);
export type ModifiedStatus = z.infer<typeof ModifiedStatus>;

export const LifecycleRowSchema = z.object({
  installedId: z.string().min(1),
  candidateId: z.string().min(1).optional(),
  action: LifecycleAction,
  reasons: z.array(z.string().min(1)),
  installedVersion: z.string().min(1).optional(),
  latestVersion: z.string().min(1).optional(),
  capabilitiesAdded: z.array(z.string().min(1)),
  // Print-only remove/install steps; never executed by the tool.
  recipe: z.array(z.string().min(1)).optional(),
});
export type LifecycleRow = z.infer<typeof LifecycleRowSchema>;
