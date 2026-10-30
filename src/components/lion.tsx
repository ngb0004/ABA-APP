/** Yoma's lion: a friendly round-maned face. Drawn for this app (no third-party artwork). */
export function Lion({ size = 40, title = "Yoma" }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title}>
      <g fill="#FED100">
        <circle cx="53.00" cy="33.00" r="9" />
        <circle cx="50.19" cy="43.50" r="9" />
        <circle cx="42.50" cy="51.19" r="9" />
        <circle cx="32.00" cy="54.00" r="9" />
        <circle cx="21.50" cy="51.19" r="9" />
        <circle cx="13.81" cy="43.50" r="9" />
        <circle cx="11.00" cy="33.00" r="9" />
        <circle cx="13.81" cy="22.50" r="9" />
        <circle cx="21.50" cy="14.81" r="9" />
        <circle cx="32.00" cy="12.00" r="9" />
        <circle cx="42.50" cy="14.81" r="9" />
        <circle cx="50.19" cy="22.50" r="9" />
        <circle cx="32" cy="33" r="22" />
      </g>
      <g fill="#E8A900">
        <circle cx="19" cy="18" r="6" />
        <circle cx="45" cy="18" r="6" />
      </g>
      <g fill="#FFE9A8">
        <circle cx="19" cy="18" r="3" />
        <circle cx="45" cy="18" r="3" />
      </g>
      <circle cx="32" cy="34" r="16" fill="#FFF3CC" />
      <ellipse cx="32" cy="41" rx="8" ry="6" fill="#FFFBEA" />
      <g fill="#0B0B0B">
        <ellipse cx="26" cy="31" rx="2.4" ry="2.9" />
        <ellipse cx="38" cy="31" rx="2.4" ry="2.9" />
        <path d="M28.6 37.2h6.8c.9 0 1.4 1 .8 1.7l-3.4 3.3a1.1 1.1 0 0 1-1.6 0l-3.4-3.3c-.6-.7-.1-1.7.8-1.7z" />
      </g>
      <g fill="#FFFFFF">
        <circle cx="26.8" cy="30" r=".9" />
        <circle cx="38.8" cy="30" r=".9" />
      </g>
      <path
        d="M32 42.2v1.6m0 0c-1 1.5-3 1.8-4.3.8m4.3-.8c1 1.5 3 1.8 4.3.8"
        fill="none"
        stroke="#0B0B0B"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <g fill="#F7A8A8" opacity=".55">
        <circle cx="22.5" cy="38" r="2.4" />
        <circle cx="41.5" cy="38" r="2.4" />
      </g>
    </svg>
  );
}
