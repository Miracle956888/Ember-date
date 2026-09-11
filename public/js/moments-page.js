/**
 * moments-page.js — entry point for /moments.
 *
 * One social surface: the 24-hour Moments tray on top, the 24-hour post feed
 * beneath it. Keeping them on a single page avoids a seventh bottom-nav tab
 * and matches how people actually consume both — a glance at the rail, then a
 * scroll through the feed.
 */
import { bootPage } from './app-shell.js';
import { initMoments } from './moments.js';
import { initPosts } from './posts.js';

await bootPage({ socket: true, badges: true });

// Both surfaces are independent; load them in parallel so neither blocks.
await Promise.all([initMoments(), initPosts()]);
