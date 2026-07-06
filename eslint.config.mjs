import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const config = tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["node_modules/**", "dist/**"],
  },
  {
    rules: {
      // Demoted on first introduction to make CI pass without blocking
      // on pre-existing debt. Promote back once addressed.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": "off",
    },
  }
);

export default config;
