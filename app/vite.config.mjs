import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
  const isDevMode = mode !== "production";
  const backend = `http://127.0.0.1:${isDevMode ? 3001 : 3002}`;
  const frontendPort = isDevMode ? 5173 : 8080;

  return {
    server: {
      host: "0.0.0.0",
      port: frontendPort,
      strictPort: true,
      proxy: {
        "/api": { target: backend, changeOrigin: true },
        "/uploads": { target: backend, changeOrigin: true },
        "/socket.io": {
          target: backend,
          ws: true,
          changeOrigin: true,
        },
      },
    },
  };
});
