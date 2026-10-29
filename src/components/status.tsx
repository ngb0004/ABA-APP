export function Status({ s }: { s: string }) {
  const cls = s === "n/a" ? "na" : s;
  return <span className={`badge ${cls}`}>{s}</span>;
}

type TrustLike = {
  status: string;
  tier: string | null;
  reasons: string[];
  verifiedUntil: string | null;
  verifiedAt: string | null;
};

const TRUST_LABEL: Record<string, string> = {
  verified: "verified",
  unverified: "unverified",
  stale: "needs re-check",
  unsourced: "no source",
};

export function TrustBadge({ trust, verified }: { trust?: TrustLike; verified: boolean }) {
  const status = trust?.status ?? (verified ? "verified" : "unverified");
  return (
    <span className={`badge ${status}`} data-testid="trust-badge">
      {TRUST_LABEL[status] ?? status}
      {trust?.tier ? ` · ${trust.tier}` : ""}
    </span>
  );
}

export function RuleSource({
  r,
  showReasons = true,
}: {
  r: {
    verified: boolean;
    trust?: TrustLike;
    source: {
      name: string | null;
      version: string | null;
      section: string | null;
      url: string | null;
      page?: string | null;
      quote?: string | null;
    };
    inheritedFrom: string | null;
  };
  showReasons?: boolean;
}) {
  return (
    <span className="muted">
      {r.source.url ? (
        <a href={r.source.url} target="_blank" rel="noreferrer">
          {r.source.name}
        </a>
      ) : (
        (r.source.name ?? "No source recorded")
      )}
      {r.source.version ? ` (${r.source.version})` : ""}
      {r.source.section ? `, ${r.source.section}` : ""}
      {r.source.page ? `, p. ${r.source.page}` : ""}
      {r.inheritedFrom ? `; inherited from ${r.inheritedFrom}` : ""} ·{" "}
      <TrustBadge trust={r.trust} verified={r.verified} />
      {r.trust?.verifiedUntil && r.trust.status === "verified" && (
        <> · verified until {r.trust.verifiedUntil}</>
      )}
      {showReasons && r.source.quote && (
        <span style={{ display: "block" }}>Source says: &ldquo;{r.source.quote}&rdquo;</span>
      )}
      {showReasons && r.trust && r.trust.status !== "verified" && r.trust.reasons.length > 0 && (
        <span style={{ display: "block" }}>{r.trust.reasons.slice(0, 2).join(" · ")}</span>
      )}
    </span>
  );
}
