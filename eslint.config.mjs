import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const config = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "dist/**",
      "drizzle/**",
      "scripts/**",
      "next-env.d.ts",
      ".tmp-seed-demo.mjs",
      // 017 — bundle temporal del seed de inventario, mismo caso que el demo.
      ".tmp-seed-inventory.mjs",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];

export default config;
