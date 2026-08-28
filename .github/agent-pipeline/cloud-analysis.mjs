import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCodegraph,
  loadTeam,
  matchesGlob,
  selectOwner,
  selectPrTeam,
} from "./pipeline.mjs";

const POLICY_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "team.yaml");
const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function trackedFiles(repo) {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).split("\0").filter(Boolean);
}

function codeownersGlob(pattern) {
  let normalized = String(pattern ?? "").trim().replace(/^\/+/, "");
  if (!normalized || normalized.startsWith("!") || normalized.includes("[")) return null;
  if (normalized.endsWith("/")) normalized += "**";
  if (!normalized.includes("/")) normalized = `**/${normalized}`;
  return normalized;
}

function codeownersRules(repo) {
  const relative = CODEOWNERS_PATHS.find((candidate) => existsSync(resolve(repo, candidate)));
  if (!relative) return { path: null, rules: [] };
  const rules = [];
  for (const rawLine of readFileSync(resolve(repo, relative), "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    const pattern = codeownersGlob(fields.shift());
    const owners = unique(fields
      .filter((field) => /^@[A-Za-z0-9-]+$/.test(field))
      .map((field) => field.slice(1)));
    if (pattern && owners.length) rules.push({ pattern, owners });
  }
  return { path: relative, rules };
}

function codeownersAssignments(repo) {
  const files = trackedFiles(repo);
  const parsed = codeownersRules(repo);
  const assignments = new Map();
  for (const filePath of files) {
    let owners = [];
    for (const rule of parsed.rules) if (matchesGlob(filePath, rule.pattern)) owners = rule.owners;
    for (const owner of owners) {
      if (!assignments.has(owner)) assignments.set(owner, []);
      assignments.get(owner).push(filePath);
    }
  }
  return { path: parsed.path, assignments };
}

function normalizedPerson(person) {
  return {
    github: person.github,
    active: person.active !== false,
    main_agent: "codex",
    responsibilities: {
      domains: [...(person.responsibilities?.domains ?? [])],
      labels: [...(person.responsibilities?.labels ?? [])],
      keywords: [...(person.responsibilities?.keywords ?? [])],
      paths: [...(person.responsibilities?.paths ?? [])],
    },
    review: {
      can_review: person.review?.can_review === true,
      high_risk_domains: [...(person.review?.high_risk_domains ?? [])],
      high_risk_paths: [...(person.review?.high_risk_paths ?? [])],
    },
  };
}

/** Builds a target-specific R&R projection without copying the central runtime into the target repository. */
export function buildRepositoryTeam(repoInput, compatibility) {
  const repo = resolve(repoInput ?? ".");
  const central = loadTeam(POLICY_PATH);
  const ownership = compatibility.ownership ?? {};
  const people = new Map((ownership.people ?? []).map((person) => {
    const normalized = normalizedPerson(person);
    return [normalized.github.toLowerCase(), normalized];
  }));
  let codeownersPath = null;
  if (ownership.source !== "config") {
    const codeowners = codeownersAssignments(repo);
    codeownersPath = codeowners.path;
    for (const [login, paths] of codeowners.assignments) {
      const key = login.toLowerCase();
      const person = people.get(key) ?? normalizedPerson({
        github: login,
        responsibilities: {},
        review: { can_review: true },
      });
      person.responsibilities.paths = unique([...person.responsibilities.paths, ...paths]);
      person.review.high_risk_paths = unique([...person.review.high_risk_paths, ...paths]);
      people.set(key, person);
    }
  }

  const fallback = ownership.fallback;
  if (fallback && !people.has(fallback.toLowerCase())) {
    people.set(fallback.toLowerCase(), normalizedPerson({
      github: fallback,
      responsibilities: {},
      review: { can_review: true },
    }));
  } else if (fallback) {
    const person = people.get(fallback.toLowerCase());
    person.active = true;
    person.review.can_review = true;
  }

  return {
    version: central.version,
    pipeline: {
      ...central.pipeline,
      fallback_assignee: fallback,
      max_issue_assignees: ownership.max_issue_assignees ?? central.pipeline.max_issue_assignees,
      max_pr_assignees: ownership.max_pr_assignees ?? central.pipeline.max_pr_assignees,
      protected_paths: unique([...central.pipeline.protected_paths, ...compatibility.protected_paths]),
      validation_commands: [...compatibility.validation_commands],
      codegraph: compatibility.codegraph ?? central.pipeline.codegraph,
    },
    people: [...people.values()],
    source: {
      ownership: ownership.source ?? "fallback",
      codeowners_path: codeownersPath,
    },
  };
}

export function relatedPaths(codegraph, issueNumber) {
  const issueId = `issue:${issueNumber}`;
  return unique((codegraph.edges ?? [])
    .filter((edge) => edge.type === "related" && edge.from === issueId && String(edge.to ?? "").startsWith("file:"))
    .sort((left, right) => Number(right.confidence ?? 0) - Number(left.confidence ?? 0))
    .map((edge) => edge.to.slice(5)));
}

export function summarizeCodegraph(codegraph, issueNumber) {
  const edgeTypes = {};
  for (const edge of codegraph.edges ?? []) edgeTypes[edge.type] = (edgeTypes[edge.type] ?? 0) + 1;
  return {
    version: codegraph.version,
    file_count: codegraph.file_count,
    truncated: codegraph.truncated,
    node_count: (codegraph.nodes ?? []).length,
    edge_count: (codegraph.edges ?? []).length,
    edge_types: edgeTypes,
    related_paths: relatedPaths(codegraph, issueNumber),
  };
}

/** Performs the active hostless Issue R&R and CodeGraph analysis. */
export function analyzeRepositoryIssue(options = {}) {
  const issue = options.issue;
  const issueNumber = Number(issue?.number);
  const team = buildRepositoryTeam(options.repo, options.compatibility);
  const codegraph = buildCodegraph(team, {
    repo: options.repo,
    issue,
    changed_files: options.changed_paths ?? [],
    max_files: team.pipeline.codegraph?.max_files,
  });
  const paths = relatedPaths(codegraph, issueNumber);
  const rrOwner = selectOwner(team, issue);
  const pathRouting = selectPrTeam(team, {
    changed_paths: paths,
    codegraph,
    risk: "low",
  });
  const pathCandidate = pathRouting.candidates.find((candidate) => candidate.score >= 60);
  const usePathCandidate = Boolean(pathCandidate) && (rrOwner.used_fallback || pathCandidate.score > rrOwner.score);
  const owner = usePathCandidate ? {
    ...rrOwner,
    assignee: pathCandidate.github,
    score: pathCandidate.score,
    used_fallback: false,
    rationale: "Highest deterministic CodeGraph path/contribution score",
    selected: pathCandidate,
  } : rrOwner;
  return {
    team,
    codegraph,
    codegraph_summary: summarizeCodegraph(codegraph, issueNumber),
    owner,
    related_paths: paths,
  };
}
