// Cloudflare Pages Functions adapter: runs the shared handler in api/users.js unchanged.
import handler from '../../api/users.js';
export const onRequest = (ctx) => handler(ctx.request, ctx);
