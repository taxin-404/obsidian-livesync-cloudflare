/** Cloudflare's nearest supported Durable Object region for South Asia.
 *
 * A hint is only consulted when an object is first created: existing objects
 * keep their location, so this cannot move live data. It keeps a recreated
 * database (or a new database name) in Asia-Pacific instead of wherever the
 * first request happens to arrive. */
export const DO_LOCATION_HINT = 'apac' as const;
