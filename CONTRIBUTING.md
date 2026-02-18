# Contributing to hyper-evm-toolkit

Thanks for improving hyper-evm-toolkit.

## Before opening an issue

- Search existing issues first.
- For security reports, do not open a public issue. Use the process in `SECURITY.md`.

## Development setup

```bash
npm ci
forge build
forge test -vvv
npm run lint --workspace=bridge
npm run format:check --workspace=bridge
npm run typecheck --workspace=bridge
npm run test --workspace=bridge
```

## Branch and PR workflow

- Create a branch from `main`.
- Branch naming: `feat/<issue>-<description>`, `fix/<issue>-<description>`, or `chore/<description>`.
- Keep changes focused and small.
- Fill out the pull request template completely.
- Ensure CI is green before requesting review.

## Coding guidelines

- Solidity changes must preserve single-path settlement behavior.
- Add tests for behavior changes in simulation and bridge logic.
- Keep naming consistent with existing codebase patterns.
- Avoid temporary or debug-only code in committed changes.

## Commit message style

Use `type(scope): description`, for example:

- `feat(sim): add destinationDex routing for CoreDepositWalletSim`
- `fix(bridge): reject unsupported action kinds with explicit reason`
