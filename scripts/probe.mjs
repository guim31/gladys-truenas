#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Probes a real TrueNAS with the client of the integration, READ ONLY, and
// prints what the tests cannot know: which methods this version has, the
// shape of their answers (field names, enum values, graph legends), and what
// the integration makes of them. Never the API key, an address, a host name,
// a serial number or the name of a pool, disk, app or VM: only counts, codes,
// field names and states.
//
//   TRUENAS_URL=192.0.2.20 TRUENAS_API_KEY=… [TRUENAS_INSECURE=1] node scripts/probe.mjs
//
// It never starts, stops, restarts nor shuts down anything: only the methods
// of a read (and update.status / update.check_available, which make the NAS
// ask the TrueNAS update server once) are called. One login, one connection.
// -----------------------------------------------------------------------------

import { normalizeConfig } from '../src/config.js';
import { TruenasClient } from '../src/truenas/client.js';
import { parseSnapshot } from '../src/truenas/model.js';
import { RpcError } from '../src/truenas/rpc.js';

const config = normalizeConfig({
  address: process.env.TRUENAS_URL ?? '',
  api_key: process.env.TRUENAS_API_KEY ?? '',
  accept_self_signed: process.env.TRUENAS_INSECURE === '1',
});
if (!config.url || !config.apiKey) {
  console.error(
    config.addressInsecure
      ? 'HTTPS only: TrueNAS revokes an API key sent over HTTP.'
      : 'Set TRUENAS_URL and TRUENAS_API_KEY (TRUENAS_INSECURE=1 for a self-signed certificate).',
  );
  process.exit(2);
}

/** Prints a line, refusing any that carries the key (belt and braces). */
function say(...parts) {
  const line = parts
    .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
    .join(' ');
  if (line.includes(config.apiKey) || line.includes(config.apiKey.split('-').slice(1).join('-'))) {
    console.log('(line withheld: it carried the key)');
    return;
  }
  console.log(line);
}

const keysOf = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
const count = (values) => {
  const counts = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
};

const client = new TruenasClient({
  url: config.url,
  apiKey: config.apiKey,
  insecure: config.insecure,
});

// 1. Login and the raw answers, method by method.
async function probe(method, params = []) {
  try {
    const result = await client.call(method, params);
    return { ok: true, result };
  } catch (err) {
    if (err instanceof RpcError) {
      say(`${method}: error ${err.code} ${err.errname ?? ''}`.trim());
      return { ok: false };
    }
    throw err;
  }
}

try {
  const info = await probe('system.info');
  if (!info.ok) {
    process.exit(1);
  }
  say('login: ok');
  say('system.info fields:', keysOf(info.result).join(', '));
  say('version:', info.result.version, '| uptime_seconds:', typeof info.result.uptime_seconds);
  say('system.host_id: length', String((await probe('system.host_id')).result ?? '').length);

  const now = Math.floor(Date.now() / 1000);
  for (const graph of ['cpu', 'memory', 'cputemp']) {
    const answer = await probe('reporting.netdata_get_data', [
      [{ name: graph }],
      { start: now - 180, end: now, aggregate: false },
    ]);
    const [first] = answer.result ?? [];
    if (first) {
      say(
        `graph ${graph}: legend`,
        first.legend,
        '| rows',
        first.data?.length ?? 0,
        '| last',
        first.data?.at(-1)?.map((v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)),
      );
    }
  }

  const alerts = await probe('alert.list');
  if (alerts.ok) {
    say('alert.list: fields', keysOf(alerts.result[0]).join(', ') || '(no alert)');
    say('alert levels:', count(alerts.result.map((a) => a.level)));
    say('alert classes:', count(alerts.result.map((a) => a.klass)));
    say('alert dismissed:', count(alerts.result.map((a) => String(a.dismissed))));
  }

  const pools = await probe('pool.query');
  if (pools.ok) {
    say('pool.query: count', pools.result.length, '| fields', keysOf(pools.result[0]).join(', '));
    say(
      'pool status/healthy:',
      pools.result.map((p) => `${p.status}/${p.healthy}`),
    );
    say(
      'pool scan:',
      pools.result.map((p) =>
        p.scan
          ? `${p.scan.function}/${p.scan.state}/errors ${p.scan.errors}/end ${keysOf(p.scan.end_time)}`
          : null,
      ),
    );
    const datasets = await probe('pool.dataset.query', [
      [['id', 'in', pools.result.map((p) => p.name)]],
      { extra: { retrieve_children: false, properties: ['used', 'available'] } },
    ]);
    if (datasets.ok) {
      say(
        'root datasets: count',
        datasets.result.length,
        '| used fields',
        keysOf(datasets.result[0]?.used).join(', '),
      );
    }
  }

  const disks = await probe('disk.query', [[], { extra: { pools: true } }]);
  if (disks.ok) {
    say('disk.query: count', disks.result.length, '| fields', keysOf(disks.result[0]).join(', '));
    say(
      'disk types:',
      count(disks.result.map((d) => d.type)),
      '| with serial:',
      disks.result.filter((d) => d.serial).length,
    );
  }
  for (const params of [
    [[], false],
    [disks.result?.map((d) => d.name) ?? [], { powermode: 'STANDBY' }],
  ]) {
    const temperatures = await probe('disk.temperatures', params);
    if (temperatures.ok) {
      say(
        `disk.temperatures ${JSON.stringify(params).slice(0, 12)}…: values`,
        Object.values(temperatures.result ?? {}).map((v) => (v === null ? null : typeof v)),
      );
    }
  }
  const smart = await probe('smart.test.results', [[], {}]);
  if (smart.ok) {
    say(
      'smart.test.results: count',
      smart.result.length,
      '| last statuses',
      count(smart.result.map((r) => r.tests?.[0]?.status ?? 'none')),
    );
  }

  const apps = await probe('app.query');
  if (apps.ok) {
    say('app.query: count', apps.result.length, '| states', count(apps.result.map((a) => a.state)));
  }
  for (const method of ['vm.query', 'virt.instance.query', 'container.query']) {
    const machines = await probe(method);
    if (machines.ok) {
      say(
        `${method}: count`,
        machines.result.length,
        '| states',
        count(
          machines.result.map((m) => (typeof m.status === 'object' ? m.status?.state : m.status)),
        ),
      );
    }
  }

  for (const method of ['update.status', 'update.check_available']) {
    const update = await probe(method);
    if (update.ok) {
      say(
        `${method}: fields`,
        keysOf(update.result).join(', '),
        '| status',
        typeof update.result?.status === 'object'
          ? keysOf(update.result.status)
          : update.result?.status,
      );
    }
  }

  // 2. What the integration makes of one full read.
  const snapshot = parseSnapshot(await client.read({ disks: true, update: false }));
  say('snapshot: version', snapshot.version, '| legacy', snapshot.legacy);
  say(
    'snapshot: cpu',
    snapshot.cpu !== null,
    '| memory',
    snapshot.memory !== null,
    '| cpu temperature',
    snapshot.cpuTemperature !== null,
  );
  say('snapshot: alert level', snapshot.alertLevel, '| active alerts', snapshot.alerts?.length);
  say(
    'snapshot: pools',
    snapshot.pools?.map(
      (p) =>
        `${p.state} ${p.percent === null ? '?' : Math.round(p.percent)}% scrub ${p.lastScrubAt ? 'dated' : 'none'}`,
    ),
  );
  say(
    'snapshot: disks',
    count(
      (snapshot.disks ?? []).map(
        (d) => `${d.state}/${d.temperature === null ? 'no temp' : 'temp'}`,
      ),
    ),
  );
  say('snapshot: apps', snapshot.apps?.length, '| vms', snapshot.vms?.length);
  say('snapshot: parts in error', Object.keys(snapshot.errors));
} catch (err) {
  say('failed:', err.kind ?? err.code ?? err.name, err.kind ? '' : err.message);
  process.exitCode = 1;
} finally {
  client.close();
}
