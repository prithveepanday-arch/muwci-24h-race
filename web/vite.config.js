import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync } from "node:fs";

const logic = fileURLToPath(new URL("../functions/shared/race-logic.js", import.meta.url));

// Generates /sw.js with the exact list of built files, so a device that opened
// the site once can reload it later with no internet.
function offlineServiceWorker() {
  return {
    name: "offline-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const publicFiles = [];
      const walk = (dir, prefix = "") => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith(".")) continue;
          if (entry.isDirectory()) walk(`${dir}/${entry.name}`, `${prefix}${entry.name}/`);
          else if (!entry.name.endsWith(".txt") && entry.name !== "sw.js") publicFiles.push(`/${prefix}${entry.name}`);
        }
      };
      walk(fileURLToPath(new URL("./public", import.meta.url)));
      const files = ["/", ...Object.keys(bundle).filter((f) => !f.endsWith(".map")).map((f) => `/${f}`), ...publicFiles];
      const version = Date.now().toString(36);
      const template = readFileSync(fileURLToPath(new URL("./src/sw-template.js", import.meta.url)), "utf8");
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: template.replace("__VERSION__", version).replace("__FILES__", JSON.stringify(files)),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), offlineServiceWorker()],
  resolve: { alias: { "@logic": logic } },
  server: {
    fs: { allow: [".."] },
    proxy: { "/api/time": { target: "http://127.0.0.1:5001", rewrite: () => "/demo-muwci/asia-south1/time" } },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true, chunkSizeWarningLimit: 900 },
});
