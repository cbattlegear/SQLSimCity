#!/usr/bin/env bash
# Exercises tools/verify-dependency-only-diff.sh against synthetic pull requests.
#
# Every case builds a real throwaway git repository with real commits, so the
# script's real code path (git merge-base + git diff) is what gets tested.
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
guard="${repo_root}/tools/verify-dependency-only-diff.sh"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/sqlsimcity-diffguard.XXXXXX")"
cleanup() {
  rm -rf -- "${work_dir}"
}
trap cleanup EXIT

failures=0

# Files present on the base branch, mirroring the shape of the real repository.
base_files=(
  Directory.Packages.props
  Directory.Build.props
  nuget.config
  global.json
  .github/workflows/ci.yml
  src/SqlSimCity.Api/SqlSimCity.Api.csproj
  src/SqlSimCity.Api/packages.lock.json
  src/SqlSimCity.Archive/packages.lock.json
  src/SqlSimCity.Archive.Tool/packages.lock.json
  src/SqlSimCity.Edge.Connector/packages.lock.json
  tests/SqlSimCity.Api.Tests/packages.lock.json
  tests/SqlSimCity.Archive.Tests/packages.lock.json
  tests/SqlSimCity.Collection.Tests/packages.lock.json
  tests/SqlSimCity.Edge.Tests/packages.lock.json
  tests/SqlSimCity.Storage.Tests/packages.lock.json
  src/SqlSimCity.Api/not-packages.lock.json
  packages.lock.json.bak
  Directory.Packages.props.old
  src/nested/Directory.Packages.props
)

make_repo() {
  local dir="$1"
  local file
  mkdir -p "${dir}"
  git -C "${dir}" init --quiet --initial-branch=main
  git -C "${dir}" config user.email test@example.invalid
  git -C "${dir}" config user.name "Diff Guard Test"
  git -C "${dir}" config core.autocrlf false
  for file in "${base_files[@]}"; do
    mkdir -p "${dir}/$(dirname -- "${file}")"
    printf 'base\n' >"${dir}/${file}"
  done
  git -C "${dir}" add --all
  git -C "${dir}" commit --quiet --message "base"
  git -C "${dir}" checkout --quiet -b feature
}

# run_case <name> <expect: accept|reject> <mutation...>
# Each mutation is "modify:<path>", "delete:<path>", "add:<path>" or "none".
run_case() {
  local name="$1"
  local expect="$2"
  shift 2

  local dir="${work_dir}/case-$((RANDOM))-$$"
  make_repo "${dir}"

  local mutation action path
  for mutation in "$@"; do
    action="${mutation%%:*}"
    path="${mutation#*:}"
    case "${action}" in
      modify | add)
        mkdir -p "${dir}/$(dirname -- "${path}")"
        printf 'changed\n' >"${dir}/${path}"
        ;;
      delete) rm -f -- "${dir}/${path}" ;;
      none) ;;
      *)
        echo "unknown mutation ${mutation}" >&2
        exit 2
        ;;
    esac
  done

  if [[ "$*" != "none" ]]; then
    git -C "${dir}" add --all
    git -C "${dir}" commit --quiet --message "change"
  fi

  local status=0
  local output
  output="$(cd "${dir}" && "${guard}" main feature 2>&1)" || status=$?

  local outcome="accept"
  [[ ${status} -eq 0 ]] || outcome="reject"

  if [[ "${outcome}" == "${expect}" ]]; then
    printf 'ok       %-58s (%s)\n' "${name}" "${outcome}"
  else
    printf 'FAILED   %-58s expected %s, got %s\n' "${name}" "${expect}" "${outcome}"
    printf '%s\n' "${output}" | sed 's/^/           | /'
    failures=$((failures + 1))
  fi
}

# --- Accepted: what a real Dependabot NuGet pull request looks like -----------

# The exact file set regenerated in commit 156e692 (the manual fix on PR #59),
# plus the central version bump Dependabot itself makes.
run_case "realistic dependabot NuGet diff (props + 9 lock files)" accept \
  modify:Directory.Packages.props \
  modify:src/SqlSimCity.Api/packages.lock.json \
  modify:src/SqlSimCity.Archive/packages.lock.json \
  modify:src/SqlSimCity.Archive.Tool/packages.lock.json \
  modify:src/SqlSimCity.Edge.Connector/packages.lock.json \
  modify:tests/SqlSimCity.Api.Tests/packages.lock.json \
  modify:tests/SqlSimCity.Archive.Tests/packages.lock.json \
  modify:tests/SqlSimCity.Collection.Tests/packages.lock.json \
  modify:tests/SqlSimCity.Edge.Tests/packages.lock.json \
  modify:tests/SqlSimCity.Storage.Tests/packages.lock.json

run_case "central version list only" accept modify:Directory.Packages.props
run_case "single lock file only" accept modify:src/SqlSimCity.Api/packages.lock.json
run_case "new project lock file added" accept add:src/SqlSimCity.New/packages.lock.json
run_case "lock file deleted" accept delete:src/SqlSimCity.Api/packages.lock.json
run_case "root-level lock file" accept add:packages.lock.json

# --- Rejected: anything that could introduce build logic ----------------------

run_case "project file alongside dependency changes" reject \
  modify:Directory.Packages.props \
  modify:src/SqlSimCity.Api/packages.lock.json \
  modify:src/SqlSimCity.Api/SqlSimCity.Api.csproj

run_case "Directory.Build.props" reject modify:Directory.Build.props
run_case "Directory.Build.targets introduced" reject add:Directory.Build.targets
run_case "workflow file" reject modify:.github/workflows/ci.yml
run_case "nuget.config" reject modify:nuget.config
run_case "global.json" reject modify:global.json
run_case "shell script introduced" reject add:tools/evil.sh
run_case "MSBuild targets hidden in a project directory" reject \
  add:src/SqlSimCity.Api/hook.targets
run_case "deleted project file" reject delete:src/SqlSimCity.Api/SqlSimCity.Api.csproj

# --- Rejected: paths that merely look like allowlisted paths ------------------

run_case "not-packages.lock.json lookalike" reject \
  modify:src/SqlSimCity.Api/not-packages.lock.json
run_case "packages.lock.json.bak lookalike" reject modify:packages.lock.json.bak
run_case "Directory.Packages.props.old lookalike" reject modify:Directory.Packages.props.old
run_case "nested Directory.Packages.props" reject modify:src/nested/Directory.Packages.props

# --- Rejected: nothing to do --------------------------------------------------

run_case "empty diff" reject none

if [[ ${failures} -ne 0 ]]; then
  echo "${failures} dependency-only diff guard case(s) failed" >&2
  exit 1
fi

echo "All dependency-only diff guard cases passed."
