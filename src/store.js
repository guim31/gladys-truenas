// -----------------------------------------------------------------------------
// Small persistence under /data (the only writable path of the container),
// one file, truenas-state.json: what the scene triggers compare with
// (src/watcher.js), so that a restart of the integration or of Gladys neither
// misses a transition nor announces an alert twice. Losing it is harmless:
// the first read after it only records the states, without scene events.
//
// Nothing secret is written here: the API key stays in the Gladys
// configuration. (Adapted from guim31/gladys-qnap.)
// -----------------------------------------------------------------------------

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'truenas-store' });

export const STATE_FILE = 'truenas-state.json';

export class Store {
  constructor(directory = process.env.TRUENAS_DATA_DIR || '/data') {
    this.directory = directory;
    this.path = join(directory, STATE_FILE);
    this.pending = null;
    this.writing = null;
    this.written = null;
    this.latest = null;
    this.failing = false;
  }

  /** The trigger tables, `{}` when there are none yet. */
  async load() {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      this.written = JSON.stringify(data);
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn(`Cannot read ${this.path}: ${err.message}`);
      }
      return {};
    }
  }

  // Writes are coalesced, skipped when nothing changed, and atomic (temporary
  // file + rename): a crash never leaves half a JSON file behind.
  save(data) {
    this.latest = JSON.stringify(data);
    if (!this.pending) {
      // Chained after the write in progress, if any: one writer at a time.
      this.pending = (this.writing ?? Promise.resolve()).then(async () => {
        const snapshot = this.latest;
        this.pending = null;
        if (snapshot === this.written) {
          return;
        }
        try {
          await mkdir(this.directory, { recursive: true });
          const temporary = `${this.path}.tmp`;
          await writeFile(temporary, snapshot);
          await rename(temporary, this.path);
          this.written = snapshot;
          if (this.failing) {
            this.failing = false;
            logger.info(`${this.path} written again`);
          }
        } catch (err) {
          // Tried again at every read until it works: one line, not one per read.
          (this.failing ? logger.debug : logger.warn)(`Cannot write ${this.path}: ${err.message}`);
          this.failing = true;
        }
      });
      this.writing = this.pending;
    }
    return this.pending;
  }

  /** Resolves once every write requested so far is on disk. */
  flush() {
    return this.writing ?? Promise.resolve();
  }
}
