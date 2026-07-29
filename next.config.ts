import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  images: {
    // Avatars come from GitLab, Gravatar, Jira and HiBob rather than our own host.
    remotePatterns: [
      { protocol: 'https', hostname: '**.gitlab.com' },
      { protocol: 'https', hostname: 'secure.gravatar.com' },
      { protocol: 'https', hostname: '**.hibob.com' },
      { protocol: 'https', hostname: '**.atlassian.net' },
    ],
  },
}

export default nextConfig
