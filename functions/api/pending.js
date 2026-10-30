// Cloudflare Pages Functions adapter: runs the shared handler in api/pending.js unchanged.
import handler from '../../api/pending.js';
export const onRequest = (ctx) => handler(ctx.request, ctx);
