import type { CanonicalCapabilityId } from "@plugin-detector/core";

// Deterministic capability inference for probed artifact evidence only. Each
// rule is an explicit phrase list; the phrase itself is the minimum evidence,
// and generic words ("search", "cloud", "video") intentionally map to nothing.
interface CapabilityRule {
  id: CanonicalCapabilityId;
  patterns: readonly RegExp[];
}

const RULES: readonly CapabilityRule[] = [
  {
    id: "testing.runner",
    patterns: [
      /\btest runners?\b/i,
      /\bunit tests?\b/i,
      /\bunit testing\b/i,
      /\btest frameworks?\b/i,
      /\bpytest\b/i,
      /\bvitest\b/i,
    ],
  },
  {
    id: "testing.e2e",
    patterns: [
      /\bend[\s-]+to[\s-]+end[\s-]+tests?(ing)?\b/i,
      /\be2e tests?(ing)?\b/i,
      /\be2e suites?\b/i,
      /\bcypress\b/i,
      /\bbrowser[\s-]+end[\s-]+to[\s-]+end\b/i,
    ],
  },
  {
    id: "code-review.quality",
    patterns: [
      /\bcode reviews?\b/i,
      /\bpull request reviews?\b/i,
      /\bstatic analysis\b/i,
      /\blinters?\b/i,
      /\blinting\b/i,
      /\bcode quality\b/i,
    ],
  },
  {
    id: "code-review.security",
    patterns: [
      /\bsecurity reviews?\b/i,
      /\bsecurity audits?\b/i,
      /\bsecurity scanners?\b/i,
      /\bsecurity scanning\b/i,
      /\bsast\b/i,
      /\bsecret scanning\b/i,
    ],
  },
  {
    id: "planning.orchestration",
    patterns: [
      /\btask orchestration\b/i,
      /\bworkflow orchestration\b/i,
      /\b(multi[\s-]+)?agent[\s-]+orchestration\b/i,
      /\bproject planning\b/i,
      /\borchestrators?\b/i,
    ],
  },
  {
    id: "planning.brainstorm",
    patterns: [
      /\bbrainstorm(ing)?\b/i,
      /\bidea generation\b/i,
      /\bdesign thinking\b/i,
      /\bideation\b/i,
    ],
  },
  {
    id: "debugging.systematic",
    patterns: [
      /\bsystematic debugging\b/i,
      /\broot cause analysis\b/i,
      /\bdebuggers?\b/i,
      /\bstack trace analysis\b/i,
      /\breproduction steps\b/i,
    ],
  },
  {
    id: "vcs.workflow",
    patterns: [
      /\bgit workflow\b/i,
      /\bversion control\b/i,
      /\bbranch management\b/i,
      /\bmerge conflicts?\b/i,
      /\bpull request workflow\b/i,
      /\bcommit history\b/i,
    ],
  },
  {
    id: "ci.release",
    patterns: [
      /\bcontinuous integration\b/i,
      /\bci pipelines?\b/i,
      /\bgithub actions\b/i,
      /\bgitlab ci\b/i,
      /\brelease automation\b/i,
      /\bcircleci\b/i,
    ],
  },
  {
    id: "containers.orchestration",
    patterns: [
      /\bdocker\b/i,
      /\bkubernetes\b/i,
      /\bcontainer orchestration\b/i,
      /\bhelm charts?\b/i,
      /\bk8s clusters?\b/i,
      /\bcontainer images?\b/i,
    ],
  },
  {
    id: "cloud.infra",
    patterns: [
      /\bterraform\b/i,
      /\bcloudformation\b/i,
      /\binfrastructure as code\b/i,
      /\bpulumi\b/i,
      /\bcloud infrastructure\b/i,
      /\baws cdk\b/i,
    ],
  },
  {
    id: "docs.writing",
    patterns: [
      /\bwrit(e|es|ing) documentation\b/i,
      /\btechnical writing\b/i,
      /\btechnical documentation\b/i,
      /\bdocumentation (site|generator|tool|mcp)\b/i,
      /\bapi docs?\b/i,
      /\bdocs site\b/i,
    ],
  },
  {
    id: "design.frontend",
    patterns: [
      /\bfront[\s-]?end\b/i,
      /\bui design\b/i,
      /\breact components?\b/i,
      /\btailwind\b/i,
      /\bcomponent librar(y|ies)\b/i,
      /\bcss styling\b/i,
    ],
  },
  {
    id: "design.thumbnail",
    patterns: [
      /\bthumbnails?\b/i,
      /\bcover images?\b/i,
      /\bvideo thumbnails?\b/i,
    ],
  },
  {
    id: "data.analysis",
    patterns: [
      /\bdata analy(sis|tics)\b/i,
      /\bdataframes?\b/i,
      /\bpandas\b/i,
      /\bstatistical analysis\b/i,
      /\bdata visuali[sz]ation\b/i,
    ],
  },
  {
    id: "data.database",
    patterns: [
      /\bdatabases?\b/i,
      /\bpostgres(ql)?\b/i,
      /\bmysql\b/i,
      /\bsqlite\b/i,
      /\bmongodb\b/i,
      /\bredis\b/i,
    ],
  },
  {
    id: "browser.automation",
    patterns: [
      /\bbrowser automation\b/i,
      /\bheadless browsers?\b/i,
      /\bplaywright\b/i,
      /\bpuppeteer\b/i,
      /\bselenium\b/i,
      /\bchrome devtools\b/i,
    ],
  },
  {
    id: "search.web",
    patterns: [
      /\bweb search\b/i,
      /\bsearch engines?\b/i,
      /\bgoogle search\b/i,
      /\bbrave search\b/i,
      /\btavily\b/i,
      /\bserp api\b/i,
    ],
  },
  {
    id: "media.transcode",
    patterns: [
      /\btranscod(e|es|ing)\b/i,
      /\bvideo conversions?\b/i,
      /\bffmpeg\b/i,
      /\bcodecs?\b/i,
      /\bbitrates?\b/i,
    ],
  },
  {
    id: "media.video",
    patterns: [
      /\bvideo editing\b/i,
      /\bvideo editors?\b/i,
      /\bvideo production\b/i,
      /\bvideo rendering\b/i,
      /\bvideo generation\b/i,
      /\bvideo processing\b/i,
    ],
  },
  {
    id: "media.image",
    patterns: [
      /\bimage editing\b/i,
      /\bimage generation\b/i,
      /\bimage processing\b/i,
      /\bphoto editing\b/i,
      /\bimage upscaling\b/i,
      /\bimage optimization\b/i,
    ],
  },
  {
    id: "speech.captions",
    patterns: [
      /\bcaptions?\b/i,
      /\bsubtitles?\b/i,
      /\bspeech[\s-]+to[\s-]+text\b/i,
      /\btranscription\b/i,
      /\bwhisper\b/i,
      /\bspeech recognition\b/i,
    ],
  },
  {
    id: "collaboration.chat",
    patterns: [
      /\bchat integrations?\b/i,
      /\bchat platforms?\b/i,
      /\bteam chats?\b/i,
      /\bmicrosoft teams\b/i,
      /\bslack (integrations?|bots?|mcp|connectors?)\b/i,
      /\bdiscord (bots?|integrations?)\b/i,
    ],
  },
  {
    id: "publishing.delivery",
    patterns: [
      /\bcontent publishing\b/i,
      /\bpublishing pipelines?\b/i,
      /\bheadless cms\b/i,
      /\bcontent delivery\b/i,
      /\bpublish to cdn\b/i,
      /\bblog publishing\b/i,
    ],
  },
  {
    id: "security.dependencies",
    patterns: [
      /\bdependency scanning\b/i,
      /\bdependency audits?\b/i,
      /\bdependency vulnerabilit(y|ies)\b/i,
      /\bnpm audit\b/i,
      /\bsoftware composition analysis\b/i,
      /\bsbom\b/i,
    ],
  },
  {
    id: "harness.management",
    patterns: [
      /\bharness management\b/i,
      /\bagent harness\b/i,
      /\bmcp server management\b/i,
      /\bplugin management\b/i,
      /\bskill management\b/i,
      /\bharness configuration\b/i,
    ],
  },
];

const MAX_CAPABILITIES = 8;
const MAX_EVIDENCE_LENGTH = 300;
const EVIDENCE_CONTEXT = 40;

// Instruction-override copy is never evidence (same narrow shape as the probe
// gate): explicit-looking capabilities inside it must not be trusted.
const INSTRUCTION_OVERRIDE =
  /\b(ignore|disregard)\s+(all\s+)?(previous|prior|above|earlier|preceding)\s+(instructions?|prompts?)\b|\bnew\s+system\s+prompt\b|\byou\s+are\s+now\s+(an?\s+)?(unrestricted|root|admin|different)\b/i;

// Strip C0/C1 controls, unicode format characters (zero-width, bidi), and
// lone surrogates so hidden characters cannot evade or forge a phrase match.
function sanitize(value: string): string {
  return value
    .normalize("NFC")
    // Line breaks and tabs separate tokens; deleting them would glue
    // "uses\nTerraform" into "usesTerraform".
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]/gu, " ")
    // `_` and `-` are word separators in artifact names (`postgres_helper`,
    // `code-review-mcp`) but word characters/boundaries to \b. Treat both as
    // spaces without loosening boundaries, so "databased" stays rejected.
    .replace(/[_-]/gu, " ")
    // Delete remaining controls and invisible format characters.
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function truncate(value: string): string {
  if (value.length <= MAX_EVIDENCE_LENGTH) return value;
  let cut = value.slice(0, MAX_EVIDENCE_LENGTH);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut;
}

interface Hit {
  id: CanonicalCapabilityId;
  index: number;
  matched: string;
}

function evidenceFor(hit: Hit, haystack: string): string {
  const start = Math.max(0, hit.index - EVIDENCE_CONTEXT);
  const end = Math.min(
    haystack.length,
    hit.index + hit.matched.length + EVIDENCE_CONTEXT,
  );
  const context = haystack.slice(start, end).trim();
  return truncate(
    `${hit.id}: matched ${JSON.stringify(hit.matched)} at offset ${hit.index}: ${context}`,
  );
}

// Infer only from caller-supplied trusted evidence text (bounded probe
// snippets) plus the probed artifact name. Returns one snippet per capability,
// deterministic and alphabetically sorted, capped at 8.
export function inferCapabilities(
  text: string,
  artifactName: string,
): { capabilities: string[]; evidence: string[] } {
  const name = sanitize(artifactName);
  const body = sanitize(text);
  const haystack = [name, body].filter((part) => part.length > 0).join(" ");
  if (haystack.length === 0 || INSTRUCTION_OVERRIDE.test(haystack)) {
    return { capabilities: [], evidence: [] };
  }

  const hits: Hit[] = [];
  for (const rule of RULES) {
    let best: Hit | undefined;
    for (const pattern of rule.patterns) {
      const match = pattern.exec(haystack);
      if (!match) continue;
      if (best === undefined || match.index < best.index) {
        best = { id: rule.id, index: match.index, matched: match[0] };
      }
    }
    if (best !== undefined) hits.push(best);
  }

  hits.sort(
    (a, b) =>
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || a.index - b.index,
  );
  const selected = hits.slice(0, MAX_CAPABILITIES);
  return {
    capabilities: selected.map((hit) => hit.id),
    evidence: selected.map((hit) => evidenceFor(hit, haystack)),
  };
}
