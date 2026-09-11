import { NavLink, useLocation } from 'react-router-dom';
import { PHASES, phaseForPath } from './phases.js';

/**
 * Phase rail — threads the existing pages into the five-phase engagement cycle
 * (Recon → Plan → Execute → Measure → Report) and marks the current phase, so
 * the whole assessment reads as one governed loop. See docs/five-phase-model.md.
 */
export function PhaseRail() {
  const { pathname, search } = useLocation();
  const active = phaseForPath(pathname, search);
  return (
    <nav className="phase-rail" aria-label="Engagement phases">
      {PHASES.map((p, i) => (
        <NavLink
          key={p.id}
          to={p.route}
          title={p.what}
          className={`phase-step${active?.id === p.id ? ' active' : ''}`}
        >
          <span className="phase-n">{p.n}</span>
          <span className="phase-name">{p.name}</span>
          {i < PHASES.length - 1 && (
            <span className="phase-arrow" aria-hidden="true">
              →
            </span>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
