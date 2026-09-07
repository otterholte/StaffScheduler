"""
Database persistence for businesses and schedules.

Converts between the scheduler's dataclass models (`scheduler/models.py`) and
the SQLAlchemy rows (`models.py`). Every manager request loads its business
fresh from here and saves it back after a change, so the database is the only
source of truth (there is no cross-request in-memory cache any more).
"""

import json
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional, Set, Tuple

from models import (
    db, DBBusiness, DBEmployee, DBRole, DBShiftTemplate, DBSchedule, DBShiftAssignment,
)
from scheduler.models import (
    AvailabilityRange, BusinessScenario, CoverageMode, Employee, EmployeeClassification,
    PeakPeriod, Role, RoleCoverageConfig, Schedule, ShiftAssignment, ShiftRoleRequirement,
    ShiftTemplate, TimeSlot,
)


# =============================================================================
# BUSINESS LOOKUPS
# =============================================================================

def get_db_business(business_id: str) -> Optional[DBBusiness]:
    """Business row by its string id (e.g. 'user_7_sunrise_coffee')."""
    if not business_id:
        return None
    return DBBusiness.query.filter_by(business_id=business_id).first()


def get_user_db_businesses(user_id: int) -> List[DBBusiness]:
    """All businesses owned by a user, oldest first."""
    return DBBusiness.query.filter_by(owner_id=user_id).order_by(DBBusiness.created_at.asc(), DBBusiness.id.asc()).all()


def get_user_db_business(user_id: int) -> Optional[DBBusiness]:
    """The user's first (primary) business, or None."""
    businesses = get_user_db_businesses(user_id)
    return businesses[0] if businesses else None


def get_all_persisted_businesses() -> List[DBBusiness]:
    return DBBusiness.query.all()


def is_business_persisted(business_id: str) -> bool:
    return get_db_business(business_id) is not None


# =============================================================================
# BUSINESS SAVE / LOAD
# =============================================================================

def save_business_to_db(scenario: BusinessScenario, owner_id: int) -> DBBusiness:
    """Create or update the business row and all of its roles, employees, and shifts."""
    db_business = get_db_business(scenario.id)

    if db_business is None:
        db_business = DBBusiness(business_id=scenario.id, owner_id=owner_id)
        db.session.add(db_business)

    db_business.name = scenario.name
    db_business.description = scenario.description
    db_business.emoji = scenario.emoji or '🏢'
    db_business.color = scenario.color or '#6366f1'
    db_business.start_hour = scenario.start_hour
    db_business.end_hour = scenario.end_hour
    db_business.coverage_mode = scenario.coverage_mode.value
    db_business.has_completed_setup = scenario.has_completed_setup
    db_business.set_days_open_list(scenario.days_open)
    db_business.set_coverage_config(
        [p.to_dict() for p in scenario.peak_periods],
        [c.to_dict() for c in scenario.role_coverage_configs],
    )
    db.session.flush()  # make sure db_business.id exists for the children

    _save_roles_to_db(db_business, scenario.roles)
    _save_employees_to_db(db_business, scenario.employees)
    _save_shift_templates_to_db(db_business, scenario.shift_templates)

    db.session.commit()
    return db_business


def load_business_from_db(db_business: DBBusiness) -> BusinessScenario:
    """Rebuild the full dataclass model from the database rows."""
    roles = [_db_role_to_model(r) for r in db_business.roles]
    employees = [_db_employee_to_model(e) for e in db_business.employees]
    shift_templates = [_db_shift_template_to_model(s) for s in db_business.shift_templates]

    try:
        coverage_mode = CoverageMode(db_business.coverage_mode)
    except ValueError:
        coverage_mode = CoverageMode.SHIFTS

    config = db_business.get_coverage_config()
    peak_periods = []
    for p in config.get('peak_periods', []):
        try:
            peak_periods.append(PeakPeriod(
                name=p.get('name', 'Peak'),
                start_hour=int(p.get('start_hour', 8)),
                end_hour=int(p.get('end_hour', 10)),
                days=[int(d) for d in p.get('days', list(range(7)))],
            ))
        except (TypeError, ValueError):
            continue
    role_configs = []
    for c in config.get('role_coverage_configs', []):
        try:
            role_configs.append(RoleCoverageConfig(
                role_id=c['role_id'],
                default_min_staff=int(c.get('default_min_staff', 1)),
                default_max_staff=int(c.get('default_max_staff', 3)),
                peak_boost=int(c.get('peak_boost', 0)),
                required_hours=c.get('required_hours', []) or [],
                required_days=[int(d) for d in (c.get('required_days', []) or [])],
            ))
        except (KeyError, TypeError, ValueError):
            continue

    scenario = BusinessScenario(
        id=db_business.business_id,
        name=db_business.name,
        description=db_business.description or '',
        start_hour=db_business.start_hour,
        end_hour=db_business.end_hour,
        days_open=db_business.get_days_open_list(),
        roles=roles,
        employees=employees,
        shift_templates=shift_templates,
        peak_periods=peak_periods,
        role_coverage_configs=role_configs,
        coverage_mode=coverage_mode,
        has_completed_setup=bool(db_business.has_completed_setup),
        emoji=db_business.emoji or '🏢',
        color=db_business.color or '#6366f1',
    )
    scenario.coverage_requirements = scenario.generate_coverage_requirements()
    return scenario


def delete_business_from_db(business_id: str) -> bool:
    """Delete a business and (via cascade) everything attached to it."""
    db_business = get_db_business(business_id)
    if not db_business:
        return False
    # Employee user accounts keep their login but lose the link.
    from models import User
    for emp in db_business.employees:
        for user in User.query.filter_by(linked_employee_id=emp.id).all():
            user.linked_employee_id = None
    db.session.delete(db_business)
    db.session.commit()
    return True


def update_business_metadata(business_id: str, name: str = None, emoji: str = None, color: str = None) -> bool:
    """Update just the display fields (name, emoji, color)."""
    db_business = get_db_business(business_id)
    if not db_business:
        return False
    if name is not None:
        db_business.name = name
    if emoji is not None:
        db_business.emoji = emoji
    if color is not None:
        db_business.color = color
    db.session.commit()
    return True


# =============================================================================
# ROLES
# =============================================================================

def _save_roles_to_db(db_business: DBBusiness, roles: List[Role]):
    new_ids = {r.id for r in roles}
    for db_role in list(db_business.roles):
        if db_role.role_id not in new_ids:
            db.session.delete(db_role)
    existing = {r.role_id: r for r in db_business.roles if r.role_id in new_ids}
    for role in roles:
        db_role = existing.get(role.id)
        if db_role is None:
            db.session.add(DBRole(role_id=role.id, business_db_id=db_business.id, name=role.name, color=role.color))
        else:
            db_role.name = role.name
            db_role.color = role.color


def _db_role_to_model(db_role: DBRole) -> Role:
    return Role(id=db_role.role_id, name=db_role.name, color=db_role.color)


# =============================================================================
# EMPLOYEES
# =============================================================================

def _save_employees_to_db(db_business: DBBusiness, employees: List[Employee]):
    new_ids = {e.id for e in employees}
    from models import User
    for db_emp in list(db_business.employees):
        if db_emp.employee_id not in new_ids:
            # Unlink any login account before the row disappears
            for user in User.query.filter_by(linked_employee_id=db_emp.id).all():
                user.linked_employee_id = None
            db.session.delete(db_emp)
    existing = {e.employee_id: e for e in db_business.employees if e.employee_id in new_ids}
    for emp in employees:
        _write_employee(db_business.id, emp, existing.get(emp.id))


def _write_employee(business_db_id: int, emp: Employee, db_emp: Optional[DBEmployee] = None) -> DBEmployee:
    """Copy every field of an Employee dataclass onto its row (creating it if needed)."""
    if db_emp is None:
        db_emp = DBEmployee.query.filter_by(business_db_id=business_db_id, employee_id=emp.id).first()
    if db_emp is None:
        db_emp = DBEmployee(employee_id=emp.id, business_db_id=business_db_id, name=emp.name)
        db.session.add(db_emp)

    db_emp.name = emp.name
    db_emp.email = (emp.email or None)
    db_emp.phone = (emp.phone or None)
    db_emp.color = emp.color
    db_emp.classification = emp.classification.value
    db_emp.min_hours = int(emp.min_hours)
    db_emp.max_hours = int(emp.max_hours)
    db_emp.set_roles_list(emp.roles)
    db_emp.needs_supervision = bool(emp.needs_supervision)
    db_emp.can_supervise = bool(emp.can_supervise)
    db_emp.overtime_allowed = bool(emp.overtime_allowed)
    db_emp.hourly_rate = float(emp.hourly_rate)
    db_emp.weekend_shifts_worked = int(emp.weekend_shifts_worked)
    db_emp.notify_email = bool(getattr(emp, 'notify_email', True))
    db_emp.notify_sms = bool(getattr(emp, 'notify_sms', True))

    db_emp.set_availability_data({
        # Range format keeps 15-minute precision
        'availability_ranges': [r.to_dict() for r in emp.availability_ranges],
        'preference_ranges': [r.to_dict() for r in emp.preference_ranges],
        'time_off_ranges': [r.to_dict() for r in emp.time_off_ranges],
        # Hour-slot format is what the solver and older clients use
        'availability': [{'day': s.day, 'hour': s.hour} for s in sorted(emp.availability, key=lambda s: (s.day, s.hour))],
        'preferences': [{'day': s.day, 'hour': s.hour} for s in sorted(emp.preferences, key=lambda s: (s.day, s.hour))],
        'time_off': [{'day': s.day, 'hour': s.hour} for s in sorted(emp.time_off, key=lambda s: (s.day, s.hour))],
    })
    return db_emp


def _db_employee_to_model(db_emp: DBEmployee) -> Employee:
    try:
        classification = EmployeeClassification(db_emp.classification)
    except ValueError:
        classification = EmployeeClassification.PART_TIME

    avail = db_emp.get_availability_data()

    def ranges(key):
        out = []
        for r in avail.get(key, []) or []:
            try:
                out.append(AvailabilityRange.from_dict(r))
            except (KeyError, TypeError):
                continue
        return out

    def slots(key):
        out = set()
        for s in avail.get(key, []) or []:
            try:
                out.add(TimeSlot(int(s['day']), int(s['hour'])))
            except (KeyError, TypeError, ValueError):
                continue
        return out

    availability_ranges = ranges('availability_ranges')
    preference_ranges = ranges('preference_ranges')
    time_off_ranges = ranges('time_off_ranges')
    availability, preferences, time_off = slots('availability'), slots('preferences'), slots('time_off')

    # Older rows only have one of the two formats; derive the other.
    if availability_ranges and not availability:
        for r in availability_ranges:
            availability.update(r.to_time_slots())
    if preference_ranges and not preferences:
        for r in preference_ranges:
            preferences.update(r.to_time_slots())
    if time_off_ranges and not time_off:
        for r in time_off_ranges:
            time_off.update(r.to_time_slots())

    emp = Employee(
        id=db_emp.employee_id,
        name=db_emp.name,
        email=db_emp.email,
        phone=db_emp.phone,
        color=db_emp.color,
        classification=classification,
        min_hours=db_emp.min_hours,
        max_hours=db_emp.max_hours,
        roles=db_emp.get_roles_list(),
        availability_ranges=availability_ranges,
        preference_ranges=preference_ranges,
        time_off_ranges=time_off_ranges,
        availability=availability,
        preferences=preferences,
        time_off=time_off,
        needs_supervision=bool(db_emp.needs_supervision),
        can_supervise=bool(db_emp.can_supervise),
        overtime_allowed=bool(db_emp.overtime_allowed),
        hourly_rate=db_emp.hourly_rate if db_emp.hourly_rate is not None else 15.0,
        weekend_shifts_worked=db_emp.weekend_shifts_worked or 0,
    )
    emp.notify_email = True if db_emp.notify_email is None else bool(db_emp.notify_email)
    emp.notify_sms = True if db_emp.notify_sms is None else bool(db_emp.notify_sms)
    emp.db_id = db_emp.id
    return emp


def get_employee_from_db(business_id: str, employee_id: str) -> Optional[Employee]:
    db_business = get_db_business(business_id)
    if not db_business:
        return None
    db_emp = DBEmployee.query.filter_by(business_db_id=db_business.id, employee_id=employee_id).first()
    return _db_employee_to_model(db_emp) if db_emp else None


# =============================================================================
# SHIFT TEMPLATES
# =============================================================================

def _save_shift_templates_to_db(db_business: DBBusiness, templates: List[ShiftTemplate]):
    new_ids = {s.id for s in templates}
    for db_shift in list(db_business.shift_templates):
        if db_shift.shift_id not in new_ids:
            db.session.delete(db_shift)
    existing = {s.shift_id: s for s in db_business.shift_templates if s.shift_id in new_ids}
    for shift in templates:
        db_shift = existing.get(shift.id)
        if db_shift is None:
            db_shift = DBShiftTemplate(shift_id=shift.id, business_db_id=db_business.id, name=shift.name,
                                       start_hour=shift.start_hour, end_hour=shift.end_hour, color=shift.color)
            db.session.add(db_shift)
        db_shift.name = shift.name
        db_shift.start_hour = shift.start_hour
        db_shift.end_hour = shift.end_hour
        db_shift.color = shift.color
        db_shift.set_days_list(shift.days)
        db_shift.set_roles_requirements([
            {'role_id': r.role_id, 'count': r.count, 'max_count': r.max_count} for r in shift.roles
        ])


def _db_shift_template_to_model(db_shift: DBShiftTemplate) -> ShiftTemplate:
    roles = []
    for r in db_shift.get_roles_requirements():
        try:
            roles.append(ShiftRoleRequirement(role_id=r['role_id'], count=int(r.get('count', 1)),
                                              max_count=int(r.get('max_count', 0))))
        except (KeyError, TypeError, ValueError):
            continue
    return ShiftTemplate(id=db_shift.shift_id, name=db_shift.name, start_hour=db_shift.start_hour,
                         end_hour=db_shift.end_hour, roles=roles, days=db_shift.get_days_list(), color=db_shift.color)


# =============================================================================
# SCHEDULES
# =============================================================================

def week_id_for(week_start: date) -> str:
    return week_start.strftime('%Y-W%V')


def get_schedule_record(business_id: str, week_start: date, published_only: bool = False) -> Optional[DBSchedule]:
    """Find the schedule row for a week.

    Looks up by ISO week id first, then by the stored Monday, then by a day on
    either side (browser and server can disagree about the date near midnight).
    """
    db_business = get_db_business(business_id)
    if not db_business:
        return None

    def q(**kw):
        query = DBSchedule.query.filter_by(business_db_id=db_business.id, **kw)
        if published_only:
            query = query.filter_by(status='published')
        return query.first()

    rec = q(week_id=week_id_for(week_start)) or q(week_start_date=week_start)
    if not rec:
        for delta in (-1, 1):
            rec = q(week_id=week_id_for(week_start + timedelta(days=delta)))
            if rec:
                break
    return rec


def save_schedule_to_db(business_id: str, schedule: Schedule, week_start: date, status: str = 'draft',
                        history: Optional[List[List[str]]] = None) -> Optional[DBSchedule]:
    """Persist a generated schedule (and its individual shift rows) for a week.

    `history` is a list of previous solutions for this week (each a list of
    'employee|day|hour' strings). It is kept inside the JSON so that "find
    alternative" can be forced to differ from every earlier result, regardless
    of which server process handles the request.
    """
    db_business = get_db_business(business_id)
    if not db_business:
        return None

    week_id = week_id_for(week_start)
    rec = DBSchedule.query.filter_by(business_db_id=db_business.id, week_id=week_id).first()
    if rec is None:
        rec = DBSchedule(business_db_id=db_business.id, week_id=week_id, week_start_date=week_start, status=status)
        db.session.add(rec)
    else:
        rec.status = status
        rec.week_start_date = week_start

    data = schedule.to_dict()
    if history is not None:
        data['alternatives_history'] = history
    rec.set_schedule_data(data)
    rec.coverage_percentage = schedule.coverage_percentage
    rec.total_hours_needed = schedule.total_hours_needed
    rec.total_hours_filled = schedule.total_hours_filled
    if status == 'published':
        rec.published_at = datetime.utcnow()
    db.session.flush()

    DBShiftAssignment.query.filter_by(schedule_id=rec.id).delete()
    for a in schedule.assignments:
        db.session.add(DBShiftAssignment(
            schedule_id=rec.id, employee_id=a.employee_id, employee_name=a.employee_name,
            day=a.day, start_hour=a.start_hour, end_hour=a.end_hour, role_id=a.role_id, color=a.color,
        ))
    db.session.commit()
    return rec


def get_schedule_from_db(business_id: str, week_start: date) -> Optional[Schedule]:
    rec = get_schedule_record(business_id, week_start)
    return _db_schedule_to_model(rec) if rec else None


def get_schedule_with_status_from_db(business_id: str, week_start: date) -> Tuple[Optional[Schedule], Optional[str]]:
    rec = get_schedule_record(business_id, week_start)
    if not rec:
        return None, None
    return _db_schedule_to_model(rec), rec.status


def get_published_schedule_from_db(business_id: str, week_start: date) -> Optional[Schedule]:
    rec = get_schedule_record(business_id, week_start, published_only=True)
    return _db_schedule_to_model(rec) if rec else None


def get_schedule_history(business_id: str, week_start: date) -> List[Set[Tuple[str, int, int]]]:
    """Previous solutions for the week as sets of (employee_id, day, hour)."""
    rec = get_schedule_record(business_id, week_start)
    if not rec:
        return []
    data = rec.get_schedule_data()
    sets: List[Set[Tuple[str, int, int]]] = []
    for sol in data.get('alternatives_history', []) or []:
        s = set()
        for key in sol:
            try:
                emp_id, d, h = key.rsplit('|', 2)
                s.add((emp_id, int(d), int(h)))
            except ValueError:
                continue
        if s:
            sets.append(s)
    # The currently saved schedule always counts as a previous solution too
    current = set()
    for slot_key, assignments in data.get('slot_assignments', {}).items():
        try:
            d, h = [int(p) for p in slot_key.split(',')]
        except ValueError:
            continue
        for a in assignments:
            emp_id = a.get('employee_id') if isinstance(a, dict) else (a[0] if a else None)
            if emp_id:
                current.add((emp_id, d, h))
    if current and current not in sets:
        sets.append(current)
    return sets


def _db_schedule_to_model(rec: DBSchedule) -> Schedule:
    data = rec.get_schedule_data()

    assignments = [
        ShiftAssignment(
            employee_id=a['employee_id'], employee_name=a['employee_name'], day=a['day'],
            start_hour=a['start_hour'], end_hour=a['end_hour'],
            role_id=a.get('role_id', ''), color=a.get('color', '#4CAF50'),
        )
        for a in data.get('assignments', [])
    ]

    coverage_matrix = {}
    for key, emp_id in data.get('coverage_matrix', {}).items():
        parts = key.split(',')
        if len(parts) == 3:
            coverage_matrix[(int(parts[0]), int(parts[1]), parts[2])] = emp_id

    slot_assignments = {}
    for key, slot_list in data.get('slot_assignments', {}).items():
        parts = key.split(',')
        if len(parts) != 2:
            continue
        d, h = int(parts[0]), int(parts[1])
        entries = []
        for s in slot_list:
            if isinstance(s, dict):
                entries.append((s.get('employee_id'), s.get('role_id', '')))
            elif isinstance(s, (list, tuple)) and s:
                entries.append((s[0], s[1] if len(s) > 1 else ''))
        slot_assignments[(d, h)] = entries

    schedule = Schedule(
        assignments=assignments,
        coverage_matrix=coverage_matrix,
        slot_assignments=slot_assignments,
        total_hours_needed=data.get('total_hours_needed', 0),
        total_hours_filled=data.get('total_hours_filled', 0),
        employee_hours=data.get('employee_hours', {}),
        employee_overtime=data.get('employee_overtime', {}),
        consecutive_days=data.get('consecutive_days', {}),
        is_feasible=data.get('is_feasible', False),
        solve_time_ms=data.get('solve_time_ms', 0.0),
        solution_index=data.get('solution_index', 0),
        objective_value=data.get('objective_value', 0),
        solver_status=data.get('solver_status', ''),
    )
    # Metrics are stored as a plain dict; expose the important pieces
    metrics = data.get('metrics') or {}
    schedule.metrics.total_slots_required = metrics.get('total_slots_required', schedule.total_hours_needed)
    schedule.metrics.total_slots_filled = metrics.get('total_slots_filled', schedule.total_hours_filled)
    schedule.metrics.unfilled_slots = metrics.get('unfilled_slots', [])
    schedule.metrics.unfilled_by_role = metrics.get('unfilled_by_role', {})
    schedule.metrics.unfilled_by_day = {int(k): v for k, v in (metrics.get('unfilled_by_day') or {}).items()}
    schedule.metrics.total_hours_still_needed = metrics.get('total_hours_still_needed', 0)
    schedule.metrics.total_regular_hours = metrics.get('total_regular_hours', 0)
    schedule.metrics.total_overtime_hours = metrics.get('total_overtime_hours', 0)
    schedule.metrics.estimated_labor_cost = metrics.get('estimated_labor_cost', 0.0)
    schedule.metrics.weekend_distribution = metrics.get('weekend_distribution', {})
    schedule.metrics.preference_matches = metrics.get('preference_matches', 0)
    schedule.metrics.preference_misses = metrics.get('preference_misses', 0)
    schedule.metrics.consecutive_day_violations = metrics.get('consecutive_day_violations', 0)
    schedule.metrics.employees_under_min = metrics.get('employees_under_min', [])
    schedule.metrics.clopenings = metrics.get('clopenings', [])
    schedule.metrics.suggestions = metrics.get('suggestions', [])
    return schedule


def publish_schedule_in_db(business_id: str, week_start: date) -> Optional[DBSchedule]:
    rec = get_schedule_record(business_id, week_start)
    if not rec:
        return None
    rec.status = 'published'
    rec.published_at = datetime.utcnow()
    db.session.commit()
    return rec


def get_employee_shifts(business_id: str, employee_id: str, week_start: date) -> List[Dict]:
    """Published shifts for one employee in a week (from the per-shift rows)."""
    rec = get_schedule_record(business_id, week_start, published_only=True)
    if not rec:
        return []
    shifts = DBShiftAssignment.query.filter_by(schedule_id=rec.id, employee_id=employee_id) \
        .order_by(DBShiftAssignment.day, DBShiftAssignment.start_hour).all()
    return [s.to_dict() for s in shifts]


def sync_business_to_db(scenario: BusinessScenario, owner_id: int):
    """Alias kept for older call sites."""
    save_business_to_db(scenario, owner_id)
