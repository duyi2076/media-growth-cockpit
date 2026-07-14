import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { dailyTasksApiPlugin } from "./server/vite-plugin.mjs";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const vaultRoot = env.V2_VAULT_ROOT || env.OBSIDIAN_VAULT_ROOT || undefined;
  const stateRoot = env.COCKPIT_STATE_ROOT || undefined;
  return ({
    plugins: [react(), dailyTasksApiPlugin({ root: vaultRoot, stateRoot })],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
    },
    preview: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: true,
    },
    build: {
      outDir: "dist",
      sourcemap: true,
    },
  });
});
