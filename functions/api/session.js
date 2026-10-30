// Cloudflare Pages Functions adapter: runs the shared handler in api/session.js unchanged.
import handler from '../../api/session.js';
export const onRequest = (ctx) => handler(ctx.request, ctx);
