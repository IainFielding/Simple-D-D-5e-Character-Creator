# Contributing

Thanks for taking the time to contribute. This is a Foundry VTT module for the D&D 5e
system, so most changes need checking in a real world as well as in the test suite.

## Getting set up

```sh
npm install        # dev tooling only — nothing here ships in the module archive
npm run check      # JSON validation, lint, unit tests (what CI runs)
```

To try the module in Foundry, symlink or copy the repository into your
`Data/modules/` directory as `sogrom-dnd5e-character-creator`.

## Before opening a pull request

- `npm run check` passes locally.
- User-facing strings go through `lang/en.json` rather than being hard-coded.
- Unit tests cover the changed behaviour where the behaviour is testable outside Foundry.
- The change has been clicked through in a real world — unit tests don't cover the UI.
  Say which Foundry version, D&D 5e system version, and content modules you tested against.

Keep pull requests small and focused; unrelated changes bundled together are much slower
to review. The pull request template asks for the same details, so filling it in is enough.

## Commit messages

Write a short imperative subject line describing the change, and use the body for the
reasoning if it isn't obvious from the diff. See also the two sections below: every commit
needs a sign-off, and no commit should carry AI tool attribution.

### Sign your work — the Developer Certificate of Origin

Every commit must be signed off. Sign-off is a single trailer at the end of the commit
message:

```
Signed-off-by: Your Name <your.email@example.com>
```

`git commit -s` adds it for you, using your configured `user.name` and `user.email`, so
set those once and forget about it:

```sh
git config user.name "Your Name"
git config user.email "your.email@example.com"
```

Adding that line certifies that you wrote the change, or otherwise have the right to
submit it under this project's licence. The full text of what you are certifying is the
Developer Certificate of Origin 1.1, reproduced verbatim in [DCO](DCO) at the root of this
repository — it is worth reading once.

This is **not** a contributor licence agreement. There is no paperwork to sign and no
rights are assigned to anyone; you are simply asserting, per commit, that the code was
yours to give. It matters particularly for AI-assisted changes: whichever tool you used,
the sign-off is you taking responsibility for the licensing of what you submitted.

If you would rather not remember the `-s` flag on every commit, git can add the trailer
for you in this repository:

```sh
git config format.signOff true
```

If you forget, CI will tell you. To fix it:

```sh
git commit --amend -s --no-edit       # the most recent commit
git rebase --signoff origin/main      # every commit on your branch
```

Then force-push the branch.

### AI-assisted contributions

AI coding assistants are permitted. You remain fully responsible for the correctness,
licensing, and style compliance of anything you submit, and you must be able to explain
your change on request.

Please do **not** include AI tool attribution in commit messages. Remove trailers such as
`Co-Authored-By: Claude ...`, `Co-authored-by: Copilot ...`, "Generated with ..." footers,
and similar tool sign-offs before opening a pull request. Co-author trailers are reserved
for human contributors.

A local hook is available to catch this before you commit:

```sh
git config core.hooksPath .githooks
```

The same check runs in CI on every pull request
(`.github/workflows/no-ai-attribution.yml`), so a stray trailer will fail the build.
