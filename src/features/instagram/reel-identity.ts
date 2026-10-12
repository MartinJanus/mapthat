import { createHash } from "node:crypto";

export type ReelCaption = {
  readonly title: string;
  readonly reel_video_id?: string;
  readonly url?: string;
};

export function reelExtractionKey(reel: ReelCaption, version: string): string | undefined {
  let identity: string | undefined;
  if (reel.reel_video_id) identity = `video:${reel.reel_video_id}`;
  else if (reel.url) {
    let url: URL;
    try { url = new URL(reel.url); }
    catch (error) { if (error instanceof TypeError) return undefined; throw error; }
    if (url.protocol !== "https:" || url.username || url.password || !["instagram.com", "www.instagram.com", "m.instagram.com"].includes(url.hostname)) return undefined;
    const shortcode = /^\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)?.[1];
    if (shortcode) identity = `shortcode:${shortcode}`;
  }
  return identity ? createHash("sha256").update(JSON.stringify([version, identity, reel.title.trim()])).digest("hex") : undefined;
}
