import { receive } from "@/server/channels/inbound";
import { specFor, type Json } from "@/server/channels/registry";
import { secretsMatch } from "@/server/lib/crypto";
import { prisma } from "@/server/lib/prisma";

/**
 * One route per Telegram connection.
 *
 * Telegram allows a bot exactly one webhook URL and sends no identifier in
 * the body that would say which bot an update belongs to, so the connection
 * is named by the URL and proved by the header: `setWebhook` was given a
 * secret generated for this connection alone, and Telegram echoes it on
 * every delivery. The connection id in the path is not a credential — it is
 * the address — which is why a wrong header is a 401 whatever the path says.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const status = (code: number) => new Response(null, { status: code });

type Params = { params: Promise<{ connectionId: string }> };

export async function POST(req: Request, ctx: Params) {
  const { connectionId } = await ctx.params;

  const connection = await prisma.channelConnection.findUnique({ where: { id: connectionId } });
  if (!connection || connection.channel !== "telegram") return status(404);

  // Null after a disconnect, and until `afterConnect` has registered the
  // webhook. Either way there is nothing to check a delivery against.
  const secret = connection.webhookSecret;
  const offered = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!secret || !secretsMatch(offered, secret)) return status(401);

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return status(400);
  }

  const spec = specFor("telegram")!;
  return receive(connection, spec.parse(payload, {
    id: connection.id,
    workspaceId: connection.workspaceId,
    channel: connection.channel,
    externalId: connection.externalId,
    config: (connection.config ?? {}) as Json,
  }));
}
