// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// One NAS per installation: its address (always reached over HTTPS: TrueNAS
// revokes an API key sent over plain HTTP), an API key, whether its
// self-signed certificate is accepted, the refresh interval, whether apps and
// virtual machines may be started and stopped from Gladys, whether scenes may
// restart or shut the NAS down, and the language of the texts sent to Gladys.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// The versioned JSON-RPC 2.0 API of TrueNAS 25.04 and later.
export const API_PATH = '/api/current';

// Refresh intervals offered in the configuration, in seconds: one minute at
// most often, the cadence of the Home Assistant integration.
export const POLL_INTERVALS = ['60', '120', '300'];

export const DEFAULT_CONFIG = {
  address: '',
  api_key: '',
  accept_self_signed: false,
  poll_interval: '60',
  allow_app_control: false,
  allow_power_actions: false,
  language: 'fr',
};

/**
 * Parse the address typed by the user into the URL of the API: a bare host
 * or IP (`192.0.2.20`), `host:port`, or a URL copied from the browser
 * (`https://192.0.2.20/ui/dashboard`). The path is dropped: the API always
 * lives at /api/current.
 * @param {unknown} raw
 * @returns {{ url: string|null, insecure: boolean }} `insecure` when the address asks for plain
 *   HTTP (refused: the NAS would revoke the key)
 */
export function parseAddress(raw) {
  const none = { url: null, insecure: false };
  if (typeof raw !== 'string') {
    return none;
  }
  const value = raw.trim();
  if (!value) {
    return none;
  }
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
  let url;
  try {
    url = new URL(scheme ? value : `https://${value}`);
  } catch {
    return none;
  }
  if (!url.hostname || url.username || url.password) {
    // Credentials in the address would end up in the logs and the messages.
    return none;
  }
  if (scheme === 'http' || scheme === 'ws') {
    return { url: null, insecure: true };
  }
  if (scheme && scheme !== 'https' && scheme !== 'wss') {
    return none;
  }
  const port = url.port && url.port !== '443' ? `:${url.port}` : '';
  return { url: `wss://${url.hostname}${port}${API_PATH}`, insecure: false };
}

/** Host part shown to the user (no scheme, no path, no default port). */
export const hostOf = (url) => new URL(url).host;

const bool = (value, fallback) => {
  if (value === true || value === 'true' || value === 1 || value === '1') {
    return true;
  }
  if (value === false || value === 'false' || value === 0 || value === '0') {
    return false;
  }
  return fallback;
};

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 * @returns {{ url: string|null, addressInvalid: boolean, addressInsecure: boolean, apiKey: string,
 *   insecure: boolean, pollIntervalMs: number, appControl: boolean, powerActions: boolean,
 *   language: string }}
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const pick = (key, choices) => {
    const value = source[key] === undefined || source[key] === null ? '' : String(source[key]);
    return choices.includes(value) ? value : DEFAULT_CONFIG[key];
  };
  const typed = typeof source.address === 'string' ? source.address.trim() : '';
  const { url, insecure } = parseAddress(typed);
  return {
    url,
    addressInvalid: Boolean(typed) && url === null && !insecure,
    addressInsecure: insecure,
    // An API key has no spaces: a pasted one often carries a new line.
    apiKey: typeof source.api_key === 'string' ? source.api_key.trim() : '',
    insecure: bool(source.accept_self_signed, DEFAULT_CONFIG.accept_self_signed),
    pollIntervalMs: Number(pick('poll_interval', POLL_INTERVALS)) * 1000,
    appControl: bool(source.allow_app_control, DEFAULT_CONFIG.allow_app_control),
    powerActions: bool(source.allow_power_actions, DEFAULT_CONFIG.allow_power_actions),
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}

/** Whether the configuration has everything needed to log in. */
export const isComplete = (config) => Boolean(config.url && config.apiKey);
