import type { Metadata } from "next";
import Link from "next/link";

// One title for every 404: unknown URLs, bad ids, and records that do not exist in this org.
export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <>
      <h1>Page not found</h1>
      <p>This page does not exist, or the record it points to is not available to your organization.</p>
      <p>
        <Link href="/">Back to the caseload</Link>
      </p>
    </>
  );
}
