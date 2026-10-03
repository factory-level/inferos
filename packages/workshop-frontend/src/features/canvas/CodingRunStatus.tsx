import { Badge } from '@cloudflare/kumo'
import type { Repo, Run } from '@inferos/gatekeeper-inferops/src/types'
import { RUN_PHASES, blockedReasonText, formatDuration, runPhase } from './codingRuns'

/** A run's state as a badge, with a second one while a cancel of it awaits approval. For the issue's card. */
export const CodingRunBadge = ({ run }: { run: Run }) => {
  const phase = RUN_PHASES[runPhase(run)]
  return <span className="flex flex-wrap gap-1" data-run-phase={runPhase(run)}>
    <Badge variant={phase.variant}>{phase.label}</Badge>
    {run.pending === 'cancel' && <Badge variant="warning">Cancel awaiting approval</Badge>}
  </span>
}

const Path = ({ path }: { path: string }) => <code className="font-mono text-xs [overflow-wrap:anywhere]">{path}</code>

/**
 * Everything a run reported: where it stands, why it stopped, and once finished the patch it left,
 * the test commands the runner itself ran with their artifacts, and the runner's own summary,
 * which is not evidence. Paths are on the machine that ran it.
 */
export const CodingRunDetails = ({ run, repo }: { run: Run; repo: Repo | undefined }) => {
  const phase = runPhase(run)
  const { result } = run
  const blocked = phase === 'blocked' ? blockedReasonText(result?.reasonCode) : null
  return <section aria-label="Latest coding run" className="space-y-2 rounded-md border border-kumo-line p-3 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <CodingRunBadge run={run} />
      <span className="text-xs text-kumo-subtle">
        {repo ? repo.slug : 'Repository'}{run.baseRef ? ` from ${run.baseRef}` : repo ? ` from ${repo.defaultBaseRef}` : ''}
      </span>
    </div>
    {phase === 'queued' && <p className="text-kumo-subtle">Waiting for the local runner to claim it.</p>}
    {phase === 'unknown' && <p className="text-kumo-subtle">It was stopped while running, so its work may be partly done. InferOps holds the issue for a person to recover.</p>}
    {blocked && <p className="text-kumo-danger">{blocked}</p>}
    {run.error && phase !== 'blocked' && <p className="text-kumo-danger [overflow-wrap:anywhere]">{run.error}</p>}
    {result?.patch && <p>
      Patch <Path path={result.patch.path} />: {result.patch.files} {result.patch.files === 1 ? 'file' : 'files'},{' '}
      <span aria-label={`${result.patch.insertions} lines added`}>+{result.patch.insertions}</span>{' '}
      <span aria-label={`${result.patch.deletions} lines removed`}>−{result.patch.deletions}</span>
    </p>}
    {result?.tests && <div className="space-y-1">
      <p>Tests the runner ran: {result.tests.passed} passed, {result.tests.failed} failed. Artifacts in <Path path={result.tests.directory} /></p>
      {result.tests.commands.length > 0 && <ul aria-label="Test commands" className="space-y-1 text-xs">
        {result.tests.commands.map(command => <li key={command.index} className="space-y-0.5">
          <p>
            <Badge variant={command.exitCode === 0 ? 'success' : 'error'}>{command.exitCode === 0 ? 'Passed' : 'Failed'}</Badge>{' '}
            <code className="font-mono">{command.argv.join(' ')}</code>{' '}
            <span className="text-kumo-subtle">
              {command.timedOut ? 'timed out' : command.exitCode === null ? 'did not start' : `exit ${command.exitCode}`}, {formatDuration(command.durationMs)}
              {command.truncated ? ', output truncated to its tail' : ''}
            </span>
          </p>
          <p className="text-kumo-subtle">
            Output <Path path={command.artifacts.stdout} />, errors <Path path={command.artifacts.stderr} />, record <Path path={command.artifacts.record} />
          </p>
        </li>)}
      </ul>}
    </div>}
    {result?.testSummary && !result.tests && <p>Tests: {result.testSummary}</p>}
    {result && <p className="text-kumo-subtle [overflow-wrap:anywhere]">Runner's summary (its own account, not evidence): {result.summary}</p>}
    {result?.prUrl && <p>Pull request <Path path={result.prUrl} /></p>}
  </section>
}
