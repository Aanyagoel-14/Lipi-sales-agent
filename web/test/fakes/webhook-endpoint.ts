import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookPost, WebhookPoster, WebhookPostResult } from "@/server/lib/webhook-endpoint";

/**
 * A customer's server that exists only in memory.
 *
 * It records every delivery it is offered and answers whatever the test told
 * it to answer, so a 500 is a scripted fact rather than a real endpoint having
 * a bad day. Nothing here reaches the network, and a poster that can only be
 * reached through `setWebhookPoster` is how that stays true — a delivery test
 * that could POST would be posting a signed body at whatever URL a fixture
 * happened to name.
 *
 *   fake.answer = 500                   what the next attempts answer
 *   fake.answerWith = [500, 500, 200]   a scripted sequence, then `answer`
 *   fake.fail = "ECONNREFUSED"          no answer at all, the way a timeout is
 *   fake.posts                          what arrived, in order
 *   fake.verify(post, secret)           the check a real subscriber writes
 */
export class FakeEndpoint {
  posts: WebhookPost[] = [];
  answer = 200;
  answerWith: number[] = [];
  fail: string | null = null;

  reset() {
    this.posts = [];
    this.answer = 200;
    this.answerWith = [];
    this.fail = null;
  }

  readonly poster: WebhookPoster = async (post): Promise<WebhookPostResult> => {
    this.posts.push(post);
    if (this.fail) return { status: null, error: this.fail };
    const next = this.answerWith.shift() ?? this.answer;
    return { status: next, error: null };
  };

  /** The most recent delivery's parsed body, for a test that wants to read it. */
  get last() {
    const post = this.posts[this.posts.length - 1];
    return post ? { ...post, json: JSON.parse(post.body) as Record<string, unknown> } : null;
  }

  /** Every delivery's event id, in the order the endpoint saw them. */
  get eventIds(): string[] {
    return this.posts.map((p) => p.headers["X-Lipi-Event-Id"]!);
  }

  /**
   * Exactly what a subscriber does: recompute the digest over
   * `<timestamp>.<body>` with the shared secret and compare it constant-time.
   * If this passes for a body the fake did not receive, the signature is not
   * doing its job.
   */
  verify(post: WebhookPost, secret: string): boolean {
    const given = post.headers["X-Lipi-Signature"] ?? "";
    const timestamp = post.headers["X-Lipi-Timestamp"] ?? "";
    const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${post.body}`).digest("hex")}`;
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(given, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

export const fakeEndpoint = new FakeEndpoint();
