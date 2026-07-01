/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // better-sqlite3 is a native module — keep it external to the server bundle.
    serverComponentsExternalPackages: ['better-sqlite3'],
  },
}

module.exports = nextConfig
