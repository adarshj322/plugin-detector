import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeCandidate } from "../src/index.js";
import {
  fetchMcpRegistry,
  MCP_REGISTRY_URL,
  parseMcpRegistry,
} from "../src/sources/mcp-registry.js";

const FIXTURE = fileURLToPath(
  new URL("../../../../fixtures/registry/mcp-registry.json", import.meta.url),
);

function fixturePayload(): unknown {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as unknown;
}

test("v0 MCP registry payload unwraps server entries and keeps latest version", () => {
  const raws = parseMcpRegistry(fixturePayload());
  assert.equal(raws.length, 3);
  const docs = raws.find((raw) => raw.id === "ac.tandem/docs-mcp");
  assert.ok(docs);
  assert.equal(docs.pinnedRef, "0.3.0", "isLatest must win over an older version");
  assert.equal(docs.repositoryUrl, "https://github.com/frumu-ai/tandem");
  assert.equal(docs.artifactProbed, false);

  const remote = raws.find((raw) => raw.id === "ac.inference.sh/mcp");
  assert.ok(remote);
  assert.equal(remote.repositoryUrl, "https://api.inference.sh/mcp");
  assert.equal(remote.registryUrl, undefined);

  const packaged = raws.find((raw) => raw.id === "agency.extremely/agency");
  assert.ok(packaged);
  assert.equal(packaged.packageName, "@extremely-agency/mcp");
  assert.equal(packaged.name, "EXTREMELY agency");
});

test("MCP registry records normalize as unprobed, community, unknown maintenance", () => {
  const raws = parseMcpRegistry(fixturePayload());
  const docs = raws.find((raw) => raw.id === "ac.tandem/docs-mcp");
  assert.ok(docs);
  const candidate = normalizeCandidate(docs);
  assert.equal(candidate.artifactType, "mcp-server");
  assert.equal(candidate.artifactProbed, false);
  assert.equal(candidate.installMode, "manual");
  assert.equal(candidate.maintenance, "unknown");
  assert.equal(candidate.auditStatus, "unknown");
  assert.deepEqual(candidate.capabilities, []);
});

test("a non-empty MCP payload that parses to zero records is a source failure", async () => {
  await assert.rejects(
    fetchMcpRegistry(async () => ({
      text: JSON.stringify({ servers: [{ unexpected: { shape: true } }] }),
    })),
    /listed 1 servers but none matched/,
  );
});

test("an empty MCP payload is a valid empty harvest", async () => {
  const fetch = await fetchMcpRegistry(async () => ({
    text: JSON.stringify({ servers: [] }),
  }));
  assert.deepEqual(fetch.raws, []);
  assert.equal(MCP_REGISTRY_URL, "https://registry.modelcontextprotocol.io/v0/servers");
});
