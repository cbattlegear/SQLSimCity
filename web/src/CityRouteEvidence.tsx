import { useEffect, useState } from 'react'
import type { PlanChoice } from './cityPlanSearch'
import type { CitySourceMode } from './cityEvidence'
import { exactCount, queryRouteEvidence } from './cityQueryEvidence'

export function CityRouteEvidence({ choice, now, sourceMode }: { choice: PlanChoice; now: number; sourceMode: CitySourceMode }) {
  const [expiredAt, setExpiredAt] = useState(0)
  const evidence = choice.cityFamily?.evidence ?? choice.family?.evidence
  const deadline = evidence?.freshUntil
  const isStatic = sourceMode !== 'live' || evidence?.source === 'Fixture' || evidence?.source === 'ImportedArchive'
  useEffect(() => {
    if (isStatic || !deadline) return
    const remaining = Date.parse(deadline) - Date.now()
    if (!Number.isFinite(remaining) || remaining <= 0) return
    const timer = window.setTimeout(() => setExpiredAt(Date.now()), Math.min(2_147_483_647, remaining))
    return () => window.clearTimeout(timer)
  }, [deadline, isStatic, expiredAt])
  const facts = queryRouteEvidence(choice, Math.max(now, expiredAt, Date.now()), sourceMode)
  return (
    <section className="route-evidence" aria-label="Query measurement and SQL text">
      <h2>Query evidence</h2>
      <p>{facts.source} · {facts.status}{facts.staticSource ? ' · static captured evidence' : ''}</p>
      <dl>
        <div><dt>Family</dt><dd>{choice.familyId ?? 'Not yet located'}</dd></div>
        <div><dt>Observed</dt><dd>{facts.observed}</dd></div>
        <div><dt>Window</dt><dd>{facts.window}</dd></div>
        <div><dt>Executions</dt><dd>{exactCount(facts.executions)}</dd></div>
        <div><dt>Wait (ms)</dt><dd>{exactCount(facts.waits)}</dd></div>
        <div><dt>Object confidence</dt><dd>{facts.confidence}</dd></div>
      </dl>
      <p className="hud-note">{facts.coverage} {facts.rationale}</p>
      <details className="route-sql" open={!!choice.text && choice.text.length < 1_000}>
        <summary>SQL text{choice.text ? ` (${choice.text.length.toLocaleString()} characters)` : ' unavailable'}</summary>
        {choice.text ? <pre>{choice.text}</pre> : <p>{choice.textReason || 'The source did not retain readable SQL text.'}</p>}
      </details>
      <p className="hud-note">
        Executions and waits are measured for the query family, not for individual operators or this
        one compiled plan. Cost shares and the route below are estimates, never actual operator time.
      </p>
      {facts.attribution
        ? <p className="hud-note">
          {exactCount(facts.attribution.unattributedWaitMilliseconds)} ms remain unattributed to buildings.
          {' '}{facts.attribution.rationale}
        </p>
        : <p className="hud-note">No per-object wait allocation was published for this window. No building is claimed to own the unplaced waiting.</p>}
    </section>
  )
}
