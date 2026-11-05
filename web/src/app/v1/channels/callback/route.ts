import { finishConnection } from "@/server/channels/connect";
import { HttpError, route, searchParams } from "@/server/lib/http";
import { prisma } from "@/server/lib/prisma";
import { resolveWorkspaceId } from "@/server/lib/workspace";

/**
 * Where Composio's hosted consent page sends the browser back to.
 *
 * It arrives with `?status=success|failed&connected_account_id=ca_…`. The
 * status is ignored as evidence: it is a query parameter on a URL the operator
 * could edit, and it says what the page believed at redirect time rather than
 * what the account is. `finishConnection` re-reads the account from Composio
 * and proves it with a real tool call instead.
 *
 * The account id is trusted only as far as "which of this workspace's rows is
 * this about" — the row is looked up inside the workspace, and the account's
 * own `user_id` is checked against it again before anything is written.
 *
 * It is a browser navigation, so every outcome is a redirect to a page that
 * can say what happened: the wizard when setup is still in progress (the
 * dashboard would only bounce them back to it, at the wrong step), the
 * channels page otherwise, and sign-in when the session is gone. A raw JSON
 * error here was a dead end with no way back.
 */
export const GET = route(async (req) => {
  let destination = "/dashboard/channels";
  let channel: string | null = null;

  try {
    const workspaceId = await resolveWorkspaceId();
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { onboardedAt: true } });
    if (!workspace?.onboardedAt) destination = "/onboarding";

    const accountId = searchParams(req).get("connected_account_id");
    if (!accountId) throw new HttpError(400, "That callback did not name a connection");

    const row = await prisma.channelConnection.findFirst({
      where: { workspaceId, composioAccountId: accountId },
    });
    if (!row) throw new HttpError(404, "No connection in progress for that account. Start it again from here.");
    channel = row.channel;

    const finished = await finishConnection(row);
    return back(destination, { channel: finished.channel });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    if (error.status === 401) return back("/login", {});
    return back(destination, { ...(channel ? { channel } : {}), error: error.message });
  }
});

/** 303 so the browser follows with GET, to a card that now shows the truth. */
const back = (path: string, query: Record<string, string>) =>
  new Response(null, {
    status: 303,
    headers: { location: Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path },
  });
