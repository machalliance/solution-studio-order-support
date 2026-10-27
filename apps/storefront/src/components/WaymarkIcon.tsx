// The chosen logo mark ("Horizon Dot — Rising"): a sun clearing a line, with a second,
// fainter line beneath for depth. That faint line thins out below ~24px, so `simple`
// drops it for genuinely small contexts (the favicon) — see app/icon.svg, which is this
// same shape hand-copied to a standalone file (no CSS custom properties there).
// secondLineOpacity is a per-instance override rather than a fixed value — the footer
// runs the icon bigger, where the second line can afford to read as more than a hint.
export function WaymarkIcon({
  size = 22,
  simple = false,
  secondLineOpacity = 0.35,
}: {
  size?: number;
  simple?: boolean;
  secondLineOpacity?: number;
}) {
  const height = Math.round((size / 40) * 26);
  return (
    <svg width={size} height={height} viewBox="0 0 40 26" fill="none" aria-hidden="true" className="waymark-icon">
      <circle cx="20" cy="9" r="6" className="waymark-sun" />
      <line x1="4" y1="17" x2="36" y2="17" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      {!simple && (
        <line x1="11" y1="22" x2="29" y2="22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity={secondLineOpacity} />
      )}
    </svg>
  );
}
