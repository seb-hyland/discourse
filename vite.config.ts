import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("src/ui", import.meta.url)),
  // Relative, as the packaged app loads the build from disk.
  base: "./",
  plugins: [react()],
  // The packaged app loads this build, so it doesn't need Vite.
  build: { outDir: fileURLToPath(new URL("dist", import.meta.url)), emptyOutDir: true },
});
