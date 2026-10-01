import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// libpg-query reads libpg-query.wasm from its own directory at runtime, which file
// tracing can't detect. Trace it at its real path: with pnpm, node_modules/libpg-query
// is a symlink, and Vercel rejects functions containing files traced through a
// symlinked directory.
const libpgQueryWasm = path.relative(
  root,
  path.join(
    path.dirname(realpathSync(require.resolve("libpg-query"))),
    "libpg-query.wasm",
  ),
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // libpg-query loads its .wasm file from its own directory, so it must not be bundled.
  serverExternalPackages: ["libpg-query", "pg", "pg-connection-string"],
  outputFileTracingIncludes: {
    "/api/**/*": [`./${libpgQueryWasm}`],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), geolocation=(), microphone=(self)",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
