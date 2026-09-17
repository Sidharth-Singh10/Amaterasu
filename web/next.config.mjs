/** @type {import('next').NextConfig} */
const nextConfig = {
  // The Rust service hosts the built frontend; the Next.js app has no server routes.
  output: "export",
  transpilePackages: ["@amaterasu/chart-dsl"],
  reactStrictMode: true,
  images: { unoptimized: true },
  // Dev-only: allow 127.0.0.1 access alongside localhost (Next 16 blocks cross-origin dev resources).
  allowedDevOrigins: ["127.0.0.1", "localhost"],
}

export default nextConfig
