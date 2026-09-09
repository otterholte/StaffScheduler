"""
Background schedule generation.

Solving can take several seconds, so `/api/generate` no longer blocks the
request. Instead it:

1. creates a `ScheduleJob` row,
2. starts a daemon thread that runs the solver and streams progress into
   that row (throttled to a few writes per second), and
3. returns the job id so the browser can poll `/api/schedule/job/<id>`.

Because the job lives in the database, any Gunicorn worker can answer the
poll, and a browser refresh mid-solve can pick the result up afterwards.
"""

import copy
import json
import threading
import time
import traceback
import uuid
from datetime import date
from typing import Dict, List, Optional, Set, Tuple

from flask import Flask

from models import db, ScheduleJob
from scheduler.models import BusinessScenario
from scheduler.solver import AdvancedScheduleSolver
from services.common import as_int
import db_service

# Time budgets. The solver usually stops itself far earlier (see solver.py).
TIME_LIMIT_SECONDS = 25.0
STALL_SECONDS = 3.0
MAX_HISTORY = 6

# Demo businesses are not persisted, so their alternatives history lives here.
_demo_history: Dict[Tuple[str, str], List[Set[Tuple[str, int, int]]]] = {}


def policies_to_solver_kwargs(policies: Optional[dict]) -> dict:
    """Translate the UI's policy names into solver constructor arguments."""
    p = policies or {}

    def mode(value, default='required'):
        return value if value in ('off', 'preferred', 'required') else default

    def strategy(value):
        return value if value in ('minimize', 'balanced', 'maximize') else 'balanced'

    def flag(value, default=True):
        if isinstance(value, bool):
            return value
        if value in ('off', 'false', 'False', 0, '0', None):
            return default if value is None else False
        return True

    return {
        'min_shift_hours': as_int(p.get('min_shift_length'), 2),
        'max_hours_per_day': as_int(p.get('max_hours_per_day'), 8),
        'max_shift_hours': as_int(p.get('max_shift_length'), 0) or None,
        'max_splits_per_day': as_int(p.get('max_splits'), 2),
        'max_split_shifts_per_week': as_int(p.get('max_split_shifts_per_week'), 1),
        'scheduling_strategy': strategy(p.get('scheduling_strategy')),
        'max_days_ft': as_int(p.get('max_days_ft'), 5),
        'max_days_ft_mode': mode(p.get('max_days_ft_mode')),
        'max_days_pt': as_int(p.get('max_days_pt'), 4),
        'max_days_pt_mode': mode(p.get('max_days_pt_mode')),
        'min_rest_hours': as_int(p.get('min_rest_hours'), 10),
        'max_consecutive_days': as_int(p.get('max_consecutive_days'), 6),
        'supervision_required': flag(p.get('supervision_required'), True),
        'weekend_fairness': flag(p.get('weekend_fairness'), True),
        'avoid_overtime': flag(p.get('avoid_overtime'), True),
    }


def _history_key(business_id: str, week_start: date) -> Tuple[str, str]:
    return (business_id, week_start.isoformat())


def get_history(scenario: BusinessScenario, week_start: date, is_demo: bool) -> List[Set[Tuple[str, int, int]]]:
    if is_demo:
        return list(_demo_history.get(_history_key(scenario.id, week_start), []))
    return db_service.get_schedule_history(scenario.id, week_start)


def clear_history(business_id: str, week_start: date, is_demo: bool):
    """Called by /api/reset so the next 'alternative' starts fresh."""
    if is_demo:
        _demo_history.pop(_history_key(business_id, week_start), None)
        return
    rec = db_service.get_schedule_record(business_id, week_start)
    if rec:
        data = rec.get_schedule_data()
        if 'alternatives_history' in data:
            data.pop('alternatives_history', None)
            rec.set_schedule_data(data)
            db.session.commit()


def _serialize_history(sets: List[Set[Tuple[str, int, int]]]) -> List[List[str]]:
    return [[f"{e}|{d}|{h}" for (e, d, h) in sorted(s)] for s in sets[-MAX_HISTORY:]]


def start_job(app: Flask, scenario: BusinessScenario, owner_id: Optional[int], week_start: date,
              policies: Optional[dict], kind: str, is_demo: bool) -> str:
    """Create the job row and kick off the solver thread. Returns the job id."""
    job_id = str(uuid.uuid4())
    job = ScheduleJob(
        id=job_id, business_id=scenario.id, owner_id=owner_id, week_start=week_start,
        kind=kind, status='queued', message='Queued...', progress_json='{}',
    )
    db.session.add(job)
    db.session.commit()

    history = get_history(scenario, week_start, is_demo) if kind == 'alternative' else []
    # The solver works on its own copy so nothing it does can leak into the request
    working = copy.deepcopy(scenario)

    thread = threading.Thread(
        target=_run_job,
        args=(app, job_id, working, week_start, policies, kind, history, is_demo),
        daemon=True,
        name=f"schedule-job-{job_id[:8]}",
    )
    thread.start()
    return job_id


def _run_job(app: Flask, job_id: str, scenario: BusinessScenario, week_start: date,
             policies: Optional[dict], kind: str, history, is_demo: bool):
    """Thread body: solve, persist, and record the outcome on the job row."""
    with app.app_context():
        last_write = [0.0]
        write_lock = threading.Lock()

        def update(status: Optional[str] = None, message: Optional[str] = None,
                   progress: Optional[dict] = None, force: bool = False):
            """Write progress to the job row.

            CP-SAT invokes the solution callback from its own worker threads,
            which have no Flask app context, so every update opens its own
            context and uses a short-lived session.
            """
            now = time.time()
            if not force and now - last_write[0] < 0.4:
                return
            with write_lock:
                last_write[0] = now
                with app.app_context():
                    try:
                        job = ScheduleJob.query.get(job_id)
                        if not job:
                            return
                        if status:
                            job.status = status
                        if message:
                            job.message = message
                        if progress is not None:
                            job.progress_json = json.dumps(progress)
                        db.session.commit()
                    except Exception:
                        db.session.rollback()
                    finally:
                        db.session.remove()

        def on_progress(event: dict):
            phase = event.get('phase')
            if phase == 'improving':
                unfilled = event.get('unfilled_slots', 0)
                n = event.get('solutions', 0)
                if unfilled == 0:
                    msg = f"Full coverage found. Polishing shifts, fairness, and preferences... ({n} candidate schedules)"
                else:
                    msg = f"Found a schedule with {unfilled} uncovered hour(s). Searching for better... ({n} candidates)"
                update(message=msg, progress={
                    'solutions': n, 'unfilled_slots': unfilled,
                    'elapsed': round(event.get('elapsed', 0), 1),
                })
            elif phase in ('building', 'solving', 'done'):
                update(message=event.get('message'), force=True)

        try:
            update(status='running', message='Analyzing staff, roles, and coverage needs...', force=True)
            kwargs = policies_to_solver_kwargs(policies)
            solver = AdvancedScheduleSolver(scenario, progress_callback=on_progress, **kwargs)
            if kind == 'alternative' and history:
                solver._previous_solutions = list(history)

            # Bigger teams get a bigger budget (12s for a handful of staff,
            # ~40s for 50). The solver usually stops well before the limit.
            time_limit = min(50.0, max(15.0, 12.0 + 0.7 * len(scenario.employees)))
            schedule = solver.solve(
                find_alternative=(kind == 'alternative' and bool(history)),
                time_limit_seconds=time_limit,
                stall_seconds=STALL_SECONDS,
            )

            if schedule.is_feasible:
                update(message='Saving schedule...', force=True)
                new_history = list(history) + [solver._previous_solutions[-1]] if solver._previous_solutions else list(history)
                if is_demo:
                    _demo_history[_history_key(scenario.id, week_start)] = new_history[-MAX_HISTORY:]
                else:
                    try:
                        db_service.save_schedule_to_db(scenario.id, schedule, week_start, status='draft',
                                                       history=_serialize_history(new_history))
                    except Exception as e:
                        db.session.rollback()
                        print(f"[JOB {job_id[:8]}] Could not save schedule: {e}", flush=True)

            result = {
                'success': schedule.is_feasible,
                'schedule': schedule.to_dict(),
                'business': {
                    'id': scenario.id, 'name': scenario.name,
                    'roles': [r.to_dict() for r in scenario.roles],
                },
                'employees': [e.to_dict() for e in scenario.employees],
                'week_start': week_start.isoformat(),
                'status': 'draft',
                'message': _result_message(schedule, kind),
            }
            job = ScheduleJob.query.get(job_id)
            if job:
                job.status = 'done'
                job.message = result['message']
                job.result_json = json.dumps(result)
                db.session.commit()
        except Exception as e:
            traceback.print_exc()
            try:
                job = ScheduleJob.query.get(job_id)
                if job:
                    job.status = 'failed'
                    job.error = str(e)
                    job.message = 'Schedule generation failed.'
                    db.session.commit()
            except Exception:
                db.session.rollback()
        finally:
            db.session.remove()


def _result_message(schedule, kind: str) -> str:
    if not schedule.is_feasible:
        return ('No different schedule could be found. Reset alternatives to start over.'
                if kind == 'alternative' else
                'No schedule satisfies all of the hard rules. See the suggestions below.')
    pct = schedule.metrics.to_dict()['coverage_percentage']
    secs = schedule.solve_time_ms / 1000.0
    prefix = f'Alternative #{schedule.solution_index} found' if kind == 'alternative' else 'Schedule generated'
    if pct >= 100:
        return f'{prefix} in {secs:.1f}s with full coverage.'
    missing = schedule.metrics.total_hours_still_needed
    return f'{prefix} in {secs:.1f}s. {pct}% coverage ({missing} person-hour(s) still open).'


def load_job(job_id: str) -> Optional[ScheduleJob]:
    return ScheduleJob.query.get(job_id)


def purge_old_jobs(max_age_hours: int = 24):
    """Housekeeping: drop finished jobs older than a day. Safe to call often."""
    from datetime import datetime, timedelta
    cutoff = datetime.utcnow() - timedelta(hours=max_age_hours)
    try:
        ScheduleJob.query.filter(ScheduleJob.created_at < cutoff).delete()
        db.session.commit()
    except Exception:
        db.session.rollback()
