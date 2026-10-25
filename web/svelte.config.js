import adapter from "@sveltejs/adapter-static"
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte"

const base = process.env.PUBLIC_BASE_PATH ?? ""

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // SPA mode: the Rust service serves build/ with an index.html fallback for unknown routes.
    adapter: adapter({ fallback: "index.html" }),
    paths: {
      // Empty for the app root; set to /<repo>/demo for the GitHub Pages build.
      base,
      relative: false,
    },
    alias: {
      "@": "./src",
    },
  },
}

export default config
