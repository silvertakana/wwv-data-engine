import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Global ignores: build output, deps, and coverage are never linted.
    ignores: ["node_modules/**", "dist/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Strict: no explicit `any` — replace with precise types or narrowed `unknown`. Never suppress.
      "@typescript-eslint/no-explicit-any": "error",
      // Strict: unused vars are dead code; params prefixed with `_` are allowed for interface contracts.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // Server process: console logging is intentional.
      "no-console": "off",
    },
  },
);
