#!/usr/bin/env bun

import { $ } from "bun";
import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import * as core from "@actions/core";
import * as github from "@actions/github";
import type { IssueCommentEvent } from "@octokit/webhooks-types";
import type { IssueQueryResponse } from "./types";

const octoRest = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});
const octoGraph = graphql.defaults({
  //baseUrl: GITHUB_API_URL,
  headers: {
    authorization: `token ${process.env.GITHUB_TOKEN}`,
  },
});

async function run() {
  try {
    const context = github.context;
    const actor = context.actor;

    if (github.context.eventName !== "issue_comment")
      throw new Error(`Unsupported event type: ${context.eventName}`);

    const payload = github.context.payload as IssueCommentEvent;
    const body = payload.comment.body;
    const isPR = payload.issue.pull_request;

    const match = body.match(/^hey\s*opencode,?\s*(.*)$/);
    if (!match?.[1]) throw new Error("Command must start with `hey opencode`");
    const prompt = match[1];

    console.log({ prompt, isPR });

    const comment = await createComment();
    console.log({ comment });

    const promptData = await fetchPromptData();
    console.log({ promptData });

    const response = await runOpencode();
    console.log({ response });

    if (await branchIsDirty()) {
      console.log("!@#!@#!@# Branch is DIRTY");
      if (isPR) {
        //    commitToCurrentBranch();
        //    pushToCurrentBranch();
        //    updateComment(SUMMARY);
      } else {
        //    createNewBranch();
        //    commitToNewBranch();
        //    pushToNewBranch();
        //    createPR(SUMMARY);
        //    updateComment("pr created");
      }
    } else {
      console.log("!@#!@#!@# Branch is CLEAN");
      await updateComment(response);
    }

    async function createComment() {
      const { owner, repo } = context.repo;
      const issueId = payload.issue.number;
      const runId = process.env.GITHUB_RUN_ID!;
      return await octoRest.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueId,
        body: [
          "opencode started...",
          "",
          `[view run](${`/${owner}/${repo}/actions/runs/${runId}`})`,
        ].join("\n"),
      });
    }

    async function updateComment(content: string) {
      const { owner, repo } = context.repo;
      const runId = process.env.GITHUB_RUN_ID!;
      return await octoRest.rest.issues.updateComment({
        owner,
        repo,
        comment_id: comment.data.id,
        body: [
          content,
          "",
          `[view run](${`/${owner}/${repo}/actions/runs/${runId}`})`,
        ].join("\n"),
      });
    }

    async function fetchPromptData() {
      const { owner, repo } = context.repo;
      const issueId = payload.issue.number;
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

      const comments = issue.comments?.nodes || [];
      const commentsContext = comments
        .filter((c) => {
          const id = parseInt(c.databaseId);
          return id !== comment.data.id && id !== payload.comment.id;
        })
        .map((c) => `- ${c.author.login} at ${c.createdAt}: ${c.body}`);

      return [
        "",
        "Here is the context for the issue:",
        `- Title: ${issue.title}`,
        `- Body: ${issue.body}`,
        `- Author: ${issue.author.login}`,
        `- Created At: ${issue.createdAt}`,
        `- State: ${issue.state}`,
        "",
        "Here is the list of comments:",
        ...(commentsContext.length > 0 ? commentsContext : ["No comments"]),
      ].join("\n");
    }

    async function runOpencode() {
      const ret =
        await $`opencode run ${prompt} ${promptData} -m ${process.env.INPUT_MODEL}`;
      return ret.stdout.toString().trim();
    }

    async function branchIsDirty() {
      const ret = await $`git status --porcelain`;
      return ret.stdout.toString().trim().length > 0;
    }
  } catch (e: any) {
    core.setFailed(`Prepare step failed with error: ${e.message}`);
    // Also output the clean error message for the action to capture
    //core.setOutput("prepare_error", e.message);
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
