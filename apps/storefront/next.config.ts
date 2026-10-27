import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Next.js only auto-loads .env files from THIS app's own directory — never a monorepo
// root — so the shared root .env (everything else in this repo reads via
// --env-file-if-exists or a similar explicit mechanism) was silently invisible here.
// Load it explicitly, first, before reading any of the values below. fileURLToPath
// instead of __dirname since this file's module format (CJS vs ESM) depends on how
// Next's own config loader transpiles it, not this package's own "type" field.
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "../../.env"), quiet: true });

// Next.js dev mode blocks cross-origin requests to its own dev infrastructure (HMR,
// dev bundle resources) by default — testing from a phone over the LAN gets silently
// blocked at that layer, which looks like "nothing responds" (hydration never
// finishes) even though the page itself loads and the agent API is reachable fine.
// DEV_LAN_HOST is the machine's own LAN IP (or hostname) — set once per network in
// .env, not hardcoded here, since it changes across networks/DHCP leases.
const devLanHost = process.env.DEV_LAN_HOST;

// Same block applies to a public hostname the dev server is reached through (for example behind a reverse proxy) —
// without it, the HMR WebSocket's Origin check rejects the upgrade, the proxy can't cleanly relay that rejection
// (surfaces as a 502 "malformed HTTP response"), and Next's HMR client retries forever — live-reproduced as a login
// prompt that never stopped looping on a phone over cellular. DEV_PUBLIC_HOST is that hostname, set in .env; unset
// (the default) adds nothing.
const devPublicHost = process.env.DEV_PUBLIC_HOST;

const nextConfig: NextConfig = {
  allowedDevOrigins: [...(devLanHost ? [devLanHost] : []), ...(devPublicHost ? [devPublicHost] : [])],
  // Next's own dev tools indicator (the "N" badge + popup) is built for desktop
  // development and isn't guaranteed to respect mobile-safe widths. It only started
  // successfully connecting once allowedDevOrigins let it through — the horizontal
  // overflow on every page, in both orientations, showed up at exactly that point, and
  // this stylesheet has no rule that could cause it. Off for real mobile testing; not a
  // production concern either way since this indicator never ships in a build.
  devIndicators: false,
};

export default nextConfig;
