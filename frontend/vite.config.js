import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During dev, proxy API calls to the FastAPI backend on :8000 so the frontend
// can just call "/api/..." without worrying about CORS or ports.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});
