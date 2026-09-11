/** call-page.js — page script for call.html (external so the strict CSP allows it). */
import { bootPage } from '/js/app-shell.js';
import { initCall } from '/js/call.js';

await bootPage({ socket: true, badges: false });
await initCall();
