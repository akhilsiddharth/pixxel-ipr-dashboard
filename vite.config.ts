/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";

// Repo is published at https://<user>.github.io/pixxel-ipr-dashboard/
// so every asset (including public/deck.html and public/orders.csv) must be
// resolved under that base. Local `vite dev` overrides base to "/".
export default defineConfig({
  base: process.env.NODE_ENV === "production" ? "/pixxel-ipr-dashboard/" : "/",
  build: {
    outDir: "dist",
    target: "es2022",
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
