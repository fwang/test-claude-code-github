#!/usr/bin/env bun

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

const octoRest = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});
const octoGraph = graphql.defaults({
  headers: {
    authorization: `token ${process.env.GITHUB_TOKEN}`,
  },
});
const { owner, repo } = github.context.repo;
const payload = github.context.payload as IssueCommentEvent;
const issueId = payload.issue.number;
const body = payload.comment.body;
const isPR = payload.issue.pull_request;

let commentId: number;

async function run() {
  try {
    const match = body.match(/^hey\s*opencode,?\s*(.*)$/);
    if (!match?.[1]) throw new Error("Command must start with `hey opencode`");
    const userPrompt = match[1];

    console.log({ prompt: userPrompt, isPR });

    const comment = await createComment(buildComment("opencode started..."));
    commentId = comment.data.id;
    console.log({ comment });

    const promptData = isPR
      ? await fetchPromptDataForPR()
      : await fetchPromptDataForIssue();

    const response = await runOpencode(`${userPrompt}\n\n${promptData}`);
    console.log({ response });

    if (await branchIsDirty()) {
      const summary = await runOpencode(
        "Describe the changes in less than 40 characters.",
        { continue: true }
      );
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
    let msg = e;
    if (e instanceof $.ShellError) {
      // TODO
      console.error("!@#! STDOUT", e.stdout.toString());
      console.error("!@#! STDERR", e.stderr.toString());
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
  return await octoRest.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueId,
    body,
  });
}

async function updateComment(body: string) {
  return await octoRest.rest.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body: buildComment(body),
  });
}

async function pushToCurrentBranch(summary: string) {
  await $`git config --global user.email "runner@opencode.ai"`;
  await $`git config --global user.name "opencode"`;
  await $`git add .`;
  await $`git commit -m "${summary}"`;
  await $`git push`;
}

async function pushToNewBranch(summary: string) {
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

async function runOpencode(prompt: string, opts?: { continue?: boolean }) {
  const ret = opts?.continue
    ? await $`opencode run ${prompt} -m ${process.env.INPUT_MODEL} --continue`
    : await $`opencode run ${prompt} -m ${process.env.INPUT_MODEL}`;

  return ret.stdout.toString().trim();
}

async function branchIsDirty() {
  const ret = await $`git status --porcelain`;
  return ret.stdout.toString().trim().length > 0;
}

async function fetchPromptDataForIssue() {
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
