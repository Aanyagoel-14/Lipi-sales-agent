import { json } from "@/server/lib/http";

/** No `bootedAt`: serverless has no single process whose uptime means anything. */
export async function GET() {
  return json({ status: "ok", service: "lipi-api" });
}
