import type { NextConfig } from "next";
import path from "node:path";

// The browser only ever talks to this app's own origin. /api/* is proxied to the Lane A backend,
// so no CORS is needed and the backend stays unchanged.
const API_ORIGIN = (process.env.API_ORIGIN ?? "https://receipts-api-2n1g.onrender.com").replace(/\/$/, "");

const nextConfig: NextConfig = {
  turbopack: { root: path.join(__dirname, "..") }, // lets us import ../lib/contract.ts
  outputFileTracingRoot: path.join(__dirname, ".."),
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_ORIGIN}/api/:path*` }];
  },
};

export default nextConfig;
