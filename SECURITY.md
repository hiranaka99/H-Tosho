# Security policy

## Supported versions

Only the latest release receives security fixes. Update through
**Settings → Account → App updates** or by pulling the latest release.

## Reporting a vulnerability

Please do not report security problems in public issues, discussions, or pull
requests. Use GitHub's private vulnerability reporting instead:
[report a vulnerability](https://github.com/hiranaka99/H-Tosho/security/advisories/new).

Include:

- the H-Tosho version and how it is installed (Docker or source),
- the steps to reproduce the problem,
- what an attacker could achieve, and who they would need to be (for example,
  an unauthenticated visitor, a signed-in user, or a malicious provider
  response).

Remove real passwords, Kavita Auth Keys, E-Hentai session cookies, and webhook
URLs from anything you send. You will get a reply as soon as possible; please
allow time for a fix and release before disclosing the issue publicly.

## Scope

H-Tosho stores credentials for the services you connect, including Kavita Auth
Keys, provider credentials, E-Hentai/ExHentai session cookies, and Discord
webhook URLs. Issues that expose those values, bypass sign-in, let a provider
or remote page reach internal network addresses, write files outside the
configured library and data folders, or tamper with in-app updates are in scope.

H-Tosho is designed for a trusted home network. If you expose it to the
internet, put it behind HTTPS and a reverse proxy you trust.
