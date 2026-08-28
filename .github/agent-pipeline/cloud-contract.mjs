function requireValue(condition, message) {
  if (!condition) throw new TypeError(message);
}

function validRepository(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function validNumber(value) {
  return Number.isInteger(value) && value > 0;
}

function validBranch(value, issue) {
  return typeof value === "string" && value.startsWith(`agent/issue-${issue}-`) && /^[A-Za-z0-9._/-]+$/.test(value);
}

function completionContract() {
  return [
    "Read the `instructions` path printed by prepare completely and follow that pinned contract through plan, implementation, self-review, validate, and publish in this same Cloud task.",
    "Use the existing managed branch and canonical PR. Do not use `make_pr`, create a replacement branch or PR, or stop after a normal code-change Summary.",
    "This request is complete only when `prarness-session publish` returns `status=PUBLICATION_VERIFIED`, `complete=true`, and `verified=true` after confirming the live remote/PR SHA, reviewer assignment, managed review comments, and required CI. If publication cannot be verified, report the exact blocker and do not claim completion.",
  ];
}

export function cloudPullDispatchComment(repository, issue, pr) {
  requireValue(validRepository(repository), "repository must use owner/repository format");
  requireValue(validNumber(issue) && validNumber(pr), "Cloud dispatch requires positive Issue and PR numbers");
  return [
    `@codex Run one complete managed PRarness session for ${repository}, source Issue #${issue}, and canonical PR #${pr}.`,
    "",
    "Before inspecting or editing code, run these exact commands:",
    "",
    `1. \`$HOME/.local/bin/prarness-github-setup --verify ${repository}\``,
    `2. \`$HOME/.local/bin/prarness-session prepare --repository ${repository} --issue ${issue} --pr ${pr} --output /tmp/prarness-session.json --codegraph-output /tmp/prarness-codegraph.json\``,
    "",
    ...completionContract(),
  ].join("\n");
}

export function cloudIssueDispatchComment(repository, issue, branch) {
  requireValue(validRepository(repository), "repository must use owner/repository format");
  requireValue(validNumber(issue) && validBranch(branch, issue), "Cloud dispatch requires a managed Issue branch");
  return [
    `@codex Run one complete managed PRarness session for ${repository}, source Issue #${issue}, and managed branch ${branch}.`,
    "",
    "GitHub Actions prepared the branch but is not permitted to create pull requests. Before inspecting or editing code, run these exact commands:",
    "",
    `1. \`$HOME/.local/bin/prarness-github-setup --verify ${repository}\``,
    `2. \`$HOME/.local/bin/prarness-session prepare --repository ${repository} --issue ${issue} --branch ${branch} --output /tmp/prarness-session.json --codegraph-output /tmp/prarness-codegraph.json\``,
    "",
    "Prepare must use the verified repository GitHub App credential to create or reuse the canonical draft PR, bind it to the managed branch, and then perform R&R and CodeGraph analysis.",
    ...completionContract(),
  ].join("\n");
}

export function managedPullBody(repository, issue, pr, runtimeRef) {
  requireValue(/^[0-9a-f]{40}$/.test(runtimeRef), "runtimeRef must be a full lowercase commit SHA");
  return [
    `Closes #${issue}`,
    "",
    "## PRarness Cloud 작업 요청",
    "",
    `- Source Issue: #${issue}`,
    `- Runtime SHA: \`${runtimeRef}\``,
    "- Dispatch mode: `human_pr_mention`",
    "",
    "이 Draft PR은 PRarness가 관리하는 작업 대기열입니다. Codex Cloud를 시작하거나 계속하려면 연결된 사람이 이 PR에 다음 댓글을 직접 작성하세요.",
    "",
    "```text",
    cloudPullDispatchComment(repository, issue, pr),
    "```",
    "",
    "Cloud 작업은 임시 request manifest를 최종 변경에서 제거하고, 검증·커밋·push·Issue/PR 상태 갱신을 완료해야 합니다.",
    "",
    "> 자동 merge하지 않습니다.",
  ].join("\n");
}
