import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const projectRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, "");
  const apiHost = env.API_HOST || "127.0.0.1";
  const apiPort = env.API_PORT || "8000";
  const frontendHost = env.FRONTEND_HOST || "127.0.0.1";
  const frontendPort = Number(env.FRONTEND_PORT || "5173");
  const proxy = {
    "/api": {
      target: `http://${apiHost}:${apiPort}`,
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/api/, ""),
    },
  };

  return {
    envDir: projectRoot,
    plugins: [react()],
    server: {
      host: frontendHost,
      port: frontendPort,
      strictPort: true,
      proxy,
    },
    preview: {
      host: frontendHost,
      port: frontendPort + 1,
      proxy,
    },
  };
});
