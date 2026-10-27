import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// See apps/storefront/next.config.ts — same reason and same caveats.
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "../../.env"), quiet: true });

const devLanHost = process.env.DEV_LAN_HOST;

// See apps/storefront/next.config.ts — same public-host addition, same reason.
const devPublicHost = process.env.DEV_PUBLIC_HOST;

const nextConfig: NextConfig = {
  allowedDevOrigins: [...(devLanHost ? [devLanHost] : []), ...(devPublicHost ? [devPublicHost] : [])],
  // See apps/storefront/next.config.ts — same dev-tools-indicator overflow risk on mobile.
  devIndicators: false,
};

export default nextConfig;
