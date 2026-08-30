import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // No ESLint config in this proof; don't let a missing lint setup fail `next build`.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
