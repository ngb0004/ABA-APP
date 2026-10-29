export function Status({ s }: { s: string }) {
  const cls = s === "n/a" ? "na" : s;
  return <span className={`badge ${cls}`}>{s}</span>;
}

export function RuleSource({
  r,
}: {
  r: {
    verified: boolean;
    source: { name: string | null; version: string | null; section: string | null; url: string | null };
    inheritedFrom: string | null;
  };
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
      {r.inheritedFrom ? `; inherited from ${r.inheritedFrom}` : ""} ·{" "}
      <span className={`badge ${r.verified ? "ok" : "warn"}`}>{r.verified ? "verified" : "unverified"}</span>
    </span>
  );
}
