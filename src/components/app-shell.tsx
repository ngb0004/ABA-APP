"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Lion } from "./lion";
import { APP_NAME } from "@/lib/brand";

type NavItem = { href: string; label: string; icon: ReactNode };

const I = (d: string) => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);
const ICONS = {
  caseload: I("M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z"),
  clients: I(
    "M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M21 19v-1a4 4 0 0 0-3-3.9M15.5 3.1a3.5 3.5 0 0 1 0 6.8",
  ),
  payors: I("M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6zM9 12l2 2 4-4"),
  audit: I("M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"),
  settings: I(
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  ),
  menu: I("M4 7h16M4 12h16M4 17h16"),
};

/** The signed-in frame: black sidebar with the lion and menu, a top bar with the user, and the page. */
export function AppShell(props: {
  children: ReactNode;
  user: { name: string; role: string };
  bcba: boolean;
  demo: boolean;
  logout: ReactNode;
}) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  const items: NavItem[] = [
    { href: "/", label: "Caseload", icon: ICONS.caseload },
    { href: "/clients", label: "Clients", icon: ICONS.clients },
    { href: "/payors", label: "Payor rules", icon: ICONS.payors },
    ...(props.bcba
      ? [
          { href: "/audit", label: "Audit log", icon: ICONS.audit },
          { href: "/settings", label: "Settings", icon: ICONS.settings },
        ]
      : []),
  ];
  const active = (href: string) =>
    href === "/" ? path === "/" : path.startsWith(href) || (href === "/clients" && path.startsWith("/plans"));
  const initials = props.user.name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <div className={`shell${open ? " menu-open" : ""}`}>
      <aside
        className="sidebar"
        aria-label="Main menu"
        onClick={(e) => e.target === e.currentTarget && setOpen(false)}
      >
        <Link href="/" className="brand">
          <Lion size={40} />
          {APP_NAME}
        </Link>
        <nav className="nav">
          {items.map((it) => (
            <Link key={it.href} href={it.href} className={active(it.href) ? "active" : undefined}>
              {it.icon}
              {it.label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-card">
          <strong>{props.demo ? "Demo site" : "Synthetic data only"}</strong>
          {props.demo
            ? "Fictional clients only. Never enter or upload real client information here."
            : "This build holds fictional clients only. Do not enter real client information."}
        </div>
      </aside>
      <div className="content">
        <div className="topbar">
          <button className="menu-toggle" aria-label="Open menu" onClick={() => setOpen(true)}>
            {ICONS.menu}
          </button>
          <div className="who">
            <span className="avatar" aria-hidden="true">
              {initials || "?"}
            </span>
            <span>
              <span className="name">{props.user.name}</span>
              <span className="role" style={{ display: "block" }}>
                {props.user.role}
              </span>
            </span>
          </div>
          <span className="spacer" />
          <span className="demo-pill">
            {props.demo ? "Demo: fictional data only" : "Synthetic data only"}
          </span>
          {props.logout}
        </div>
        <main>{props.children}</main>
      </div>
    </div>
  );
}
