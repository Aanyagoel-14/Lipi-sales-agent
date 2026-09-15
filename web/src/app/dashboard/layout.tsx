import Link from "next/link";
import { redirect } from "next/navigation";
import { DashNav } from "@/components/dash/nav";
import { LipiMark } from "@/components/site/icons";
import { SignOut } from "@/components/dash/sign-out";
import { getSession } from "@/lib/session";
import { getWorkspace } from "@/lib/train";

export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const { user, workspaces } = await getSession();
  if (!user) redirect("/login");
  if (!workspaces.length || !workspaces.some((w) => w.onboardedAt)) redirect("/onboarding");

  const workspace = await getWorkspace();
  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-line bg-surface py-4 lg:flex">
        <Link href="/" className="mb-6 flex min-h-9 items-center gap-2 px-6 font-medium tracking-tight">
          <LipiMark />
          <span className="text-[0.9375rem]">Lipi AI</span>
        </Link>
        <DashNav />
        <div className="mt-auto space-y-4">
          <div className="px-6">
            <p className="text-[0.6875rem] text-ink-subtle">Workspace</p>
            <p className="text-[0.8125rem]">{workspace?.name ?? "Not set up yet"}</p>
          </div>
          <SignOut email={user.email} />
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-line bg-ground/85 px-6 backdrop-blur-xl lg:gap-4 lg:px-8">
          <Link href="/" className="flex shrink-0 items-center gap-2 font-medium lg:hidden">
            <LipiMark />
          </Link>
          <p className="min-w-0 truncate text-[0.8125rem] text-ink-subtle">
            {workspace
              ? `Live data for ${workspace.name}.`
              : "No workspace yet. Run onboarding to create one."}
          </p>
          {workspace ? (
            /* Shortens rather than duplicating itself for screen readers: a
               bare "0" beside a dot means nothing to anyone. */
            <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-[0.75rem] text-ink-muted">
              <span className="size-1.5 rounded-full bg-teal-mark" aria-hidden />
              {workspace._count.connections} channel{workspace._count.connections === 1 ? "" : "s"}
              <span className="hidden sm:inline">connected</span>
            </span>
          ) : null}
        </header>

        {/* Navigation belongs next to the content, not below it. */}
        <div className="sticky top-14 z-30 lg:hidden">
          <DashNav variant="bar" />
        </div>

        <main className="px-6 py-8 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
