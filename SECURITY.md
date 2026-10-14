# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration keeps and sends:

- **The API key** of TrueNAS lives in the Gladys configuration only. It is
  sent to the NAS in the login call, over HTTPS (secure WebSocket) only: an
  `http://` address is refused before anything is sent, since TrueNAS revokes
  a key used over plain HTTP. It is never logged, never written under `/data`
  and never sent to Gladys.
- **`/data/truenas-state.json`** holds what the scene triggers compare with:
  the host id of the NAS (a hash TrueNAS derives from `/etc/hostid`), the
  state of each pool by guid and the ids of the active alerts. No secret.
- **Network**: one WebSocket to the address of the NAS configured by the
  user, on the local network. Nothing else is contacted. Accepting a
  self-signed certificate is an option, off by default.
- **Commands**: reading by default. Starting and stopping apps and VMs, and
  restarting or shutting down the NAS, are refused unless the user allows them
  in the configuration, and TrueNAS refuses them anyway to a read-only key.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
TrueNAS and the devices the integration talks to.
