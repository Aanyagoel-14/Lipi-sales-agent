import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { getSession } from "@/lib/session";

export const metadata = { title: "Create an account · Lipi AI" };

export default async function SignupPage() {
  const { user, workspaces } = await getSession();
  if (user) redirect(workspaces.some((w) => w.onboardedAt) ? "/dashboard" : "/onboarding");

  return (
    <AuthShell>
      <AuthForm mode="signup" />
    </AuthShell>
  );
}
