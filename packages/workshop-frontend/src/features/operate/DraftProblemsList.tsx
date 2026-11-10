import { Button } from '@cloudflare/kumo'
import type { ConsoleDraftProblem } from '@gadgets/workshop-shared/operate-console'

/**
 * What would stop a draft publishing (FAC-96), as `validateConsoleDraft` reports it: each problem
 * in publication's words, with the target it is about and its repair. Checking again reads the
 * draft as it is now. An empty list says nothing stops it; a failed check is an alert, never empty.
 */
export const DraftProblemsList = ({ problems, onCheck }: { problems: ConsoleDraftProblem[] | { error: string } | null; onCheck: () => void }) =>
  <section aria-label="What would stop publishing" className="space-y-2">
    <div className="flex items-center gap-2">
      <p className="text-sm font-medium text-kumo-default">Before publishing</p>
      <Button size="sm" variant="ghost" onClick={onCheck}>Check again</Button>
    </div>
    {problems === null && <p aria-busy="true" className="text-sm text-kumo-subtle">Checking the draft…</p>}
    {problems && 'error' in problems && <p role="alert" className="text-sm text-kumo-danger">Couldn’t check the draft: {problems.error}</p>}
    {Array.isArray(problems) && problems.length === 0 && <p className="text-sm text-kumo-subtle">Nothing stops this draft publishing.</p>}
    {Array.isArray(problems) && problems.length > 0 && <ul className="space-y-2">
      {problems.map((problem, index) => <li key={`${problem.target}:${index}`} className="space-y-1 rounded-lg border border-kumo-line p-3 text-sm">
        <p className="text-kumo-danger">{problem.message}</p>
        <p className="text-xs text-kumo-subtle">In <code>{problem.target}</code></p>
        <p className="text-kumo-default">Fix: {problem.repair}</p>
      </li>)}
    </ul>}
  </section>
