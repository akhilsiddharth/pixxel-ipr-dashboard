import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The exact CSV the dashboard ships and computes from at runtime. */
export const csvText = readFileSync(
  fileURLToPath(new URL("../public/orders.csv", import.meta.url)),
  "utf8",
);
