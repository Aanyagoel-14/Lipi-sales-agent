import { noContent, route } from "@/server/lib/http";
import { destroySession } from "@/server/lib/session";

export const POST = route(async () => {
  await destroySession();
  return noContent();
});
