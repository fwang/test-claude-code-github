#!/usr/bin/env bun

import os from "os";
import path from "path";
import { $ } from "bun";
import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import * as core from "@actions/core";
import * as github from "@actions/github";
import type { IssueCommentEvent } from "@octokit/webhooks-types";
import type { IssueQueryResponse, PullRequestQueryResponse } from "./types";

if (github.context.eventName !== "issue_comment") {
  core.setFailed(`Unsupported event type: ${github.context.eventName}`);
  process.exit(1);
}

const { owner, repo } = github.context.repo;
const payload = github.context.payload as IssueCommentEvent;
const actor = github.context.actor;
const issueId = payload.issue.number;
const body = payload.comment.body;
const isPR = payload.issue.pull_request;

let octoRest: Octokit;
let octoGraph: typeof graphql;
let commentId: number;

async function run() {
  try {
    const match = body.match(/^hey\s*opencode,?\s*(.*)$/);
    if (!match?.[1]) throw new Error("Command must start with `hey opencode`");
    const userPrompt = match[1];

    // TODO
    console.log("REF1", process.env.REF1);
    console.log("REF2", process.env.REF2);
    throw new Error("manual");

    const oidcToken = await generateGitHubToken();
    const appToken = await exchangeForAppToken(oidcToken);
    octoRest = new Octokit({ auth: appToken });
    octoGraph = graphql.defaults({
      headers: { authorization: `token ${appToken}` },
    });
    await assertPermissions();

    const comment = await createComment("opencode started...");
    commentId = comment.data.id;

    const promptData = isPR
      ? await fetchPromptDataForPR()
      : await fetchPromptDataForIssue();

    if (isPR) await checkoutPR();

    const response = await runOpencode(`${userPrompt}\n\n${promptData}`);

    if (await branchIsDirty()) {
      const summary =
        (await runOpencode(
          `Summary the following in less than 40 characters:\n\n${response}`
        )) || `Fix issue: ${payload.issue.title}`;
      if (isPR) {
        await pushToCurrentBranch(summary);
        await updateComment(response);
      } else {
        const branch = await pushToNewBranch(summary);
        const pr = await createPR(
          branch,
          summary,
          `${response}\n\nCloses #${issueId}`
        );
        await updateComment(`opencode created pull request #${pr}`);
      }
    } else {
      await updateComment(response);
    }
  } catch (e: any) {
    console.error(e);
    let msg = e;
    if (e instanceof $.ShellError) {
      msg = e.stderr.toString();
    } else if (e instanceof Error) {
      msg = e.message;
    }
    if (commentId) await updateComment(msg);
    core.setFailed(`opencode failed with error: ${msg}`);
    // Also output the clean error message for the action to capture
    //core.setOutput("prepare_error", e.message);
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}

async function generateGitHubToken() {
  try {
    return await core.getIDToken("opencode-github-action");
  } catch (error) {
    console.error("Failed to get OIDC token:", error);
    throw new Error(
      "Could not fetch an OIDC token. Make sure to add `id-token: write` to your workflow permissions."
    );
  }
}

async function exchangeForAppToken(oidcToken: string) {
  const response = await fetch(
    "https://api.frank.dev.opencode.ai/exchange_github_app_token",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${oidcToken}`,
      },
    }
  );

  if (!response.ok) {
    const responseJson = (await response.json()) as { error?: string };
    throw new Error(
      `App token exchange failed: ${response.status} ${response.statusText} - ${responseJson.error}`
    );
  }

  const responseJson = (await response.json()) as { token: string };
  return responseJson.token;
}

async function assertPermissions() {
  console.log(`Asserting permissions for user ${actor}...`);

  let permission;
  try {
    const response = await octoRest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username: actor,
    });

    permission = response.data.permission;
    console.log(`  permission: ${permission}`);
  } catch (error) {
    console.error(`Failed to check permissions: ${error}`);
    throw new Error(`Failed to check permissions for user ${actor}: ${error}`);
  }

  if (!["admin", "write"].includes(permission))
    throw new Error(`User ${actor} does not have write permissions`);
}

function buildComment(content: string, opts?: { share?: string }) {
  const runId = process.env.GITHUB_RUN_ID!;
  const runLink = `/${owner}/${repo}/actions/runs/${runId}`;
  return [
    content,
    "",
    opts?.share ? `[shared session](${opts?.share}) | ` : "",
    `[view run](${runLink})`,
  ].join("\n");
}

async function createComment(body: string) {
  console.log("Creatinig comment...");
  return await octoRest.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueId,
    body: buildComment(body),
  });
}

async function updateComment(body: string) {
  console.log("Updating comment...");
  return await octoRest.rest.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body: buildComment(body),
  });
}

async function checkoutPR() {
  console.log("Checking out PR...");

  //  //const prData = githubData.contextData as GitHubPullRequest;
  //  const prState = payload.issue.pull_request.state;
  //  const branchName = prData.headRefName;
  const branchName = github.context.ref;
  //
  //  // Determine optimal fetch depth based on PR commit count, with a minimum of 20
  //  const commitCount = prData.commits.totalCount;
  //  const fetchDepth = Math.max(commitCount, 20);
  //
  //  console.log(
  //    `PR #${entityNumber}: ${commitCount} commits, using fetch depth ${fetchDepth}`,
  //  );

  // Execute git commands to checkout PR branch (dynamic depth based on PR size)
  await $`git fetch origin --depth=1 ${branchName}`;
  await $`git checkout ${branchName}`;

  await $`git add .`;
  await $`git commit -m "${summary}"`;
  await $`git push`;
}

async function pushToCurrentBranch(summary: string) {
  console.log("Pushing to current branch...");
  await $`git config --global user.email "runner@opencode.ai"`;
  await $`git config --global user.name "opencode"`;
  await $`git add .`;
  await $`git commit -m "${summary}"`;
  await $`git push`;
}

async function pushToNewBranch(summary: string) {
  console.log("Pushing to new branch...");
  const timestamp = new Date()
    .toISOString()
    .replace(/[:-]/g, "")
    .replace(/\.\d{3}Z/, "")
    .split("T")
    .join("_");
  const branch = `opencode/${isPR ? "pr" : "issue"}${issueId}-${timestamp}`;
  await $`git checkout -b ${branch}`;
  await $`git config --global user.email "runner@opencode.ai"`;
  await $`git config --global user.name "opencode"`;
  await $`git add .`;
  await $`git commit -m "${summary}"`;
  await $`git push -u origin ${branch}`;
  return branch;
}

async function createPR(branch: string, title: string, body: string) {
  console.log("Creating pull request...");
  const repoData = await octoRest.rest.repos.get({ owner, repo });
  const pr = await octoRest.rest.pulls.create({
    owner,
    repo,
    head: branch,
    base: repoData.data.default_branch,
    title,
    body: buildComment(body),
  });
  return pr.data.number;
}

async function runOpencode(prompt: string) {
  console.log("Running opencode...");
  const promptPath = path.join(os.tmpdir(), "PROMPT");
  await Bun.write(promptPath, prompt);
  const ret =
    await $`cat ${promptPath} | opencode run -m ${process.env.INPUT_MODEL} --print-logs`;
  return ret.stdout.toString().trim();
}

async function branchIsDirty() {
  console.log("Checking if branch is dirty...");
  const ret = await $`git status --porcelain`;
  return ret.stdout.toString().trim().length > 0;
}

async function fetchPromptDataForIssue() {
  console.log("Fetching prompt data for issue...");
  const issueResult = await octoGraph<IssueQueryResponse>(
    `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      title
      body
      author {
        login
      }
      createdAt
      state
      comments(first: 100) {
        nodes {
          id
          databaseId
          body
          author {
            login
          }
          createdAt
        }
      }
    }
  }
}`,
    {
      owner,
      repo,
      number: issueId,
    }
  );

  const issue = issueResult.repository.issue;
  if (!issue) throw new Error(`Issue #${issueId} not found`);

  const comments = (issue.comments?.nodes || [])
    .filter((c) => {
      const id = parseInt(c.databaseId);
      return id !== commentId && id !== payload.comment.id;
    })
    .map((c) => `  - ${c.author.login} at ${c.createdAt}: ${c.body}`);

  return [
    "Here is the context for the issue:",
    `- Title: ${issue.title}`,
    `- Body: ${issue.body}`,
    `- Author: ${issue.author.login}`,
    `- Created At: ${issue.createdAt}`,
    `- State: ${issue.state}`,
    ...(comments.length > 0 ? ["- Comments:", ...comments] : []),
  ].join("\n");
}

async function fetchPromptDataForPR() {
  console.log("Fetching prompt data for PR...");
  const prResult = await octoGraph<PullRequestQueryResponse>(
    `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      title
      body
      author {
        login
      }
      baseRefName
      headRefName
      headRefOid
      createdAt
      additions
      deletions
      state
      commits(first: 100) {
        totalCount
        nodes {
          commit {
            oid
            message
            author {
              name
              email
            }
          }
        }
      }
      files(first: 100) {
        nodes {
          path
          additions
          deletions
          changeType
        }
      }
      comments(first: 100) {
        nodes {
          id
          databaseId
          body
          author {
            login
          }
          createdAt
        }
      }
      reviews(first: 100) {
        nodes {
          id
          databaseId
          author {
            login
          }
          body
          state
          submittedAt
          comments(first: 100) {
            nodes {
              id
              databaseId
              body
              path
              line
              author {
                login
              }
              createdAt
            }
          }
        }
      }
    }
  }
}`,
    {
      owner,
      repo,
      number: issueId,
    }
  );

  const pr = prResult.repository.pullRequest;
  if (!pr) throw new Error(`PR #${issueId} not found`);

  const comments = (pr.comments?.nodes || [])
    .filter((c) => {
      const id = parseInt(c.databaseId);
      return id !== commentId && id !== payload.comment.id;
    })
    .map((c) => `  - ${c.author.login} at ${c.createdAt}: ${c.body}`);

  const files = (pr.files.nodes || []).map(
    (f) => `  - ${f.path} (${f.changeType}) +${f.additions}/-${f.deletions}`
  );
  const reviewData = (pr.reviews.nodes || []).map((r) => {
    const comments = (r.comments.nodes || []).map(
      (c) => `      - ${c.path}:${c.line ?? "?"}: ${c.body}`
    );
    return [
      `  - ${r.author.login} at ${r.submittedAt}:`,
      `    - Review body: ${r.body}`,
      ...(comments.length > 0 ? ["    - Comments:", ...comments] : []),
    ];
  });

  return [
    "Here is the context for the pull request:",
    `- Title: ${pr.title}`,
    `- Body: ${pr.body}`,
    `- Author: ${pr.author.login}`,
    `- Created At: ${pr.createdAt}`,
    `- Base Branch: ${pr.baseRefName}`,
    `- Head Branch: ${pr.headRefName}`,
    `- State: ${pr.state}`,
    `- Additions: ${pr.additions}`,
    `- Deletions: ${pr.deletions}`,
    `- Total Commits: ${pr.commits.totalCount}`,
    `- Changed Files: ${pr.files.nodes.length} files`,
    ...(comments.length > 0 ? ["- Comments:", ...comments] : []),
    ...(files.length > 0 ? ["- Changed files:", ...files] : []),
    ...(reviewData.length > 0 ? ["- Reviews:", ...reviewData] : []),
  ].join("\n");
}
