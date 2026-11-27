# Contributing to H-Tosho

Thanks for helping improve H-Tosho. Bug reports, fixes, and focused improvements
are welcome.

## Before you start

- **Bugs:** search the [existing issues](https://github.com/hiranaka99/H-Tosho/issues)
  first, then use the bug report form.
- **Larger changes:** open an issue describing the problem before writing code,
  so we can agree on the approach before you invest time in it.
- **Security problems:** do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Keep it safe to share

Some supported sources contain adult material. Issues, pull requests, screenshots,
and test fixtures must not contain sexually explicit images or links to them.
Use generated placeholder covers and fictional titles, as the existing tests and
`npm run screenshots` do. Also remove passwords, Kavita Auth Keys, E-Hentai
session cookies, API keys, and webhook URLs from anything you post.

## Development setup

You need **Node.js 26.13.1 or newer** and **npm 12**, which CI uses
(`npm install -g npm@12`). Then:

```bash
npm ci
npm run dev
```

`npm run dev` starts the Vite frontend with hot reload and a backend that reloads
changed source files. See [Development checks](README.md#development-checks) in
the README for details, and [docs/architecture.md](docs/architecture.md) and
[GLOSSARY.md](GLOSSARY.md) for how the code is organized and the terms it uses.

## Checks

CI runs these on every pull request; please run them before you push:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

The pre-commit hook formats staged files and runs lint, typecheck, and the tests.
For interface changes, also run the browser tests with `npm run test:e2e` after
installing Chromium once with
`npm exec --workspace @h-tosho/web -- playwright install chromium`.

Tests must not contact real providers or download real galleries. Stub network
calls the way the existing tests do.

## Pull requests

- Keep each pull request focused on one change, and add or update tests for it.
- Start commit messages and the pull request title with a type, such as `feat:`,
  `fix:`, `perf:`, `docs:`, `refactor:`, `test:`, `ci:`, or `chore:`.
- Include before and after screenshots for visible interface changes, using
  sample data. If the README screenshots change, regenerate them with
  `npm run screenshots`.
- Don't edit `CHANGELOG.md` or version numbers. They are updated when a release
  is prepared.

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
