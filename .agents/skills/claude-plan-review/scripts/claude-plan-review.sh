#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage:
  claude-plan-review.sh <plan-file.md> [output-file.md]
  claude-plan-review.sh --mode plan <plan-file.md> [output-file.md]
  claude-plan-review.sh --mode code [target] [output-file.md]
  claude-plan-review.sh --code [target] [output-file.md]

Runs the local Claude Code CLI against a plan using the Claude-side
/reviewing-plans skill, then writes the review to a markdown file.

In code-review mode, target may be a git ref/range, commit, branch, path, or
free-form scope. If omitted, Claude reviews the current worktree and branch diff.

Uses Claude Opus 4.8 by default.
Override explicitly when needed with:
  CLAUDE_REVIEW_MODEL=opus
  CLAUDE_PLAN_REVIEW_MODEL=sonnet
  CLAUDE_CODE_REVIEW_MODEL=opus
USAGE
}

mode="plan"

if [[ "${1:-}" == "--mode" ]]; then
  if [[ $# -lt 2 ]]; then
    usage
    exit 2
  fi
  mode="$2"
  shift 2
elif [[ "${1:-}" == "--code" ]]; then
  mode="code"
  shift
elif [[ "${1:-}" == "--plan" ]]; then
  mode="plan"
  shift
fi

if [[ "$mode" != "plan" && "$mode" != "code" ]]; then
  echo "Unsupported mode: $mode" >&2
  usage
  exit 2
fi

if [[ "$mode" == "plan" && ( $# -lt 1 || $# -gt 2 ) ]]; then
  usage
  exit 2
fi

if [[ "$mode" == "code" && $# -gt 2 ]]; then
  usage
  exit 2
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code CLI not found on PATH." >&2
  exit 1
fi

repo_dir="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
add_dirs=("$repo_dir")

if [[ "$mode" == "plan" ]]; then
  plan_path="$1"
  out_path="${2:-}"

  if [[ ! -f "$plan_path" ]]; then
    echo "Plan file not found: $plan_path" >&2
    exit 1
  fi

  plan_dir="$(cd "$(dirname "$plan_path")" && pwd)"
  plan_base="$(basename "$plan_path")"
  plan_abs="$plan_dir/$plan_base"
  add_dirs+=("$plan_dir")

  if [[ -z "$out_path" ]]; then
    stem="${plan_base%.*}"
    out_path="${TMPDIR:-/tmp}/claude-plan-review-$stem-$$.md"
  fi

  prompt="$(cat <<PROMPT
/reviewing-plans

Review the implementation plan at:
$plan_abs

Run from this workspace:
$repo_dir

Constraints:
- Use the reviewing-plans skill if available.
- Read $repo_dir/.agents/skills/plan-hardening-loop/SKILL.md and its references/plan-format.md before reviewing.
- Inspect Decision coverage for complete buckets, the original user acknowledgement/request and approved scope, separate current internal revalidation, hidden consequential assumptions, and choices that still require a decision from Nick. Distinguish an already approved choice from a newly introduced tradeoff.
- Do not treat evidence, reviewer preference, or the orchestrator's recommendation as Nick's approval.
- Ground findings in the actual codebase with file:line citations.
- Do not edit files.
- Do not rewrite the plan.
- This review is terminal: return your verdict without spawning or invoking another reviewer.
- Separate hard technical defects from product, scope, architecture, or risk tradeoffs.
- For each tradeoff, state the decision the owner must make instead of silently choosing it.
- Return only the verdict report in Markdown.
- If blocked by auth, permissions, or a missing skill, explain the exact blocker.
PROMPT
)"
else
  target="${1:-current working tree and branch diff}"
  repo_name="$(basename "$repo_dir")"
  out_path="${2:-${TMPDIR:-/tmp}/claude-code-review-${repo_name}-$$.md}"

  prompt="$(cat <<PROMPT
Review this code change/scope:
$target

Run from this workspace:
$repo_dir

Instructions:
- Act as a senior code reviewer.
- Prioritize correctness bugs, behavioral regressions, security/privacy risks, broken tests, and missing test coverage.
- If target is a git ref/range/commit/branch, inspect the relevant diff.
- If target is a file or directory, inspect that code and its callers.
- If target is "current working tree and branch diff", inspect staged, unstaged, and branch changes against the likely base branch.
- Ground findings in actual code with file:line citations where possible.
- Do not edit files.
- Do not rewrite the change.
- This review is terminal: return your verdict without spawning or invoking another reviewer.
- Put findings first, ordered by severity.
- Separate hard defects from maintainability or product tradeoffs.
- Do not present a preference as a correctness finding.
- If no issues are found, say so clearly and call out residual risk or test gaps.
- Return only the review report in Markdown.
PROMPT
)"
fi

out_dir="$(dirname "$out_path")"
mkdir -p "$out_dir"
out_abs="$(cd "$out_dir" && pwd)/$(basename "$out_path")"

if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "Warning: ANTHROPIC_API_KEY is set; Claude Code may use API billing." >&2
fi

if [[ "$mode" == "code" ]]; then
  review_model="${CLAUDE_CODE_REVIEW_MODEL:-${CLAUDE_REVIEW_MODEL:-claude-opus-4-8}}"
  effort="${CLAUDE_CODE_REVIEW_EFFORT:-${CLAUDE_REVIEW_EFFORT:-${CLAUDE_PLAN_REVIEW_EFFORT:-high}}}"
  timeout_seconds="${CLAUDE_CODE_REVIEW_TIMEOUT:-${CLAUDE_REVIEW_TIMEOUT:-${CLAUDE_PLAN_REVIEW_TIMEOUT:-900}}}"
  fallback_model="${CLAUDE_CODE_REVIEW_FALLBACK_MODEL:-${CLAUDE_REVIEW_FALLBACK_MODEL:-}}"
else
  review_model="${CLAUDE_PLAN_REVIEW_MODEL:-${CLAUDE_REVIEW_MODEL:-claude-opus-4-8}}"
  effort="${CLAUDE_PLAN_REVIEW_EFFORT:-${CLAUDE_REVIEW_EFFORT:-high}}"
  timeout_seconds="${CLAUDE_PLAN_REVIEW_TIMEOUT:-${CLAUDE_REVIEW_TIMEOUT:-900}}"
  fallback_model="${CLAUDE_PLAN_REVIEW_FALLBACK_MODEL:-${CLAUDE_REVIEW_FALLBACK_MODEL:-}}"
fi

if [[ "$effort" == "xhigh" ]]; then
  effort="high"
fi

add_dir_args=()
for dir in "${add_dirs[@]}"; do
  add_dir_args+=(--add-dir "$dir")
done

review_label="Claude review"
if [[ "$mode" == "code" ]]; then
  review_label="Claude code review"
fi

claude_cmd=(claude \
  --print \
  --permission-mode auto \
  --effort "$effort" \
  --output-format text \
  --input-format text \
  --no-session-persistence \
  "${add_dir_args[@]}")

if [[ -n "$review_model" ]]; then
  claude_cmd+=(--model "$review_model")
fi

if [[ -n "$fallback_model" ]]; then
  claude_cmd+=(--fallback-model "$fallback_model")
fi

echo "$review_label config: model=${review_model:-configured-default} effort=$effort timeout=${timeout_seconds}s fallback=${fallback_model:-none}" >&2

printf '%s\n' "$prompt" | {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$timeout_seconds" "${claude_cmd[@]}"
  else
    perl -e 'alarm shift; exec @ARGV' "$timeout_seconds" "${claude_cmd[@]}"
  fi
} | tee "$out_abs"

echo >&2
echo "$review_label written to: $out_abs" >&2
