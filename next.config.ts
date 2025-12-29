import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    allowedDevOrigins: [
      '172.20.10.14:3000',
      '192.168.187.1:3000', 
      '192.168.136.1:3000',
      '172.25.32.1:3000',
      'localhost:3000'
    ]
  }
};

export default nextConfig;
