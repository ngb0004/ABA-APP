import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client", "playwright", "xlsx"],
  experimental: { serverActions: { bodySizeLimit: "5mb" } },
  poweredByHeader: false,
  // The e2e server builds into its own directory so it never collides with `pnpm dev`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
