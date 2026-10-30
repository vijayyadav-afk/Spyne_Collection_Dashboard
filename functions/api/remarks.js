// Cloudflare Pages Functions adapter: runs the shared handler in api/remarks.js unchanged.
import handler from '../../api/remarks.js';
export const onRequest = (ctx) => handler(ctx.request, ctx);
