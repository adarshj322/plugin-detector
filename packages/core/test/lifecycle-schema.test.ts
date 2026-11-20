import test from "node:test";
import assert from "node:assert/strict";
import {
  CapabilityRecordSchema,
  LifecycleAction,
  LifecycleRowSchema,
  UpdateStatus,
} from "../src/index.js";

const baseRecord = {
  id: "superpowers",
  name: "superpowers",
  harness: "opencode",
  kind: "plugin",
  capabilities: ["workflow.sdd"],
  enabled: true,
  configRefs: ["./opencode.jsonc"],
  contextCostClass: "per-session",
};

test("capability record lifecycle fields are optional", () => {
  const record = CapabilityRecordSchema.parse(baseRecord);
  assert.equal(record.version, undefined);
  assert.equal(record.updateStatus, undefined);
  assert.equal(record.modified, undefined);
});

test("capability record accepts lifecycle evidence", () => {
  const record = CapabilityRecordSchema.parse({
    ...baseRecord,
    version: "2.1.0",
    sourceRef: "npm:@scope/pkg@2.1.0",
    installPath: "/home/user/.config/opencode/plugins/pkg",
    lastUpdated: "2026-11-01T00:00:00.000Z",
    lastUpdatedSource: "upstream",
    latestVersion: "3.0.0",
    latestSource: "https://registry.npmjs.org/@scope%2fpkg",
    updateStatus: "outdated",
    modified: false,
  });
  assert.equal(record.version, "2.1.0");
  assert.equal(record.updateStatus, "outdated");
  assert.equal(record.lastUpdatedSource, "upstream");
  assert.equal(record.modified, false);
});

test("capability record rejects unknown update status and freshness source", () => {
  assert.throws(() => UpdateStatus.parse("stale"));
  assert.throws(() =>
    CapabilityRecordSchema.parse({
      ...baseRecord,
      updateStatus: "stale",
    }),
  );
  assert.throws(() =>
    CapabilityRecordSchema.parse({
      ...baseRecord,
      lastUpdated: "not-a-date",
    }),
  );
  assert.throws(() =>
    CapabilityRecordSchema.parse({
      ...baseRecord,
      lastUpdatedSource: "somewhere",
    }),
  );
});

test("modified distinguishes unknown from false", () => {
  assert.equal(
    CapabilityRecordSchema.parse({ ...baseRecord, modified: "unknown" }).modified,
    "unknown",
  );
  assert.throws(() =>
    CapabilityRecordSchema.parse({ ...baseRecord, modified: "yes" }),
  );
});

test("lifecycle action is a closed installed-artifact set", () => {
  assert.equal(LifecycleAction.parse("replace"), "replace");
  assert.throws(() => LifecycleAction.parse("install"));
  assert.throws(() => LifecycleAction.parse("remove"));
});

test("lifecycle row parses with a candidate", () => {
  const row = {
    installedId: "superpowers",
    candidateId: "superpowers-next",
    action: "replace",
    reasons: ["candidate has a capability the installed tool lacks"],
    installedVersion: "1.4.0",
    latestVersion: "2.0.0",
    capabilitiesAdded: ["testing.runner"],
    recipe: ["back up ./opencode.jsonc", "remove superpowers", "install superpowers-next"],
  };
  assert.deepEqual(LifecycleRowSchema.parse(row), row);
});

test("lifecycle row parses without a candidate", () => {
  const row = {
    installedId: "ponytail",
    action: "keep",
    reasons: ["no comparable newer version"],
    capabilitiesAdded: [],
  };
  assert.deepEqual(LifecycleRowSchema.parse(row), row);
});

test("lifecycle row round-trips through JSON", () => {
  const row = {
    installedId: "superpowers",
    candidateId: "superpowers-next",
    action: "upgrade",
    reasons: ["same tool, newer release"],
    installedVersion: "1.4.0",
    latestVersion: "1.5.0",
    capabilitiesAdded: [],
    recipe: ["install superpowers@1.5.0"],
  };
  const parsed = LifecycleRowSchema.parse(row);
  const roundTripped = LifecycleRowSchema.parse(JSON.parse(JSON.stringify(parsed)));
  assert.deepEqual(roundTripped, parsed);
});

test("lifecycle row requires installed id, action, reasons and capabilities added", () => {
  assert.throws(() =>
    LifecycleRowSchema.parse({
      installedId: "",
      action: "keep",
      reasons: ["no comparable newer version"],
      capabilitiesAdded: [],
    }),
  );
  assert.throws(() =>
    LifecycleRowSchema.parse({
      installedId: "x",
      action: "keep",
      reasons: [],
    }),
  );
  assert.throws(() =>
    LifecycleRowSchema.parse({
      installedId: "x",
      candidateId: "",
      action: "upgrade",
      reasons: [],
      capabilitiesAdded: [],
    }),
  );
});
