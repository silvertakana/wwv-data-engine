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
      // Pre-existing debt: scattered `any` usages. Promote to error after cleanup.
      "@typescript-eslint/no-explicit-any": "warn",
      // Unused vars warn (args starting with `_` are intentionally unused). Promote after cleanup.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      // Server process: console logging is intentional.
      "no-console": "off",
    },
  },
);
