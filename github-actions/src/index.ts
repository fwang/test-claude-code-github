#!/usr/bin/env bun

import { $ } from "bun";
import * as core from "@actions/core";
import * as github from "@actions/github";
import type { IssueCommentEvent } from "@octokit/webhooks-types";

async function run() {
  try {
    const runId = process.env.GITHUB_RUN_ID!;
    const context = github.context;
    const actor = context.actor;

    if (github.context.eventName !== "issue_comment")
      throw new Error(`Unsupported event type: ${context.eventName}`);

    const payload = github.context.payload as IssueCommentEvent;
    const body = payload.comment.body;
    const issueId = payload.issue.number;
    const isPR = payload.issue.pull_request;

    const match = body.match(/^hey\s*opencode,?\s*(.*)$/);
    if (!match) throw new Error("Command must start with `hey opencode`");

    console.log({ prompt: match[1], issueId, isPR });

    const commentRet =
      await $`gh issue comment ${issueId} --body "opencode started..."`;

    console.log({ commentRet });

    const opencodeRet =
      await $`opencode run ${match[1]} -m ${process.env.INPUT_MODEL}`;
    console.log({ opencodeRet });

    //if (branchIsDirty()) {
    //  if (isPR) {
    //    commitToCurrentBranch();
    //    pushToCurrentBranch();
    //    updateComment(SUMMARY);
    //  } else {
    //    createNewBranch();
    //    commitToNewBranch();
    //    pushToNewBranch();
    //    createPR(SUMMARY);
    //    updateComment("pr created");
    //  }
    //} else {
    //  updateComment(SUMMARY);
    //}

    //    // Step 1: Setup GitHub token
    //    const githubToken = await setupGitHubToken();
    //    const octokit = createOctokit(githubToken);

    // Step 2: Parse GitHub context (once for all operations)
    //const context = parseContext();

    //    // Step 3: Check write permissions
    //    const hasWritePermissions = await checkWritePermissions(
    //      octokit.rest,
    //      context
    //    );
    //    if (!hasWritePermissions) {
    //      throw new Error(
    //        "Actor does not have write permissions to the repository"
    //      );
    //    }
    //
    //    // Step 4: Check trigger conditions
    //    const containsTrigger = await checkTriggerAction(context);
    //
    //    if (!containsTrigger) {
    //      console.log("No trigger found, skipping remaining steps");
    //      return;
    //    }
    //
    //    // Step 5: Check if actor is human
    //    await checkHumanActor(octokit.rest, context);
    //
    //    // Step 6: Create initial tracking comment
    //    const commentId = await createInitialComment(octokit.rest, context);
    //
    //    // Step 7: Fetch GitHub data (once for both branch setup and prompt creation)
    //    const githubData = await fetchGitHubData({
    //      octokits: octokit,
    //      repository: `${context.repository.owner}/${context.repository.repo}`,
    //      prNumber: context.entityNumber.toString(),
    //      isPR: context.isPR,
    //      triggerUsername: context.actor,
    //    });
    //
    //    // Step 8: Setup branch
    //    const branchInfo = await setupBranch(octokit, githubData, context);
    //
    //    // Step 9: Update initial comment with branch link (only for issues that created a new branch)
    //    if (branchInfo.claudeBranch) {
    //      await updateTrackingComment(
    //        octokit,
    //        context,
    //        commentId,
    //        branchInfo.claudeBranch
    //      );
    //    }
    //
    //    // Step 10: Create prompt file
    //    await createPrompt(
    //      commentId,
    //      branchInfo.baseBranch,
    //      branchInfo.claudeBranch,
    //      githubData,
    //      context
    //    );
  } catch (e) {
    core.setFailed(`Prepare step failed with error: ${e.message}`);
    // Also output the clean error message for the action to capture
    //core.setOutput("prepare_error", e.message);
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
