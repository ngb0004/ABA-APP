import type { Metadata } from "next";
import { LoginForm } from "@/components/login-form";
import { isDemo } from "@/lib/demo";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return <LoginForm demo={isDemo()} />;
}
