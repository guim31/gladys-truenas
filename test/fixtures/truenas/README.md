# TrueNAS fixtures

Answers of the TrueNAS JSON-RPC API (`wss://<host>/api/current`), one file per
method, served by the in-memory TrueNAS of the tests
([`../../helpers/fakeTruenas.js`](../../helpers/fakeTruenas.js)).

- `25.10/`: TrueNAS 25.10 (Goldeye), the default NAS of the tests.
- `25.04/`: what differs on TrueNAS 25.04 (Fangtooth): its version,
  `update.check_available`, `smart.test.results`, Incus instances.

No real NAS was available, and the reference projects publish no recorded
answers: these files were **written by hand** from the API models of the
TrueNAS middleware (`src/middlewared/middlewared/api/v25_04_2`, `v25_10_5`,
`v26_0_0`, read only, LGPL-3.0: only the field names and enum values were
taken). Every value is invented: host names, serial numbers (`TESTDISK000x`),
host id, pool guids, sizes. `scripts/probe.mjs` checks their shape against a
real NAS.
