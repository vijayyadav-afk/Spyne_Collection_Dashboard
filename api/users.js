// Owner-only list of everyone who has signed in: open /api/users while signed in as the owner.
import { cookieEmail, readUsers } from './_sess.js';
export const config = { runtime: 'edge' };
const OWNER = 'vijay.yadav@spyne.ai';
function json(status, obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' },
  });
}
export default async function handler(request) {
  const e = await cookieEmail(request);
  if (!e) return json(401, { error: 'unauthorized' });
  if (e.toLowerCase() !== OWNER) return json(403, { error: 'owner_only' });
  const users = await readUsers();
  if (!users) return json(501, { error: 'storage_not_configured' });
  return json(200, { count: users.length, users });
}
