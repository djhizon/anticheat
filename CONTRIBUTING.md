# Contributing to ExamGuard

This repository is an advanced exam integrity enforcement platform.

## Before changing code

1. Read `README.md` and the unified context bank (`architecture_and_context.md`).
2. Keep synthetic fixtures only; never add real student information.
3. Define the affected files, invariants, acceptance checks, and rollback plan.
4. Prefer one small change per pull request.

## Validation

Run the narrowest relevant checks first, then `npm run validate` when
dependencies are installed. Report commands that could not run and why.

Do not commit secrets, `.env` files, databases, recordings, screenshots, or
generated build artifacts.
