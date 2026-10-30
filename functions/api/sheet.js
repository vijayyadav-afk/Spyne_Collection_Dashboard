// Cloudflare Pages Functions adapter: runs the shared handler in api/sheet.js unchanged.
import handler from '../../api/sheet.js';
export const onRequest = (ctx) => handler(ctx.request, ctx);
