import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client", "playwright", "xlsx", "tesseract.js", "mammoth"],
  experimental: { serverActions: { bodySizeLimit: "5mb" } },
  poweredByHeader: false,
  // The e2e server builds into its own directory so it never collides with `pnpm dev`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders(process.env.NODE_ENV === "production") }];
  },
};

export default nextConfig;
