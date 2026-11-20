import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Import des designs de billets (fichiers jusqu'à 15 Mo + marge multipart).
    serverActions: { bodySizeLimit: "16mb" },
  },
  async headers() {
    return [
      {
        // Service worker du contrôle hors connexion : toujours relu, pour que les mises à jour arrivent.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
