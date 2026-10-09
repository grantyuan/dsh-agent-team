// Real module behind the member-prompt spec's usage/auto-prune rows: two
// static sections per team-member scope, one naming a registered content tool
// (whole-word, so sectionToolMapping maps it) plus an unregistered name, and
// one naming nothing. rc.1 preset health resolves the row from disk, so the
// row points at this file: URL beside the spec.
export const name = 'usage-section-fixture'
export const inject = ['systemPrompt']

export function apply(scope) {
  scope.systemPrompt.section({
    name: 'usage:mapped',
    order: 5010,
    text: 'Prefer ordinary_tool for ordinary work; never_tool is never available.',
  })
  scope.systemPrompt.section({
    name: 'usage:prose',
    order: 5011,
    text: 'This paragraph names no registered tool at all.',
  })
}
