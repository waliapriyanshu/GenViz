/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // libpg-query loads its .wasm file from its own directory, so it must not be bundled.
  serverExternalPackages: ["libpg-query", "pg", "pg-connection-string"],
  outputFileTracingIncludes: {
    "/api/**/*": ["./node_modules/libpg-query/wasm/libpg-query.wasm"],
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
