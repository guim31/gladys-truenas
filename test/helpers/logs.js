// -----------------------------------------------------------------------------
// Captures every line the loggers write (console.log and console.error, where
// the SDK logger writes) at a given level.
// -----------------------------------------------------------------------------

/**
 * Runs `fn` with every log line captured.
 * @param {() => Promise<void>} fn
 * @param {string} [level] LOG_LEVEL during the capture
 * @returns {Promise<string[]>} the lines
 */
export async function captureLogs(fn, level = 'debug') {
  const lines = [];
  const original = { log: console.log, error: console.error, level: process.env.LOG_LEVEL };
  process.env.LOG_LEVEL = level;
  console.log = (...args) => lines.push(args.map(String).join(' '));
  console.error = (...args) => lines.push(args.map((a) => a?.stack ?? String(a)).join(' '));
  try {
    await fn();
  } finally {
    console.log = original.log;
    console.error = original.error;
    process.env.LOG_LEVEL = original.level;
  }
  return lines;
}
