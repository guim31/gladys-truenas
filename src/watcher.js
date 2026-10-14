// -----------------------------------------------------------------------------
// What the scene triggers compare with, read after read: the state of every
// pool and the alerts already seen. Pure bookkeeping, no I/O: the hub
// (src/hub.js) feeds it every read and fires the events it returns. The
// tables live in /data (src/store.js) so a restart neither repeats an
// announcement nor misses one.
//
//   - a pool is announced when its state needs attention and is worse than
//     the one recorded: ONLINE -> DEGRADED fires, DEGRADED -> FAULTED fires
//     again, FAULTED -> DEGRADED does not (it is getting better). Back to
//     ONLINE re-arms it;
//   - an alert is announced once, the first time its id is seen active (not
//     dismissed). An alert that clears and comes back gets a new id from
//     TrueNAS, and is announced again.
//
// The first time the NAS is read, everything is recorded without any event:
// nothing has changed, and no scene could exist yet. The tables are those of
// one NAS: another host id starts them afresh. (Adapted from
// guim31/gladys-qnap.)
// -----------------------------------------------------------------------------

import { POOL_STATES, poolState } from './truenas/model.js';

const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

// A NAS with hundreds of active alerts is broken anyway: the table stays bounded.
export const MAX_REMEMBERED_ALERTS = 500;

export class Watcher {
  constructor(saved = {}) {
    const tables = object(saved);
    this.saved = {
      nas: typeof tables.nas === 'string' ? tables.nas : null,
      pools: object(tables.pools),
      // null: never read (the first read records without announcing).
      alerts: Array.isArray(tables.alerts)
        ? tables.alerts.filter((id) => typeof id === 'string')
        : null,
    };
  }

  /** Bind the tables to a NAS; returns whether they were reset. */
  bind(nasId) {
    if (this.saved.nas === nasId) {
      return false;
    }
    this.saved = { nas: nasId, pools: {}, alerts: null };
    return true;
  }

  /** @returns {Array<object>} the pools whose state just got worse */
  pools(pools) {
    const events = [];
    for (const pool of pools ?? []) {
      const state = poolState(pool.status);
      const previous = this.saved.pools[pool.key];
      this.saved.pools[pool.key] = state;
      if (previous === undefined || !POOL_STATES[previous]) {
        continue;
      }
      const now = POOL_STATES[state];
      if (now.alert && now.severity > POOL_STATES[previous].severity) {
        events.push(pool);
      }
    }
    return events;
  }

  /**
   * @param {Array<{ id: string, dismissed: boolean }>|null} alerts the active alerts, null when
   *   they could not be read (the table is kept as it is)
   * @returns {Array<object>} the alerts seen for the first time
   */
  alerts(alerts) {
    if (!alerts) {
      return [];
    }
    const active = alerts.filter((alert) => !alert.dismissed);
    const previous = this.saved.alerts;
    this.saved.alerts = active.map((alert) => alert.id).slice(0, MAX_REMEMBERED_ALERTS);
    if (previous === null) {
      return [];
    }
    const known = new Set(previous);
    return active.filter((alert) => !known.has(alert.id));
  }
}
