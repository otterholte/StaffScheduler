"""This-week-only changes on top of a business's normal staffing.

Two layers feed the solver for a given week:

1. Default staffing: the shift templates / role coverage from the Requirements
   page, already expanded into ``CoverageRequirement`` rows by the scenario.
2. Week overrides: a small JSON document saved per week from the schedule
   page's "Edit This Week" view. It never touches the defaults.

Override document shape::

    {"days": {"4": {"clear": false,
                    "entries": [{"mode": "set", "role_id": "server",
                                 "start_hour": 17, "end_hour": 22, "count": 3,
                                 "label": "Game Night"}]}}}

* ``clear`` drops the day's default needs before entries are applied.
* ``mode: "set"`` makes the role need exactly ``count`` people for those hours.
* ``mode: "add"`` adds ``count`` on top of whatever is needed at those hours
  (a negative count subtracts; the result never goes below zero).

Availability exceptions (one-off "can work" / "can't work" on a date) are
applied to the employees of the same working copy. Everything here operates on
a deep copy of the scenario, so the stored business is unchanged.
"""
import copy
import math
from datetime import date, timedelta
from typing import Dict, Iterable, List, Optional

from models import db, AvailabilityException, DBBusiness, EventTemplate, WeekOverride
from scheduler.models import BusinessScenario, CoverageRequirement, TimeSlot
import db_service


# ----------------------------------------------------------------- overrides

def _clean_entry(raw: dict) -> Optional[dict]:
    try:
        start, end = int(raw.get('start_hour')), int(raw.get('end_hour'))
        count = int(raw.get('count', 0))
    except (TypeError, ValueError):
        return None
    role_id = str(raw.get('role_id') or '').strip()
    if not role_id or end <= start:
        return None
    mode = 'add' if raw.get('mode') == 'add' else 'set'
    if mode == 'set':
        count = max(0, count)
    entry = {'mode': mode, 'role_id': role_id, 'start_hour': start, 'end_hour': end, 'count': count}
    label = str(raw.get('label') or '').strip()
    if label:
        entry['label'] = label[:80]
    template_id = str(raw.get('template_id') or '').strip()
    if template_id:
        entry['template_id'] = template_id[:40]
        if raw.get('template_mode') in ('add', 'replace'):
            entry['template_mode'] = raw['template_mode']
    return entry


def clean_overrides(data: dict) -> dict:
    """Validate a document sent by the browser; unknown keys are dropped."""
    out_days: Dict[str, dict] = {}
    for day_key, day_val in ((data or {}).get('days') or {}).items():
        try:
            day = int(day_key)
        except (TypeError, ValueError):
            continue
        if not 0 <= day <= 6 or not isinstance(day_val, dict):
            continue
        entries = [e for e in (_clean_entry(r) for r in (day_val.get('entries') or []) if isinstance(r, dict)) if e]
        clear = bool(day_val.get('clear'))
        if entries or clear:
            out_days[str(day)] = {'clear': clear, 'entries': entries}
    return {'days': out_days}


def count_changes(overrides: dict) -> int:
    n = 0
    for day_val in (overrides or {}).get('days', {}).values():
        n += len(day_val.get('entries') or []) + (1 if day_val.get('clear') else 0)
    return n


def merge_coverage(base: Iterable[CoverageRequirement], overrides: dict,
                   days_open: List[int], start_hour: int, end_hour: int) -> List[CoverageRequirement]:
    """Apply a week's overrides to the default coverage rows."""
    grid: Dict[tuple, CoverageRequirement] = {}
    for req in base:
        grid[(req.day, req.hour, req.role_id)] = CoverageRequirement(
            day=req.day, hour=req.hour, role_id=req.role_id,
            min_staff=req.min_staff, max_staff=req.max_staff, is_peak=req.is_peak)

    days = (overrides or {}).get('days') or {}
    for day_key, day_val in days.items():
        day = int(day_key)
        if day_val.get('clear'):
            for key in [k for k in grid if k[0] == day]:
                del grid[key]
        for entry in day_val.get('entries') or []:
            lo = max(int(entry['start_hour']), start_hour)
            hi = min(int(entry['end_hour']), end_hour)
            for hour in range(lo, hi):
                key = (day, hour, entry['role_id'])
                cur = grid.get(key)
                current = cur.min_staff if cur else 0
                new = entry['count'] if entry['mode'] == 'set' else current + entry['count']
                new = max(0, int(new))
                if new == 0:
                    grid.pop(key, None)
                    continue
                if cur:
                    cur.min_staff = new
                    cur.max_staff = max(cur.max_staff or 0, new)
                else:
                    grid[key] = CoverageRequirement(day=day, hour=hour, role_id=entry['role_id'],
                                                    min_staff=new, max_staff=new, is_peak=False)
    return sorted(grid.values(), key=lambda r: (r.day, r.hour, r.role_id))


def get_override_row(row: DBBusiness, week_start: date) -> Optional[WeekOverride]:
    return WeekOverride.query.filter_by(business_db_id=row.id, week_start_date=week_start).first()


def load_overrides(row: Optional[DBBusiness], week_start: date) -> dict:
    if not row:
        return {'days': {}}
    rec = get_override_row(row, week_start)
    return clean_overrides(rec.get_overrides()) if rec else {'days': {}}


def save_overrides(row: DBBusiness, week_start: date, data: dict) -> dict:
    cleaned = clean_overrides(data)
    rec = get_override_row(row, week_start)
    if not cleaned['days']:
        if rec:
            db.session.delete(rec)
            db.session.commit()
        return cleaned
    if not rec:
        rec = WeekOverride(business_db_id=row.id, week_start_date=week_start)
        db.session.add(rec)
    rec.set_overrides(cleaned)
    db.session.commit()
    return cleaned


# ----------------------------------------------------------------- templates

def clean_template_items(items) -> List[dict]:
    out = []
    for raw in items or []:
        if not isinstance(raw, dict):
            continue
        try:
            start, end, count = int(raw.get('start_hour')), int(raw.get('end_hour')), int(raw.get('count', 0))
        except (TypeError, ValueError):
            continue
        role_id = str(raw.get('role_id') or '').strip()
        if role_id and end > start and count != 0:
            out.append({'role_id': role_id, 'start_hour': start, 'end_hour': end, 'count': count})
    return out


def list_templates(row: Optional[DBBusiness]) -> List[dict]:
    if not row:
        return []
    rows = EventTemplate.query.filter_by(business_db_id=row.id).order_by(EventTemplate.created_at.asc()).all()
    return [t.to_dict() for t in rows]


# ---------------------------------------------------------------- exceptions

def exceptions_between(row: Optional[DBBusiness], start: date, end: date,
                       employee_id: Optional[str] = None) -> List[AvailabilityException]:
    if not row:
        return []
    q = AvailabilityException.query.filter(
        AvailabilityException.business_db_id == row.id,
        AvailabilityException.date >= start, AvailabilityException.date <= end)
    if employee_id:
        q = q.filter(AvailabilityException.employee_id == employee_id)
    return q.order_by(AvailabilityException.date.asc(), AvailabilityException.start_hour.asc()).all()


def _exception_hours(exc: AvailabilityException, start_hour: int, end_hour: int) -> range:
    if exc.start_hour is None and exc.end_hour is None:
        return range(start_hour, end_hour)
    lo = int(math.floor(exc.start_hour if exc.start_hour is not None else start_hour))
    hi = int(math.ceil(exc.end_hour if exc.end_hour is not None else end_hour))
    return range(max(lo, start_hour), min(hi, end_hour))


def apply_exceptions(working: BusinessScenario, exceptions: Iterable[AvailabilityException], week_start: date):
    """Mutate the working copy's employees for the exceptions in this week."""
    by_emp = {e.id: e for e in working.employees}
    for exc in exceptions:
        emp = by_emp.get(exc.employee_id)
        if not emp:
            continue
        day = (exc.date - week_start).days
        if not 0 <= day <= 6:
            continue
        hours = _exception_hours(exc, working.start_hour, working.end_hour)
        if exc.kind == 'available':
            for hour in hours:
                slot = TimeSlot(day, hour)
                emp.availability.add(slot)
                emp.time_off.discard(slot)
                # Someone who volunteered a day is a good pick for it
                if exc.created_by == 'employee':
                    emp.preferences.add(slot)
        else:
            for hour in hours:
                emp.time_off.add(TimeSlot(day, hour))


# ------------------------------------------------------------- week scenario

def scenario_for_week(scenario: BusinessScenario, week_start: date) -> BusinessScenario:
    """The scenario the solver should see for one week: time off blocked,
    availability exceptions applied, and this week's staffing overrides merged."""
    from services.business_context import is_demo_id, scenario_with_time_off
    working = scenario_with_time_off(scenario, week_start)
    if is_demo_id(scenario.id):
        return working
    row = db_service.get_db_business(scenario.id)
    if not row:
        return working
    overrides = load_overrides(row, week_start)
    if overrides['days']:
        working.coverage_requirements = merge_coverage(
            working.coverage_requirements, overrides, working.days_open, working.start_hour, working.end_hour)
    week_end = week_start + timedelta(days=6)
    excs = exceptions_between(row, week_start, week_end)
    if excs:
        apply_exceptions(working, excs, week_start)
    return working
