/**
 * Host half of the `dsh-balance` plugin.
 *
 * One job: serve the sidebar chip's data on `GET /dsh-balance/usage` — the live
 * DeepSeek API balance plus the peak/off-peak tariff flag. The route is answered
 * from loopback only: the chip is read-only and carries no secret, but it does
 * report account data, so it stays on the local machine even when the webserver
 * is bound to all interfaces.
 *
 * The report is cached for a minute, which is also the chip's poll interval, so
 * a page open all day does not hammer the balance endpoint.
 */
import { collectReport, jsonHandler } from './balance.js';

export const name = 'dsh-balance';

/** The webserver must exist before the route is registered. */
export const inject = ['webServer'];

const ROUTE_PATH = '/dsh-balance';
const DEFAULT_CACHE_SECONDS = 60;

/** True for requests that came from this machine only. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Register the usage route.
 * @param ctx - host plugin context.
 * @param config - optional `{ cacheSeconds }` from the plugin row.
 */
export function apply(ctx, config = {}) {
  const seconds = Number(config.cacheSeconds) > 0 ? Number(config.cacheSeconds) : DEFAULT_CACHE_SECONDS;
  const cacheMs = seconds * 1000;

  let cached = null;
  let cachedAt = 0;

  const handler = async (req, res) => {
    if (!isLoopback(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('dsh-balance: the usage route answers loopback requests only');
      return;
    }
    const now = Date.now();
    // `?refresh=1` is the chip's click: it bypasses the cache so the amount
    // visibly moves instead of replaying the previous read.
    const refresh = (req.url ?? '').includes('refresh=1');
    if (refresh || cached === null || now - cachedAt > cacheMs) {
      try {
        cached = await collectReport();
      } catch (error) {
        cached = { error: error instanceof Error ? error.message : String(error) };
      }
      cachedAt = now;
    }
    jsonHandler(cached)(req, res);
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PATH, handler }),
    'dsh-balance: usage route',
  );
}
