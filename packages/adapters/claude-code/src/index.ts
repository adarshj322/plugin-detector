export const PACKAGE_NAME = "@plugin-detector/claude-code";
export * from "./adapter.js";
// Re-exported from the shared adapter helpers so existing imports keep
// working after the extraction (no third copy lives here).
export { stripJsonc } from "@plugin-detector/adapter-shared";
