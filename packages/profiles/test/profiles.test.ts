import test from "node:test";
import assert from "node:assert/strict";
import { CANONICAL_CAPABILITY_IDS } from "@plugin-detector/core";
import {
  UseCaseProfileSchema,
  loadProfiles,
  parseProfileText,
} from "../src/index.js";

const EXPECTED_IDS = [
  "software-development",
  "video-editing",
  "research-writing",
  "data-analysis",
  "devops-infrastructure",
  "design-frontend",
];

const CANONICAL = new Set<string>([
  ...(CANONICAL_CAPABILITY_IDS as readonly string[]),
]);

test("all six v1 profiles load and validate", () => {
  const profiles = loadProfiles();
  assert.deepEqual(
    profiles.map((p) => p.id).sort(),
    [...EXPECTED_IDS].sort(),
  );
  for (const profile of profiles) {
    assert.deepEqual(UseCaseProfileSchema.parse(profile), profile);
  }
});

test("profiles use canonical capability IDs, bounded signal queries, and full sections", () => {
  for (const profile of loadProfiles()) {
    for (const cap of profile.capabilities) {
      assert.ok(CANONICAL.has(cap), `${profile.id} has non-canonical ${cap}`);
    }
    assert.ok(
      profile.signalQueries.length >= 5 && profile.signalQueries.length <= 12,
      `${profile.id} must declare 5-12 signal queries`,
    );
    assert.ok(profile.negativeSignals.length > 0, `${profile.id} needs negatives`);
    assert.ok(profile.defaultDomains.length > 0, `${profile.id} needs domains`);
    assert.ok(
      profile.expectedValueTiers.length > 0,
      `${profile.id} needs value tiers`,
    );
    assert.ok(profile.version > 0, `${profile.id} must be versioned`);
  }
});

test("video-editing carries media capabilities with publishing/cleanup domains and no coding domains", () => {
  const video = loadProfiles().find((p) => p.id === "video-editing");
  assert.ok(video);
  const caps: readonly string[] = video.capabilities;
  for (const cap of ["media.transcode", "speech.captions", "design.thumbnail"]) {
    assert.ok(caps.includes(cap), `video-editing needs ${cap}`);
  }
  assert.ok(video.defaultDomains.includes("publishing"));
  assert.ok(video.defaultDomains.includes("cleanup"));
  for (const domain of video.defaultDomains) {
    assert.ok(
      !/cod/i.test(domain),
      `video-editing must not include coding domain ${domain}`,
    );
  }
});

test("profile ids are unique", () => {
  const ids = loadProfiles().map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("yaml subset parser accepts the documented shape", () => {
  const profile = parseProfileText(
    [
      "id: demo",
      "version: 2",
      'displayName: "Demo"',
      "description: demo profile",
      "capabilities:",
      "  - docs.writing",
      "signalQueries:",
      "  - q1",
      "  - q2",
      "  - q3",
      "  - q4",
      "  - q5",
      "negativeSignals:",
      "  - n1",
      "defaultDomains:",
      "  - writing",
      "expectedValueTiers:",
      "  - time-saved",
      "",
      "# trailing comment",
    ].join("\n"),
    "demo.yaml",
  );
  assert.equal(profile.id, "demo");
  assert.equal(profile.version, 2);
  assert.deepEqual(profile.capabilities, ["docs.writing"]);
});

test("yaml subset treats comments, anchors, aliases, and block indicators literally", () => {
  const fields = (description: string): string[] => [
    "id: demo",
    "version: 1",
    "displayName: Demo",
    `description: ${description}`,
    "capabilities:",
    "  - docs.writing",
    "signalQueries:",
    "  - q1",
    "  - q2",
    "  - q3",
    "  - q4",
    "  - q5",
    "negativeSignals:",
    "  - n1",
    "defaultDomains:",
    "  - writing",
    "expectedValueTiers:",
    "  - time-saved",
  ];

  // Only full-line comments are comments; an inline "# ..." is scalar text.
  assert.equal(
    parseProfileText(
      [...fields("demo # inline is literal"), "# full-line comment"].join("\n"),
      "demo.yaml",
    ).description,
    "demo # inline is literal",
  );

  // Anchors and aliases have no YAML meaning here: they stay literal strings.
  const anchored = parseProfileText(
    [
      ...fields("&anchor"),
      "negativeSignals:",
      "  - *alias",
    ].join("\n").replace("negativeSignals:\n  - n1\n", ""),
    "demo.yaml",
  );
  assert.equal(anchored.description, "&anchor");
  assert.deepEqual(anchored.negativeSignals, ["*alias"]);

  // A block scalar indicator is a literal "|"; its indented body is still
  // rejected as a nested map rather than guessed.
  assert.throws(
    () => parseProfileText([...fields("|"), "  body line"].join("\n"), "demo.yaml"),
    /nested maps are not supported/,
  );
});

test("yaml subset parser rejects nested maps and non-canonical capabilities", () => {
  assert.throws(() =>
    parseProfileText("id: demo\nnested:\n  key: value\n  deeper:\n    x: 1\n", "bad.yaml"),
  );
  assert.throws(() =>
    parseProfileText(
      "id: demo\nversion: 1\ndisplayName: Demo\ndescription: d\ncapabilities:\n  - banana.peeling\nsignalQueries:\n  - q1\n  - q2\n  - q3\n  - q4\n  - q5\ndefaultDomains:\n  - writing\nexpectedValueTiers:\n  - time-saved\n",
      "demo.yaml",
    ),
  );
});
