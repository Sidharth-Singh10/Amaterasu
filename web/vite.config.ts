import { sveltekit } from "@sveltejs/kit/vite"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    host: "127.0.0.1",
    port: 3000,
    strictPort: true,
    // Phase 1+: the Rust service owns /api; proxying keeps the browser same-origin in dev.
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
})
