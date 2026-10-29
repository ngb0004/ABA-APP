import { LoginForm } from "@/components/login-form";
import { isDemo } from "@/lib/demo";

export default function LoginPage() {
  return <LoginForm demo={isDemo()} />;
}
