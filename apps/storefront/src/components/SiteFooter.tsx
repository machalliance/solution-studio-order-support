import { WaymarkIcon } from "./WaymarkIcon";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <img src="/mach-logo.svg" alt="MACH Alliance" className="site-footer-logo" />
      <div className="site-footer-brand">
        <WaymarkIcon size={30} secondLineOpacity={0.65} />
        <span className="site-footer-wordmark">WAYBOUND</span>
      </div>
      <p className="site-footer-tagline">Casual gear for road trips, national parks, and light hikes.</p>
    </footer>
  );
}
