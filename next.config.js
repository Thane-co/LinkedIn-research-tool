/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Let the agent server build into its OWN directory (§20.6). `next dev` (the dashboard, which you
  // need in order to scrape) rewrites .next as a DEVELOPMENT build with no BUILD_ID, which then
  // breaks `next start` for the read-only agent server. Separate dirs mean the dashboard and the
  // agent server can run at the same time without clobbering each other.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  experimental: {
    // better-sqlite3 is a native module — keep it external to the server bundle.
    serverComponentsExternalPackages: ['better-sqlite3'],
  },
}

module.exports = nextConfig
