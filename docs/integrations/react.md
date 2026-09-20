# React, Next.js and Lovable

The whole integration is two calls: deliver the visitor's message, render the reply. Everything
else — the customer twin, the lead score, the attribution, the order — happens on Lipi's side
off the back of that one message.

Read [`../api.md`](../api.md) first for authentication, pagination and the error envelope.

## The shape that works

**Keep the key on your server.** A `lipi_sk_…` in a React bundle is a published secret: anyone
who opens devtools has full read and write access to your workspace. So the browser talks to
your own route, and your route talks to Lipi.

```
browser ──fetch('/api/chat')──▶ your server ──Bearer lipi_sk_…──▶ Lipi /v1/conversations
```

### Next.js App Router

```ts
// app/api/chat/route.ts
export async function POST(req: Request) {
  const { visitorId, text } = await req.json();

  const res = await fetch(`${process.env.LIPI_URL}/v1/conversations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LIPI_KEY}`,   // server-only env var
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: "webchat", handle: visitorId, text }),
  });

  if (!res.ok) {
    const { error } = await res.json();
    return Response.json({ error }, { status: res.status });
  }

  const { reply } = await res.json();
  return Response.json({ reply });
}
```

### The component

```tsx
"use client";
import { useState } from "react";

// One stable id per visitor, kept for as long as you can keep it. It is the
// handle Lipi resolves to a customer twin, so a returning visitor with the
// same id continues the same relationship.
const visitorId = localStorage.getItem("visitor") ?? crypto.randomUUID();
localStorage.setItem("visitor", visitorId);

export function Chat() {
  const [log, setLog] = useState<{ from: string; text: string }[]>([]);

  async function send(text: string) {
    setLog((l) => [...l, { from: "you", text }]);
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorId, text }),
    });
    const { reply, error } = await res.json();
    setLog((l) => [...l, { from: "lipi", text: reply ?? error }]);
  }

  // … render `log`, call `send` on submit
}
```

## Lovable

Lovable apps are client-side, so the same rule applies with more force: do not paste a
`lipi_sk_…` into a Lovable project. Two ways through:

1. **Use the widget.** `/v1/webchat/{workspaceId}/session` and `/message` need no key and are
   built to be called from any origin. The workspace id is public, like a Stripe publishable
   key. This is the right answer for an anonymous visitor on a marketing page.
2. **Put the key in a Lovable backend function** (or any small serverless function you control)
   and call that from the app, exactly as the Next.js route above does.

If you are building an internal tool — behind your own login, key injected per session rather
than baked into the bundle — you can call `/v1` directly once you have allow-listed the origin:

```bash
curl -X PATCH $LIPI_URL/v1/workspaces/current \
  -H "Authorization: Bearer $LIPI_KEY" -H "Content-Type: application/json" \
  -d '{"allowedOrigins":["https://your-app.lovable.app","http://localhost:5173"]}'
```

## Reading the rest

Server-side, with the same key:

```ts
const headers = { Authorization: `Bearer ${process.env.LIPI_KEY}` };

// Every customer, page by page. `nextCursor` is null on the last one.
let cursor: string | null = null;
const customers = [];
do {
  const url = `${process.env.LIPI_URL}/v1/customers?limit=200${cursor ? `&cursor=${cursor}` : ""}`;
  const page = await fetch(url, { headers }).then((r) => r.json());
  customers.push(...page.customers);
  cursor = page.nextCursor;
} while (cursor);
```

## Attribution

Capture the visitor's UTM parameters on **their first page load**, not when they open the chat —
first touch is never overwritten, so a late capture attributes the customer to the wrong ad
forever. `GET /v1/conversions` hands the captured attribution back alongside each order's exact
paise, which is what closes the loop from ad spend to revenue.

## Types

`openapi.json` is a valid OpenAPI 3.1 document; generate a typed client from it rather than
hand-writing interfaces:

```bash
npx openapi-typescript https://your-lipi-host/v1/openapi.json -o src/lipi.d.ts
```
