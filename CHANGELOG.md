# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Monitor a TrueNAS NAS (Community Edition / SCALE 25.04 or later) over its
  local JSON-RPC API, with an API key, over HTTPS only (TrueNAS revokes a key
  sent over HTTP); a self-signed certificate is accepted on option.
- The NAS: online, CPU, memory, CPU temperature, uptime, TrueNAS version,
  update available, active alerts and their highest level.
- One device per pool: state, alert, space used, free space, capacity, days
  since the last scrub and its errors.
- One device per disk: temperature, SMART state, alert.
- One device per app and per virtual machine (and Incus instance or
  container): running, state, update available for apps; an optional
  Start / stop switch, off by default.
- Scene triggers _Pool degraded_ and _New TrueNAS alert_ (level filter, text
  and class as variables), fired on transitions and remembered across
  restarts.
- Scene actions _Restart the TrueNAS NAS_ and _Shut down the TrueNAS NAS_,
  refused unless allowed in the configuration (off by default).
- Dashboard widget _TrueNAS_: CPU and memory gauges, temperature, problems
  first, pools, apps and VMs, uptime, Refresh button.
- _Test the connection_ action; refresh every 1, 2 or 5 minutes on the
  integration's own timer.
- English, French, German and Spanish feature names, states, messages and
  documentation.

[Unreleased]: https://github.com/guim31/gladys-truenas/commits/main
