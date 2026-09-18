import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const stub = (name: string) => fileURLToPath(new URL(`./__tests__/stubs/${name}.ts`, import.meta.url));

export default defineConfig({
  plugins: [{
    name: "text-modules",
    transform: (code, id) => (id.endsWith(".txt") ? `export default ${JSON.stringify(code)};` : null),
  }],
  resolve: {
    alias: {
      "cloudflare:workers": stub("cloudflare-workers"),
      "capnweb-validate": stub("capnweb-validate"),
    },
  },
  test: {
    include: ["__tests__/**/*.test.ts"],
    exclude: [".wrangler/**", "node_modules/**"],
  },
});
