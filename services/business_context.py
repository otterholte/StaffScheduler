"""
Request-scoped business resolution and access control.

Rules this module enforces:

* A logged-in manager only ever sees and edits businesses they own.
* The five built-in demo businesses are only reachable through /demo and are
  never persisted; edits to them are in-memory and disappear on restart.
* Every API call that touches a business goes through `require_business()`,
  which loads a *fresh* copy from the database. There is no shared cache, so
  two Gunicorn workers can never disagree about what a business looks like.
* The manager's "current" business is remembered in the signed session cookie
  (per user, works across workers) so API calls that don't name a business
  still resolve to the one the user is looking at.
"""

import copy
import re
import uuid
from datetime import date, timedelta
from typing import Dict, List, Optional, Tuple

from flask import g, session
from flask_login import current_user

from models import db, DBBusiness, DBEmployee, PTORequest, User
from scheduler.businesses import DEMO_BUSINESS_IDS, get_demo_business as _get_demo, list_demo_businesses
from scheduler.models import (
    BusinessScenario, CoverageMode, Employee, EmployeeClassification, Role, ShiftRoleRequirement, ShiftTemplate,
)
from services.common import slugify
import db_service


class BusinessAccessError(Exception):
    """Raised when a request names a business the caller may not use."""

    def __init__(self, message: str, status: int = 403):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------- basics

def is_demo_id(business_id: Optional[str]) -> bool:
    return bool(business_id) and business_id in DEMO_BUSINESS_IDS


def business_slug(name: str) -> str:
    return slugify(name)


def get_demo_business(business_id: str) -> BusinessScenario:
    """The shared in-memory demo scenario (mutable, ephemeral)."""
    return _get_demo(business_id)


def summary(scenario: BusinessScenario) -> dict:
    """Compact description used by the location switcher."""
    return {
        'id': scenario.id,
        'name': scenario.name,
        'slug': business_slug(scenario.name),
        'description': scenario.description,
        'total_employees': len(scenario.employees),
        'total_roles': len(scenario.roles),
        'emoji': scenario.emoji or '🏢',
        'color': scenario.color or '#6366f1',
        'hours': f"{scenario.start_hour}:00-{scenario.end_hour}:00",
        'days_open': len(scenario.days_open),
        'is_demo': is_demo_id(scenario.id),
    }


def db_summary(row: DBBusiness) -> dict:
    """Like `summary` but straight from the row (no full load)."""
    return {
        'id': row.business_id,
        'name': row.name,
        'slug': business_slug(row.name),
        'description': row.description or '',
        'total_employees': len(row.employees),
        'total_roles': len(row.roles),
        'emoji': row.emoji or '🏢',
        'color': row.color or '#6366f1',
        'hours': f"{row.start_hour}:00-{row.end_hour}:00",
        'days_open': len(row.get_days_open_list()),
        'is_demo': False,
    }


# ---------------------------------------------------------------- session

SESSION_KEY = 'current_business_id'


def set_current_business_id(business_id: Optional[str]):
    if business_id:
        session[SESSION_KEY] = business_id
    else:
        session.pop(SESSION_KEY, None)


def get_current_business_id() -> Optional[str]:
    return session.get(SESSION_KEY)


# ---------------------------------------------------------------- ownership

def _user() -> Optional[User]:
    return current_user if current_user.is_authenticated else None


def list_owned_businesses(user: Optional[User] = None) -> List[DBBusiness]:
    user = user or _user()
    if not user:
        return []
    return db_service.get_user_db_businesses(user.id)


def user_owns(row: DBBusiness, user: Optional[User] = None) -> bool:
    user = user or _user()
    return bool(user and row and row.owner_id == user.id)


def find_owned_by_ref(ref: str, user: Optional[User] = None) -> Optional[DBBusiness]:
    """Match a business the user owns by id OR by URL slug of its name."""
    user = user or _user()
    if not user or not ref:
        return None
    ref_l = ref.lower()
    for row in list_owned_businesses(user):
        if row.business_id == ref or business_slug(row.name) == ref_l:
            return row
    return None


def _cache() -> Dict[str, BusinessScenario]:
    if not hasattr(g, '_business_cache'):
        g._business_cache = {}
    return g._business_cache


def load_scenario(row: DBBusiness) -> BusinessScenario:
    """Load (once per request) the full scenario for a business row."""
    cache = _cache()
    if row.business_id not in cache:
        cache[row.business_id] = db_service.load_business_from_db(row)
    return cache[row.business_id]


def require_business(ref: Optional[str] = None, *, allow_demo: bool = True,
                     fallback_to_session: bool = True) -> BusinessScenario:
    """Resolve the business a request is about, enforcing access rules.

    Resolution order: explicit `ref` (id or slug) -> session -> user's first
    business. Demo businesses are allowed for anyone (logged in or not) when
    `allow_demo` is true. Anything else requires a logged-in owner.
    """
    user = _user()

    candidates: List[str] = []
    if ref:
        candidates.append(ref)
    if fallback_to_session and get_current_business_id():
        candidates.append(get_current_business_id())

    for candidate in candidates:
        if is_demo_id(candidate):
            if not allow_demo:
                raise BusinessAccessError('Demo businesses are only available on the demo page.', 403)
            return get_demo_business(candidate)
        # A demo slug (e.g. 'sunrise-coffee') also resolves to the demo business
        for demo in list_demo_businesses():
            if business_slug(demo.name) == candidate.lower():
                if not allow_demo:
                    raise BusinessAccessError('Demo businesses are only available on the demo page.', 403)
                return demo
        if not user:
            raise BusinessAccessError('Please sign in to continue.', 401)
        row = find_owned_by_ref(candidate, user)
        if row:
            set_current_business_id(row.business_id)
            return load_scenario(row)
        if ref and candidate == ref:
            raise BusinessAccessError('Business not found.', 404)

    if not user:
        raise BusinessAccessError('Please sign in to continue.', 401)
    row = ensure_user_has_business(user)
    set_current_business_id(row.business_id)
    return load_scenario(row)


def persist(scenario: BusinessScenario):
    """Write a (non-demo) scenario back to the database."""
    if is_demo_id(scenario.id):
        return  # demo edits live in memory only
    row = db_service.get_db_business(scenario.id)
    if not row:
        raise BusinessAccessError('Business not found.', 404)
    db_service.save_business_to_db(scenario, row.owner_id)
    _cache()[scenario.id] = scenario


# ---------------------------------------------------------------- creation

def _unique_business_id(user_id: int, name: str) -> str:
    base = re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_') or 'business'
    business_id = f"user_{user_id}_{base}"
    if not db_service.get_db_business(business_id):
        return business_id
    return f"{business_id}_{uuid.uuid4().hex[:6]}"


def _unique_name_for_user(user_id: int, name: str) -> str:
    """Slugs must be unique per owner so URLs are unambiguous."""
    taken = {business_slug(b.name) for b in db_service.get_user_db_businesses(user_id)}
    if business_slug(name) not in taken:
        return name
    n = 2
    while business_slug(f"{name} {n}") in taken:
        n += 1
    return f"{name} {n}"


def create_business_for_user(user: User, name: str, owner_name: Optional[str] = None,
                             emoji: str = '🏢', color: str = '#6366f1') -> BusinessScenario:
    """Create a new business with sensible defaults and persist it."""
    name = (name or '').strip() or f"{user.first_name or user.username}'s Business"
    name = _unique_name_for_user(user.id, name)
    business_id = _unique_business_id(user.id, name)

    roles = [
        Role(id='staff', name='Staff', color='#3b82f6'),
        Role(id='manager', name='Manager', color='#10b981'),
    ]
    employees: List[Employee] = []
    if owner_name:
        owner = Employee(
            id=f"owner_{user.id}_{uuid.uuid4().hex[:4]}", name=owner_name,
            classification=EmployeeClassification.FULL_TIME, min_hours=0, max_hours=40,
            roles=['manager', 'staff'], can_supervise=True, needs_supervision=False,
            overtime_allowed=True, hourly_rate=25.0, color='#8b5cf6', email=user.email,
        )
        for day in range(7):
            owner.add_availability(day, 9, 17)
        employees.append(owner)

    shift_templates = [
        ShiftTemplate(id='morning', name='Morning Shift', start_hour=9, end_hour=13,
                      roles=[ShiftRoleRequirement('staff', 1)], days=list(range(7)), color='#f59e0b'),
        ShiftTemplate(id='afternoon', name='Afternoon Shift', start_hour=13, end_hour=17,
                      roles=[ShiftRoleRequirement('staff', 1)], days=list(range(7)), color='#3b82f6'),
    ]
    scenario = BusinessScenario(
        id=business_id, name=name, description=f"{name}",
        start_hour=9, end_hour=17, days_open=list(range(7)),
        roles=roles, employees=employees, coverage_requirements=[],
        coverage_mode=CoverageMode.SHIFTS, shift_templates=shift_templates,
        has_completed_setup=False, emoji=emoji or '🏢', color=color or '#6366f1',
    )
    scenario.coverage_requirements = scenario.generate_coverage_requirements()
    db_service.save_business_to_db(scenario, user.id)
    _cache()[scenario.id] = scenario
    return scenario


def ensure_user_has_business(user: User) -> DBBusiness:
    """Managers always have at least one business; create one on first use."""
    rows = db_service.get_user_db_businesses(user.id)
    if rows:
        return rows[0]
    owner_name = f"{user.first_name or ''} {user.last_name or ''}".strip() or user.username
    scenario = create_business_for_user(user, user.company_name or '', owner_name)
    if not user.company_name:
        user.company_name = scenario.name
        db.session.commit()
    return db_service.get_db_business(scenario.id)


# ---------------------------------------------------------------- employees

def resolve_employee(employee_db_id: int) -> Tuple[DBBusiness, DBEmployee]:
    """Business + employee rows for a portal employee id, or 404."""
    db_employee = DBEmployee.query.get(employee_db_id)
    if not db_employee:
        raise BusinessAccessError('Employee not found.', 404)
    row = DBBusiness.query.get(db_employee.business_db_id)
    if not row:
        raise BusinessAccessError('Business not found.', 404)
    return row, db_employee


def require_employee_access(employee_db_id: int) -> Tuple[BusinessScenario, DBBusiness, DBEmployee]:
    """The caller must be that employee or the business owner."""
    user = _user()
    if not user:
        raise BusinessAccessError('Please sign in to continue.', 401)
    row, db_employee = resolve_employee(employee_db_id)
    is_self = user.linked_employee_id == db_employee.id
    if not is_self and not user_owns(row, user):
        raise BusinessAccessError("You don't have permission to view this employee.", 403)
    return load_scenario(row), row, db_employee


def require_coworker_access(business_ref: str) -> Tuple[BusinessScenario, DBBusiness]:
    """Any employee of the business (or its owner) may read shared data like the schedule."""
    user = _user()
    if not user:
        raise BusinessAccessError('Please sign in to continue.', 401)
    row = find_owned_by_ref(business_ref, user)
    if not row and user.linked_employee_id:
        emp = DBEmployee.query.get(user.linked_employee_id)
        if emp:
            candidate = DBBusiness.query.get(emp.business_db_id)
            if candidate and (candidate.business_id == business_ref or business_slug(candidate.name) == business_ref.lower()):
                row = candidate
    if not row:
        raise BusinessAccessError('Business not found.', 404)
    return load_scenario(row), row


def employee_portal_url(row: DBBusiness, db_employee: DBEmployee, page: str = 'schedule') -> str:
    return f"/employee/{business_slug(row.name)}/{db_employee.id}/{page}"


def default_landing_url(user: Optional[User] = None) -> str:
    """Where to send a user after login / when they hit '/app'."""
    user = user or _user()
    if not user:
        return '/demo/schedule'
    if user.linked_employee_id and not user.is_manager:
        emp = DBEmployee.query.get(user.linked_employee_id)
        if emp:
            row = DBBusiness.query.get(emp.business_db_id)
            if row:
                return employee_portal_url(row, emp)
    row = ensure_user_has_business(user)
    return f"/{business_slug(row.name)}/schedule"


# ---------------------------------------------------------------- time off

def scenario_with_time_off(scenario: BusinessScenario, week_start: date) -> BusinessScenario:
    """Deep-copy the scenario and block approved time off for the given week.

    The copy is what the solver sees; the original (and the database) are
    untouched, so time off from one week never leaks into another.
    """
    working = copy.deepcopy(scenario)
    if is_demo_id(scenario.id):
        return working
    row = db_service.get_db_business(scenario.id)
    if not row:
        return working
    week_end = week_start + timedelta(days=6)
    approved = PTORequest.query.filter(
        PTORequest.business_db_id == row.id,
        PTORequest.status == 'approved',
        PTORequest.start_date <= week_end,
        PTORequest.end_date >= week_start,
    ).all()
    if not approved:
        return working
    blocked: Dict[str, set] = {}
    for req in approved:
        day = max(req.start_date, week_start)
        last = min(req.end_date, week_end)
        while day <= last:
            blocked.setdefault(req.employee_id, set()).add(day.weekday())
            day += timedelta(days=1)
    for emp in working.employees:
        for d in blocked.get(emp.id, ()):
            emp.add_time_off(d)
    return working
