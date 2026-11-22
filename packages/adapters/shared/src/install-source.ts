import type { Candidate } from "@plugin-detector/core";

// `npx skills add` accepts `owner/repo@skill` to install one skill. A bare
// repository URL installs every skill in the repository, which would exceed
// the candidate a user approved.
const SAFE_SKILL = /^[A-Za-z0-9._-]+$/;

function githubRepo(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return undefined;
    const segments = url.pathname.split("/").filter(Boolean);
    const owner = segments[0];
    const repo = segments[1]?.replace(/\.git$/i, "");
    return owner === undefined || repo === undefined
      ? undefined
      : `${owner}/${repo}`;
  } catch {
    return undefined;
  }
}

export function skillInstallSpec(candidate: Candidate): string {
  const fallback =
    candidate.packageName ?? candidate.repositoryUrl ?? candidate.id;
  if (candidate.artifactType !== "skill") return fallback;
  // An explicit package spec (npm package or skills.sh package) is already
  // exact; never rewrite it.
  if (candidate.packageName !== undefined && candidate.packageName.trim() !== "") {
    return candidate.packageName;
  }
  const repo = githubRepo(candidate.repositoryUrl);
  const skill = (candidate.artifactEvidence?.name ?? candidate.name).trim();
  if (repo === undefined || !SAFE_SKILL.test(skill)) return fallback;
  return `${repo}@${skill}`;
}
