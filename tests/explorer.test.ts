import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RepositoryExplorer } from "@/components/RepositoryExplorer";
import type { FileSummaryDto } from "@/lib/contracts";

const noop = () => {};

function render(props: { files: FileSummaryDto[] | undefined; error?: string | null }): string {
  return renderToStaticMarkup(
    createElement(RepositoryExplorer, {
      files: props.files,
      error: props.error ?? null,
      loading: false,
      selectedId: null,
      onSelect: noop,
      onAnalyze: noop,
      onDelete: noop,
      onRetry: noop,
    })
  );
}

test("a failed file-list request is shown as an error with a retry, not as an empty project", () => {
  const html = render({ files: undefined, error: "Workspace 1 not found" });
  assert.match(html, /Workspace 1 not found/);
  assert.match(html, /Try again/);
  assert.doesNotMatch(html, /No files yet/);
});

test("an empty list whose refresh failed shows the error, not the empty state", () => {
  const html = render({ files: [], error: "Workspace 7 not found" });
  assert.match(html, /Workspace 7 not found/);
  assert.doesNotMatch(html, /No files yet/);
});

test("a project that really has no files still shows the empty state", () => {
  const html = render({ files: [] });
  assert.match(html, /No files yet/);
  assert.doesNotMatch(html, /Try again/);
});
