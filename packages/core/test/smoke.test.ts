import test from "node:test";
import assert from "node:assert/strict";
import { PACKAGE_NAME } from "../src/index.js";

test("core package exports identity", () => {
  assert.equal(PACKAGE_NAME, "@plugin-detector/core");
});
