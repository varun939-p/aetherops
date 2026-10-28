import { execFile } from "node:child_process";

/** Thin, injection-safe git wrapper: arguments are always passed as an array, never through a shell. */

interface GitResult {
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[], timeoutMs = 15_000): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

export async function gitInfo(cwd: string): Promise<{ isRepo: boolean; branch: string | null }> {
  try {
    const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.stdout !== "true") return { isRepo: false, branch: null };
    const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ({ stdout: "" }));
    return { isRepo: true, branch: branch.stdout || null };
  } catch {
    return { isRepo: false, branch: null };
  }
}

export interface CommitMessageInput {
  path: string;
  ruleIds: string[];
  issuesFixed: number;
  engine: string;
  model: string | null;
  previousHash: string;
  newHash: string;
}

export function buildCommitMessage(input: CommitMessageInput): string {
  const rules = [...new Set(input.ruleIds)].sort();
  return [
    `fix(aetherops): remediate ${input.issuesFixed} issue${input.issuesFixed === 1 ? "" : "s"} in ${input.path}`,
    "",
    `Rules: ${rules.length ? rules.join(", ") : "n/a"}`,
    `Engine: ${input.engine}${input.model ? ` (${input.model})` : ""}`,
    `Base-SHA256: ${input.previousHash}`,
    `New-SHA256: ${input.newHash}`,
  ].join("\n");
}

/**
 * Stages and commits exactly one path. `git commit -- <path>` commits only that path, so anything
 * else the user has staged is left untouched.
 */
export async function commitFile(cwd: string, relPath: string, message: string): Promise<string> {
  await git(cwd, ["add", "--", relPath]);
  // The repository's own hooks run; a rejecting hook surfaces as a commit error to the caller.
  await git(cwd, ["commit", "-m", message, "--", relPath], 60_000);
  return (await git(cwd, ["rev-parse", "HEAD"])).stdout;
}
