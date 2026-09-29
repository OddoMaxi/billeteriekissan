import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Import des designs de billets (fichiers jusqu'à 15 Mo + marge multipart).
    serverActions: { bodySizeLimit: "16mb" },
  },
};

export default nextConfig;
