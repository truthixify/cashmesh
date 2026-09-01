import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  allowedDevOrigins: ["127.0.0.1"],
  devIndicators: false,
  reactStrictMode: true,
  transpilePackages: ["@cashmesh/domain"],
};

export default nextConfig;
