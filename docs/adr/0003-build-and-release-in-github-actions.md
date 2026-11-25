---
status: accepted
date: 2026-11-25
---

# Build and release the plugin ZIP in GitHub Actions

## Context and Problem Statement

Users install the plugin by uploading a ZIP into Super Productivity. Until now the ZIP was built by hand on a
developer machine and attached to releases manually. That makes it easy to ship a ZIP that doesn't match the
tagged source, wasn't tested, or carries the wrong version (SP keys plugin updates on the manifest version).

## Considered Options

* Build in GitHub Actions: CI on every PR/push, and a release on version tags
* Keep building and uploading by hand

## Decision Outcome

Chosen option: "build in GitHub Actions", because every published ZIP is then built from the tagged commit, after
the typecheck and the test suite have passed.

* `ci.yml` runs on pull requests and on pushes to `main`: typecheck, tests, build, pack, and the ZIP uploaded as a
  run artifact, so every PR has an installable build.
* `release.yml` runs on `v*` tags. It fails unless the tag equals the `package.json` and `manifest.json` versions,
  then builds and creates the GitHub release with the ZIP, using the preinstalled `gh` CLI and only GitHub's own
  actions.
* To release: bump the version in both files, merge, then `git tag vX.Y.Z && git push origin vX.Y.Z`.
