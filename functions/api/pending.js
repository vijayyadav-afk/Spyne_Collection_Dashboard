// Cloudflare Pages Functions adapter: runs the shared handler in api/pending.js unchanged.
// Cloudflare hands settings over as ctx.env; the shared code reads process.env, so expose them there.
import handler from '../../api/pending.js';
export const onRequest = (ctx) => {
  globalThis.process = { env: Object.assign({}, globalThis.process && globalThis.process.env, ctx.env) };
  return handler(ctx.request, ctx);
};
