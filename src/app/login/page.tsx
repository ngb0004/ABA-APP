import type { Metadata } from "next";
import { LoginForm } from "@/components/login-form";
import { idleMessage } from "@/lib/auth/session";
import { isDemo } from "@/lib/demo";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams;
  return <LoginForm demo={isDemo()} notice={reason === "idle" ? idleMessage() : null} />;
}
