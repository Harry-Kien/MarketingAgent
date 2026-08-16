/**
 * Late-review MINOR (a): `events[]` was unbounded. The reviewer sent 4000
 * events in a 690 KB body -- comfortably inside MAX_WEBHOOK_BODY_BYTES, so
 * the size cap never fired -- and the route held ONE database transaction
 * open for 24.3 seconds while it processed them one at a time. A single
 * request that can pin a connection for half a minute is a denial of service
 * against every other tenant sharing the pool, and the body cap cannot close
 * it: bytes are the wrong unit, because the expensive resource is round
 * trips, not memory.
 *
 * Meta batches at most a handful of changes per delivery; 100 is generous
 * headroom over anything real while capping the worst case at a few hundred
 * statements. A batch over the cap is refused with 400 BEFORE a pool
 * connection is checked out, so the rejection costs nothing.
 */
export const MAX_EVENTS_PER_DELIVERY = 100;
