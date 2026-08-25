import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      // String() is the deliberate fallback rendering for non-record values in toJsonValue.
      "typescript/no-base-to-string": "off",
    },
    options: { typeAware: true, typeCheck: true },
  },
});
