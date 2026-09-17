import adapter from "@sveltejs/adapter-static"
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte"

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // SPA mode: the Rust service serves build/ with an index.html fallback for unknown routes.
    adapter: adapter({ fallback: "index.html" }),
    alias: {
      "@": "./src",
    },
  },
}

export default config
