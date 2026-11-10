import type { NextConfig } from "next";
import path from "node:path";

// The browser only ever talks to this app's own origin. /api/* is proxied to the Lane A backend,
// so no CORS is needed and the backend stays unchanged.
const API_ORIGIN = (process.env.API_ORIGIN ?? "https://receipts-api-2n1g.onrender.com").replace(/\/$/, "");

const nextConfig: NextConfig = {
  turbopack: { root: path.join(__dirname, "..") }, // lets us import ../lib/contract.ts
  outputFileTracingRoot: path.join(__dirname, ".."),
  // The proxy gives up after 30 s by default. The AI dispute draft runs three models in a row and can take longer,
  // and the backend keeps going after the browser is cut off, so wait for it.
  experimental: { proxyTimeout: 180_000 },
  poweredByHeader: false,
  // No other site may frame these pages: a hidden frame could trick a client into pressing "Accept and release".
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Strict-Transport-Security", value: "max-age=31536000" },
      ],
    }];
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_ORIGIN}/api/:path*` }];
  },
};

export default nextConfig;
