// -----------------------------------------------------------------------------
// Registers every SDK handler on a GladysIntegration (or the SDK's fake Gladys)
// and returns the hub, so index.js stays a few lines and the tests drive the
// very same wiring. (Adapted from guim31/gladys-qnap.)
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { NasHub } from './hub.js';
import { Store } from './store.js';
import { POWER_ACTIONS } from './truenas/client.js';
import { INIT_FAILED } from './texts.js';
import { WIDGETS } from './widgets.js';

const logger = createLogger({ name: 'truenas-app' });

// Scene action keys (manifest `scene_actions`): permanent once published.
export const SCENE_ACTIONS = Object.freeze({
  RESTART: 'restart_nas',
  SHUTDOWN: 'shutdown_nas',
});

/**
 * @param {object} gladys GladysIntegration instance
 * @param {object} [options] test seams: store, open, timers, timings, now, client
 */
export function registerHandlers(gladys, options = {}) {
  const hub = new NasHub({
    gladys,
    store: options.store ?? new Store(),
    open: options.open,
    timers: options.timers ?? true,
    timings: options.timings,
    now: options.now,
    client: options.client,
  });

  // Resolved once the hub has started; every handler waits for it, so a
  // request arriving during the first read is not lost.
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  let startup = null;
  const whenReady =
    (fn) =>
    async (...args) => {
      await ready;
      return fn(...args);
    };

  gladys.on('connected', async () => {
    try {
      const config = normalizeConfig(await gladys.getConfig());
      if (startup) {
        // A reconnection (Gladys restarted): send again what Gladys may have
        // lost, once the first start is over.
        await startup.catch(() => {});
        await hub.resync(config);
        return;
      }
      // Set before any await: two quick connections start the hub once.
      startup = hub.start(config);
      await startup;
    } catch (err) {
      logger.error('Initialization failed', err);
      await gladys.setConnectionStatus(false, INIT_FAILED).catch(() => {});
    } finally {
      resolveReady();
    }
  });

  // One info line per action of the user; the reads themselves stay at debug.
  gladys.onScanRequest(
    whenReady(() => {
      logger.info('Search requested');
      return hub.rediscover();
    }),
  );

  // The devices are published with should_poll: false (the hub reads the NAS
  // on its own timer); this only serves a Gladys that would poll anyway.
  gladys.onPoll(
    whenReady(async () => {
      await hub.afterChanges(await hub.pollIfStale());
    }),
  );

  // The Start / stop switch of the apps and VMs (refused unless allowed).
  gladys.onSetValue(whenReady((device, feature, value) => hub.setValue(device, feature, value)));

  gladys.onDeviceCreated(whenReady((device) => hub.onDeviceCreated(device)));
  // "Update" in the Discover tab may add features (the Start / stop switch):
  // their values were dropped by Gladys until then.
  gladys.onDeviceUpdated(whenReady((device) => hub.onDeviceCreated(device)));
  gladys.onDeviceDeleted(whenReady(async (device) => hub.onDeviceDeleted(device)));

  gladys.onConfigUpdated(
    whenReady(async (newConfig) => {
      logger.info('Configuration saved');
      await hub.reconfigure(normalizeConfig(newConfig));
    }),
  );

  gladys.onAction(
    'test_connection',
    whenReady(() => {
      logger.info('Connection test requested');
      return hub.testConnection();
    }),
  );

  // Restart and shut down: refused unless the user ticked the option (the
  // hub checks it at every call, the configuration may change).
  gladys.onSceneAction(
    SCENE_ACTIONS.RESTART,
    whenReady(() => hub.power(POWER_ACTIONS.RESTART)),
  );
  gladys.onSceneAction(
    SCENE_ACTIONS.SHUTDOWN,
    whenReady(() => hub.power(POWER_ACTIONS.SHUTDOWN)),
  );

  for (const [key, widget] of Object.entries(WIDGETS)) {
    gladys.onWidgetGet(
      key,
      whenReady((request) => widget.get(hub, request)),
    );
    gladys.onWidgetAction(
      key,
      whenReady((actionKey, params, context = {}) => {
        logger.info(`Widget action ${actionKey}`);
        return widget.action(hub, { actionKey, params, ...context });
      }),
    );
  }

  return {
    hub,
    ready,
    stop: () => hub.stop(),
  };
}
