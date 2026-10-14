# TrueNAS for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) external integration that
monitors a **TrueNAS** NAS (Community Edition, formerly SCALE, **25.04 or
later**) over its local API: CPU, memory, temperatures, ZFS pools, disks,
apps, virtual machines, alerts and updates, with scene triggers when a pool
is degraded or TrueNAS raises an alert, and a dashboard widget.

> **Not affiliated with iXsystems.** Not endorsed or sponsored by iXsystems,
> Inc. TrueNAS is a trademark of its owner, named here only to describe
> compatibility.

> **Developed without the hardware: feedback welcome.** No TrueNAS was
> available while writing this integration: it reads the API as the TrueNAS
> middleware defines it (versions 25.04, 25.10 and 26.0) and is tested against
> answers rebuilt from those definitions. Reports from real NAS are the most
> useful contribution:
> [open an issue](https://github.com/guim31/gladys-truenas/issues).

User documentation: [English](docs/en.md) · [Français](docs/fr.md) ·
[Deutsch](docs/de.md) · [Español](docs/es.md).

## Features

- **The NAS**: online, CPU and memory use, CPU temperature, uptime, TrueNAS
  version, update available, number of active alerts and the highest level
  among them.
- **One device per pool**: state (online, errors, degraded, faulted…), alert
  flag, space used (%), free space and capacity (GB, as the storage page of
  TrueNAS counts them), days since the last scrub and the errors it found.
- **One device per disk**: temperature, SMART state and alert flag.
- **One device per app and per virtual machine** (Incus instances on 25.04
  and 25.10 too): running, state; update available for the apps. A
  _Start / stop_ switch when allowed in the configuration (off by default).
- **Scene triggers**: _Pool degraded_ and _New TrueNAS alert_ (with its level
  and text) — fired on transitions only, remembered across restarts.
- **Scene actions**: _Restart the TrueNAS NAS_ and _Shut down the TrueNAS
  NAS_, refused unless allowed in the configuration (off by default).
- **Dashboard widget** _TrueNAS_: CPU and memory gauges, temperature, what
  needs attention first (alerts, pools, disks, crashed apps, update), then the
  pools, the apps and VMs running, the uptime.
- Feature names, states and messages in English, French, German and Spanish.

Nothing is deleted, no dataset, share or snapshot is touched.

## Requirements

- Gladys Assistant **5.1.0** or later.
- TrueNAS **25.04** or later (Community Edition / SCALE), reachable from
  Gladys over **HTTPS**. TrueNAS CORE and SCALE 24.10 and older do not have
  the JSON-RPC API this integration uses.
- An **API key** of a user with the _Read-only Administrator_ role. Starting
  and stopping apps and VMs needs the `APPS_WRITE` and `VM_WRITE` roles;
  restarting and shutting down needs a full administrator.

## Installation

1. In Gladys, **Integrations → Install from GitHub**, then
   `https://github.com/guim31/gladys-truenas` (or install **TrueNAS** from the
   store once it is listed).
2. In its **Configuration** tab, enter the address of the NAS (e.g.
   `192.168.1.20`) and the API key, tick _Accept a self-signed certificate_
   unless the NAS has a certificate Gladys can verify, then save.
3. Use **Test the connection** to check what was found.
4. Add the NAS, its pools, disks, apps and VMs from the **Discover** tab.

## How it works

The integration opens one WebSocket to `wss://<nas>/api/current` (the
JSON-RPC 2.0 API of TrueNAS 25.04+; the REST API is deprecated since 25.04),
logs in with `auth.login_with_api_key` and keeps the connection open between
reads. Never over plain HTTP: **TrueNAS revokes an API key used on an
insecure transport**, so `http://` addresses are refused before anything is
sent. At each refresh (every 1, 2 or 5 minutes):

- `system.info`, `system.host_id` (once: the identity of the NAS);
- `reporting.netdata_get_data` for the `cpu`, `memory` and `cputemp` graphs;
- `alert.list`, `pool.query` and `pool.dataset.query` (the root datasets:
  used and available space without parity), `app.query`, `vm.query`,
  `virt.instance.query` (25.04, 25.10) and `container.query` (26.0);
- every 5 minutes: `disk.query`, `disk.temperatures` (on 25.04 told not to
  wake a sleeping disk), `smart.test.results` on 25.04 (25.10 removed SMART
  tests from its API: the SMART alerts are used instead);
- every 6 hours: `update.status` (25.10+) or `update.check_available` (25.04).

Start and stop use `app.start` / `app.stop`, `vm.start` / `vm.stop` (graceful,
never forced), `virt.instance.*` or `container.*`, and wait for the job.
Restart and shutdown use `system.reboot` / `system.shutdown`, only from a
scene, only when allowed. Devices are published with `should_poll: false`:
the integration reads the NAS on its own timer and sends only the values that
changed (and every value again after 6 hours). A refused key is never retried
on its own: each try is a failed login in the audit log of the NAS.

## Checked, and what was not

Checked here: the parsing of answers rebuilt from the API models of the
TrueNAS middleware for 25.04 and 25.10 ([`test/fixtures/truenas/`](test/fixtures/truenas)),
the login, reconnection and session flow against an in-memory TrueNAS, the
WebSocket transport against a local server (TLS with a self-signed
certificate refused, then accepted on option), the conformity of every device
with the Gladys core ([`test/gladys-rules.test.js`](test/gladys-rules.test.js)),
the widget against the validator of the SDK.

**Not checked on a real NAS:** TrueNAS cannot run in the development
container (it is a whole operating system), and the official API site was
out of reach. In particular: the exact reporting graph legends on real
hardware, the `disk.temperatures` answer on 25.04, the text of the SMART
alerts of 25.10 (the disk is found by serial number or device name in it),
the jobs of start and stop, and the answer to reboot and shutdown. The
script [`scripts/probe.mjs`](scripts/probe.mjs) checks the reads on a real
NAS, read only, without printing anything sensitive.

## Limitations

- One NAS per installation; TrueNAS 25.04 or later only.
- The texts of the alerts are in English, as TrueNAS writes them.
- Datasets, shares, snapshots, replication and cloud sync tasks are not read.
- Gladys has no generic percentage: usage is a fill level in %.

## Development

```bash
npm ci
npm run format:check
npm run lint
npm test
npx -y github:GladysAssistant/integration-store .
TRUENAS_URL=192.0.2.20 TRUENAS_API_KEY=… TRUENAS_INSECURE=1 npm run probe
```

The tests use the fake Gladys of the SDK (`@gladysassistant/integration-sdk/testing`)
and an in-memory TrueNAS ([`test/helpers/fakeTruenas.js`](test/helpers/fakeTruenas.js)).
See [`CLAUDE.md`](CLAUDE.md) for the project rules.

### Releasing

Describe the changes under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md),
then open **Actions → Release → Run workflow** and pick `patch`, `minor` or
`major`: the workflow bumps the version everywhere, moves the changelog
section, pushes the `vX.Y.Z` tag, builds the multi-arch image to `ghcr.io` and
publishes the GitHub Release.

> Prefer the terminal? `git tag v1.0.0 && git push --tags` triggers the same
> build and Release, but does **not** touch `package.json`, `CHANGELOG.md` or
> the manifest: bump `version` in `package.json` and in
> `gladys-assistant-integration.json` (with the `docker_image` tag) and commit
> it **before** tagging.

## Credits

- [tomaae/homeassistant-truenas](https://github.com/tomaae/homeassistant-truenas)
  (Apache-2.0) by Tomaae and contributors: which methods are worth reading and
  how a client logs in over `/api/current`.
- The [TrueNAS middleware](https://github.com/truenas/middleware) and the
  [TrueNAS API client](https://github.com/truenas/api_client) (LGPL-3.0, read
  only, nothing copied): the method names, the fields of their answers, and
  the revocation of API keys used over HTTP.
- The architecture and the conformity tests follow
  [gladys-qnap](https://github.com/guim31/gladys-qnap), started from the
  official
  [integration template](https://github.com/GladysAssistant/integration-template-js).

## License

Apache-2.0
