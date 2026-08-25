#!/usr/bin/env bash
# Fail-closed guard used by .github/workflows/dependabot-lockfiles.yml.
#
# That workflow regenerates NuGet lock files and pushes them back to a Dependabot
# pull request branch using a write-capable GitHub App token. Regenerating lock
# files means running `dotnet restore`, and `dotnet restore` evaluates MSBuild
# logic that lives in the repository (Directory.Build.props/.targets, .csproj,
# nuget.config, ...). If branch content could introduce or alter that logic, it
# could execute arbitrary code in a job that is about to hold a write token.
#
# This script is the mitigation. It refuses to let the workflow continue unless
# every single path changed by the pull request is a NuGet dependency manifest:
#
#   Directory.Packages.props   -- the Central Package Management version list
#   **/packages.lock.json      -- the per-project lock files
#
# Anything else -- a .csproj, Directory.Build.targets, nuget.config, global.json,
# a workflow file, a shell script -- is rejected and the workflow stops before
# any dotnet command runs. An empty diff is rejected too: there is nothing
# legitimate to sync, so proceeding would only add risk.
#
# Usage: tools/verify-dependency-only-diff.sh <base-ref> <head-ref>
set -Eeuo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <base-ref> <head-ref>" >&2
  exit 2
fi

base_ref="$1"
head_ref="$2"

merge_base="$(git merge-base "${base_ref}" "${head_ref}")"

changed=()
while IFS= read -r -d '' path; do
  changed+=("${path}")
done < <(git diff --name-only --no-renames -z "${merge_base}" "${head_ref}")

if [[ ${#changed[@]} -eq 0 ]]; then
  echo "Refusing to continue: no files changed between ${base_ref} and ${head_ref}." >&2
  echo "There is no dependency update to synchronize." >&2
  exit 1
fi

rejected=()
for path in "${changed[@]}"; do
  case "${path}" in
    Directory.Packages.props | packages.lock.json | */packages.lock.json) ;;
    *) rejected+=("${path}") ;;
  esac
done

if [[ ${#rejected[@]} -gt 0 ]]; then
  echo "Refusing to continue: this pull request changes files that are not NuGet" >&2
  echo "dependency manifests. Automatic lock-file synchronization only runs on" >&2
  echo "diffs limited to Directory.Packages.props and **/packages.lock.json." >&2
  echo >&2
  echo "Disallowed paths:" >&2
  printf '  %s\n' "${rejected[@]}" >&2
  exit 1
fi

echo "Diff is dependency-only (${#changed[@]} file(s)):"
printf '  %s\n' "${changed[@]}"
