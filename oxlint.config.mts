import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

export default defineConfig({
  env: core.env,
  extends: [core, antiSlop],
  ignorePatterns: core.ignorePatterns,
  options: {
    reportUnusedDisableDirectives: "error",
    respectEslintDisableDirectives: false,
  },
  rules: {
    // pi resolves only these pi-ai entry points inside a loaded extension. Others fail with "Cannot find module".
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          "@earendil-works/pi-ai/**",
          "!@earendil-works/pi-ai/compat",
          "!@earendil-works/pi-ai/models",
          "!@earendil-works/pi-ai/oauth",
          "!@earendil-works/pi-ai/providers/all",
        ],
      },
    ],
  },
});
