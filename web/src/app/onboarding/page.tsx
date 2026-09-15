import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { LipiMark } from "@/components/site/icons";
import { Wizard } from "./wizard";

export const metadata = { title: "Set up your workspace · Lipi AI" };

export default async function OnboardingPage() {
  const { user, workspaces } = await getSession();
  if (!user) redirect("/login");
  // Only a *finished* workspace skips the wizard; an abandoned one resumes.
  const existing = workspaces.find((w) => w.onboardedAt) ?? null;
  if (existing) redirect("/dashboard");

  const inProgress = workspaces[0] ?? null;

  return (
    <>
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center px-6">
          <Link href="/" className="flex min-h-11 items-center gap-2 font-medium tracking-tight">
            <LipiMark />
            <span className="text-[0.9375rem]">Lipi AI</span>
          </Link>
        </div>
      </header>
      <main className="flex-1">
        <Wizard resuming={Boolean(inProgress)} />
      </main>
    </>
  );
}
