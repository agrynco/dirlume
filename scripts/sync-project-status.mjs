const statuses = ["Backlog", "Ready", "In progress", "In review", "prerelease", "Done"];

export function eligible(labels) {
  return labels.includes("ready for dev") && !labels.includes("needs refinement") && !labels.includes("blocked");
}

function workBranch(ref) {
  const number = /^codex\/issue-(\d+)(?:-|$)/.exec(ref)?.[1];
  return number ? Number(number) : null;
}

export function taskIssues(pull) {
  const fromBranch = workBranch(pull.head.ref);
  const linked = [...(pull.body ?? "").matchAll(/^\s*Refs\s+#(\d+)\b/gim)].map((match) => Number(match[1]));
  return new Set([...(fromBranch === null ? [] : [fromBranch]), ...linked]);
}

export function projectStatus({ issue, pulls, refs, promoted }) {
  if (issue.state === "CLOSED") return "Done";
  if (issue.labels.includes("blocked")) return "Backlog";
  const open = pulls.find((pull) => pull.state === "open");
  if (open) return open.draft ? "In progress" : "In review";
  const oldBranches = new Set(pulls.map((pull) => pull.head.ref));
  if (refs.some((ref) => workBranch(ref) === issue.number && !oldBranches.has(ref))) return "In progress";
  if (pulls.some((pull) => pull.merged_at && !promoted.has(pull.merge_commit_sha))) return "prerelease";
  return eligible(issue.labels) ? "Ready" : "Backlog";
}

async function readJson(url, token, body) {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error("GitHub API returned HTTP " + response.status + ".");
  return response.json();
}

async function list(get, path) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const values = await get(path + (path.includes("?") ? "&" : "?") + "per_page=100&page=" + page);
    items.push(...values);
    if (values.length < 100) return items;
  }
}

async function sync() {
  const { PROJECT_TOKEN, REPOSITORY_TOKEN, GITHUB_API_URL, GITHUB_GRAPHQL_URL, GITHUB_REPOSITORY } = process.env;
  if (!PROJECT_TOKEN) {
    console.log("Set DIRLUME_PROJECT_TOKEN to enable the Dirlume project status workflow.");
    return;
  }
  if (!REPOSITORY_TOKEN || GITHUB_REPOSITORY !== "agrynco/dirlume") throw new Error("Expected the Dirlume repository.");
  const get = (path) => readJson(GITHUB_API_URL + "/repos/" + GITHUB_REPOSITORY + path, REPOSITORY_TOKEN);
  async function graphql(query, variables) {
    const response = await readJson(GITHUB_GRAPHQL_URL, PROJECT_TOKEN, { query, variables });
    if (response.errors?.length) throw new Error("GitHub Projects rejected the GraphQL request. Verify the project permission.");
    return response.data;
  }
  const { user } = await graphql(`query {
    user(login: "agrynco") {
      projectV2(number: 12) {
        id
        field(name: "Status") {
          ... on ProjectV2SingleSelectField { id options { id name } }
        }
      }
    }
  }`);
  const project = user?.projectV2;
  const option = new Map(project?.field?.options.map(({ id, name }) => [name, id]));
  if (!project || statuses.some((status) => !option.has(status))) {
    throw new Error("The Dirlume project or one of its Status options is unavailable.");
  }

  const [pulls, refs, ready] = await Promise.all([
    list(get, "/pulls?base=prerelease&state=all&sort=updated&direction=desc"),
    get("/git/matching-refs/heads/codex/issue-"),
    list(get, "/issues?state=open&labels=ready%20for%20dev"),
  ]);
  const branches = refs.map(({ ref }) => ref.replace(/^refs\/heads\//, ""));
  const byIssue = new Map();
  for (const pull of pulls) {
    if (pull.head.repo ? pull.head.repo.full_name !== GITHUB_REPOSITORY : pull.head.label?.split(":")[0] !== "agrynco") continue;
    for (const number of taskIssues(pull)) {
      const existing = byIssue.get(number) ?? [];
      existing.push(pull);
      byIssue.set(number, existing);
    }
  }
  const items = new Map();
  let cursor = null;
  do {
    const { node } = await graphql(`query($project: ID!, $cursor: String) {
      node(id: $project) {
        ... on ProjectV2 {
          items(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              isArchived
              fieldValueByName(name: "Status") {
                ... on ProjectV2ItemFieldSingleSelectValue { name }
              }
              content {
                ... on Issue {
                  id number state
                  repository { nameWithOwner }
                  labels(first: 50) { nodes { name } }
                }
              }
            }
          }
        }
      }
    }`, { project: project.id, cursor });
    for (const item of node.items.nodes) {
      if (item.content?.repository?.nameWithOwner === GITHUB_REPOSITORY) items.set(item.content.number, item);
    }
    cursor = node.items.pageInfo.hasNextPage ? node.items.pageInfo.endCursor : null;
  } while (cursor);

  for (const issue of ready) {
    if (issue.pull_request || items.has(issue.number) || !eligible(issue.labels.map(({ name }) => name))) continue;
    const { addProjectV2ItemById } = await graphql(`mutation($project: ID!, $content: ID!) {
      addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
    }`, { project: project.id, content: issue.node_id });
    items.set(issue.number, {
      ...addProjectV2ItemById.item,
      content: { number: issue.number, state: "OPEN", labels: { nodes: issue.labels } },
    });
  }

  const promoted = new Set();
  const observed = new Set();
  for (const item of items.values()) {
    if (item.isArchived || item.content.state === "CLOSED") continue;
    for (const pull of byIssue.get(item.content.number) ?? []) {
      const sha = pull.merge_commit_sha;
      if (!pull.merged_at || !sha || observed.has(sha)) continue;
      observed.add(sha);
      const result = await get("/compare/" + sha + "...main?per_page=1");
      if (["ahead", "identical"].includes(result.status)) promoted.add(sha);
    }
  }
  for (const { id, isArchived, content, fieldValueByName } of items.values()) {
    if (isArchived) continue;
    const issue = { ...content, labels: content.labels.nodes.map(({ name }) => name) };
    const status = projectStatus({ issue, pulls: byIssue.get(issue.number) ?? [], refs: branches, promoted });
    if (status === fieldValueByName?.name) continue;
    await graphql(`mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option }
      }) { projectV2Item { id } }
    }`, { project: project.id, item: id, field: project.field.id, option: option.get(status) });
    console.log("#" + issue.number + " → " + status);
  }
}

if (import.meta.main) await sync();
