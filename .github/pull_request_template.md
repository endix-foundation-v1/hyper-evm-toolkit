## Summary

<!-- What does this PR change and why? -->

Closes #

## Type of Change

- [ ] `feat`: New capability
- [ ] `fix`: Bug fix
- [ ] `refactor`: Internal restructure without behavior change
- [ ] `docs`: Documentation only
- [ ] `test`: Tests only
- [ ] `chore`: Tooling, CI/CD, maintenance

## Verification

- [ ] `forge fmt --check` passes
- [ ] `forge test -vvv` passes
- [ ] `npm run lint --workspace=bridge` passes
- [ ] `npm run typecheck --workspace=bridge` passes
- [ ] `npm run test --workspace=bridge` passes

## Simulation Fidelity Checklist (for VHC/Core simulation changes)

- [ ] Behavior mirrors documented HyperCore semantics
- [ ] Settlement still flows through bridge result functions
- [ ] No shortcut mocks bypass real simulation paths
- [ ] New edge cases covered by tests

## Notes for Reviewers

<!-- Mention risky areas, tradeoffs, or migration impacts. -->
