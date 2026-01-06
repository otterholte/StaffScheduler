"""
Database service for persisting business data.

Handles conversion between scheduler dataclass models and SQLAlchemy database models.
Provides CRUD operations for businesses, employees, roles, shifts, and schedules.
"""

from datetime import datetime, date, timedelta
from typing import Optional, List, Dict
import json

from models import (
    db, DBBusiness, DBEmployee, DBRole, DBShiftTemplate, 
    DBSchedule, DBShiftAssignment, generate_uuid
)
from scheduler.models import (
    BusinessScenario, Employee, Role, TimeSlot, EmployeeClassification,
    ShiftTemplate, ShiftRoleRequirement, CoverageMode, Schedule, ShiftAssignment
)


# =============================================================================
# BUSINESS OPERATIONS
# =============================================================================

def get_db_business(business_id: str) -> Optional[DBBusiness]:
    """Get a database business by its string ID."""
    return DBBusiness.query.filter_by(business_id=business_id).first()


def get_user_db_business(user_id: int) -> Optional[DBBusiness]:
    """Get the database business owned by a user."""
    return DBBusiness.query.filter_by(owner_id=user_id).first()


def save_business_to_db(scenario: BusinessScenario, owner_id: int) -> DBBusiness:
    """
    Save a BusinessScenario to the database.
    Creates or updates the business and all related data.
    """
    db_business = get_db_business(scenario.id)
    
    if db_business is None:
        # Create new business
        db_business = DBBusiness(
            business_id=scenario.id,
            owner_id=owner_id,
            name=scenario.name,
            description=scenario.description,
            start_hour=scenario.start_hour,
            end_hour=scenario.end_hour,
            coverage_mode=scenario.coverage_mode.value,
            has_completed_setup=scenario.has_completed_setup
        )
        db_business.set_days_open_list(scenario.days_open)
        db.session.add(db_business)
        db.session.flush()  # Get the ID
    else:
        # Update existing business
        db_business.name = scenario.name
        db_business.description = scenario.description
        db_business.start_hour = scenario.start_hour
        db_business.end_hour = scenario.end_hour
        db_business.coverage_mode = scenario.coverage_mode.value
        db_business.has_completed_setup = scenario.has_completed_setup
        db_business.set_days_open_list(scenario.days_open)
    
    # Save roles
    _save_roles_to_db(db_business, scenario.roles)
    
    # Save employees
    _save_employees_to_db(db_business, scenario.employees)
    
    # Save shift templates
    _save_shift_templates_to_db(db_business, scenario.shift_templates)
    
    db.session.commit()
    return db_business


def load_business_from_db(db_business: DBBusiness) -> BusinessScenario:
    """
    Load a BusinessScenario from the database.
    Reconstructs the full dataclass model from DB data.
    """
    # Load roles
    roles = [_db_role_to_model(r) for r in db_business.roles]
    
    # Load employees
    employees = [_db_employee_to_model(e) for e in db_business.employees]
    
    # Load shift templates
    shift_templates = [_db_shift_template_to_model(s) for s in db_business.shift_templates]
    
    # Determine coverage mode
    try:
        coverage_mode = CoverageMode(db_business.coverage_mode)
    except ValueError:
        coverage_mode = CoverageMode.SHIFTS
    
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
        coverage_mode=coverage_mode,
        has_completed_setup=db_business.has_completed_setup
    )
    
    # Generate coverage requirements from configuration
    scenario.coverage_requirements = scenario.generate_coverage_requirements()
    
    return scenario


def delete_business_from_db(business_id: str) -> bool:
    """Delete a business and all related data from the database."""
    db_business = get_db_business(business_id)
    if db_business:
        db.session.delete(db_business)
        db.session.commit()
        return True
    return False


def update_business_metadata(business_id: str, name: str = None, emoji: str = None, color: str = None) -> bool:
    """Update business metadata (name, emoji, color)."""
    db_business = get_db_business(business_id)
    if db_business:
        if name is not None:
            db_business.name = name
        if emoji is not None:
            db_business.emoji = emoji
        if color is not None:
            db_business.color = color
        db.session.commit()
        return True
    return False


# =============================================================================
# ROLE OPERATIONS
# =============================================================================

def _save_roles_to_db(db_business: DBBusiness, roles: List[Role]):
    """Save roles to the database for a business."""
    # Get existing role IDs
    existing_role_ids = {r.role_id for r in db_business.roles}
    new_role_ids = {r.id for r in roles}
    
    # Delete removed roles
    for db_role in db_business.roles[:]:
        if db_role.role_id not in new_role_ids:
            db.session.delete(db_role)
    
    # Add or update roles
    for role in roles:
        db_role = DBRole.query.filter_by(
            business_db_id=db_business.id, 
            role_id=role.id
        ).first()
        
        if db_role is None:
            db_role = DBRole(
                role_id=role.id,
                business_db_id=db_business.id,
                name=role.name,
                color=role.color
            )
            db.session.add(db_role)
        else:
            db_role.name = role.name
            db_role.color = role.color


def _db_role_to_model(db_role: DBRole) -> Role:
    """Convert a DBRole to a Role dataclass."""
    return Role(
        id=db_role.role_id,
        name=db_role.name,
        color=db_role.color
    )


def add_role_to_db(business_id: str, role: Role) -> bool:
    """Add a single role to a business."""
    db_business = get_db_business(business_id)
    if not db_business:
        return False
    
    existing = DBRole.query.filter_by(
        business_db_id=db_business.id,
        role_id=role.id
    ).first()
    
    if existing:
        existing.name = role.name
        existing.color = role.color
    else:
        db_role = DBRole(
            role_id=role.id,
            business_db_id=db_business.id,
            name=role.name,
            color=role.color
        )
        db.session.add(db_role)
    
    db.session.commit()
    return True


def delete_role_from_db(business_id: str, role_id: str) -> bool:
    """Delete a role from a business."""
    db_business = get_db_business(business_id)
    if not db_business:
        return False
    
    db_role = DBRole.query.filter_by(
        business_db_id=db_business.id,
        role_id=role_id
    ).first()
    
    if db_role:
        db.session.delete(db_role)
        db.session.commit()
        return True
    return False


# =============================================================================
# EMPLOYEE OPERATIONS
# =============================================================================

def _save_employees_to_db(db_business: DBBusiness, employees: List[Employee]):
    """Save employees to the database for a business."""
    existing_emp_ids = {e.employee_id for e in db_business.employees}
    new_emp_ids = {e.id for e in employees}
    
    # Delete removed employees
    for db_emp in db_business.employees[:]:
        if db_emp.employee_id not in new_emp_ids:
            db.session.delete(db_emp)
    
    # Add or update employees
    for emp in employees:
        _save_single_employee_to_db(db_business.id, emp)


def _save_single_employee_to_db(business_db_id: int, emp: Employee):
    """Save a single employee to the database."""
    db_emp = DBEmployee.query.filter_by(
        business_db_id=business_db_id,
        employee_id=emp.id
    ).first()
    
    if db_emp is None:
        db_emp = DBEmployee(
            employee_id=emp.id,
            business_db_id=business_db_id,
            name=emp.name
        )
        db.session.add(db_emp)
    
    # Update all fields
    db_emp.name = emp.name
    db_emp.email = emp.email
    db_emp.phone = emp.phone
    db_emp.color = emp.color
    db_emp.classification = emp.classification.value
    db_emp.min_hours = emp.min_hours
    db_emp.max_hours = emp.max_hours
    db_emp.set_roles_list(emp.roles)
    db_emp.needs_supervision = emp.needs_supervision
    db_emp.can_supervise = emp.can_supervise
    db_emp.overtime_allowed = emp.overtime_allowed
    db_emp.hourly_rate = emp.hourly_rate
    db_emp.weekend_shifts_worked = emp.weekend_shifts_worked
    
    # Save availability
    avail_data = {
        'availability': [{'day': s.day, 'hour': s.hour} for s in emp.availability],
        'preferences': [{'day': s.day, 'hour': s.hour} for s in emp.preferences],
        'time_off': [{'day': s.day, 'hour': s.hour} for s in emp.time_off]
    }
    db_emp.set_availability_data(avail_data)


def _db_employee_to_model(db_emp: DBEmployee) -> Employee:
    """Convert a DBEmployee to an Employee dataclass."""
    # Parse classification
    try:
        classification = EmployeeClassification(db_emp.classification)
    except ValueError:
        classification = EmployeeClassification.PART_TIME
    
    # Parse availability
    avail_data = db_emp.get_availability_data()
    availability = {TimeSlot(s['day'], s['hour']) for s in avail_data.get('availability', [])}
    preferences = {TimeSlot(s['day'], s['hour']) for s in avail_data.get('preferences', [])}
    time_off = {TimeSlot(s['day'], s['hour']) for s in avail_data.get('time_off', [])}
    
    return Employee(
        id=db_emp.employee_id,
        name=db_emp.name,
        email=db_emp.email,
        phone=db_emp.phone,
        color=db_emp.color,
        classification=classification,
        min_hours=db_emp.min_hours,
        max_hours=db_emp.max_hours,
        roles=db_emp.get_roles_list(),
        availability=availability,
        preferences=preferences,
        time_off=time_off,
        needs_supervision=db_emp.needs_supervision,
        can_supervise=db_emp.can_supervise,
        overtime_allowed=db_emp.overtime_allowed,
        hourly_rate=db_emp.hourly_rate,
        weekend_shifts_worked=db_emp.weekend_shifts_worked
    )


def add_employee_to_db(business_id: str, employee: Employee) -> bool:
    """Add a single employee to a business in the database."""
    db_business = get_db_business(business_id)
    if not db_business:
        return False
    
    _save_single_employee_to_db(db_business.id, employee)
    db.session.commit()
    return True


def update_employee_in_db(business_id: str, employee: Employee) -> bool:
    """Update an existing employee in the database."""
    return add_employee_to_db(business_id, employee)  # Same logic


def delete_employee_from_db(business_id: str, employee_id: str) -> bool:
    """Delete an employee from a business in the database."""
    db_business = get_db_business(business_id)
    if not db_business:
        return False
    
    db_emp = DBEmployee.query.filter_by(
        business_db_id=db_business.id,
        employee_id=employee_id
    ).first()
    
    if db_emp:
        db.session.delete(db_emp)
        db.session.commit()
        return True
    return False


def get_employee_from_db(business_id: str, employee_id: str) -> Optional[Employee]:
    """Get a single employee from the database."""
    db_business = get_db_business(business_id)
    if not db_business:
        return None
    
    db_emp = DBEmployee.query.filter_by(
        business_db_id=db_business.id,
        employee_id=employee_id
    ).first()
    
    if db_emp:
        return _db_employee_to_model(db_emp)
    return None


# =============================================================================
# SHIFT TEMPLATE OPERATIONS
# =============================================================================

def _save_shift_templates_to_db(db_business: DBBusiness, templates: List[ShiftTemplate]):
    """Save shift templates to the database for a business."""
    existing_ids = {s.shift_id for s in db_business.shift_templates}
    new_ids = {s.id for s in templates}
    
    # Delete removed templates
    for db_shift in db_business.shift_templates[:]:
        if db_shift.shift_id not in new_ids:
            db.session.delete(db_shift)
    
    # Add or update templates
    for shift in templates:
        db_shift = DBShiftTemplate.query.filter_by(
            business_db_id=db_business.id,
            shift_id=shift.id
        ).first()
        
        if db_shift is None:
            db_shift = DBShiftTemplate(
                shift_id=shift.id,
                business_db_id=db_business.id,
                name=shift.name,
                start_hour=shift.start_hour,
                end_hour=shift.end_hour,
                color=shift.color
            )
            db.session.add(db_shift)
        else:
            db_shift.name = shift.name
            db_shift.start_hour = shift.start_hour
            db_shift.end_hour = shift.end_hour
            db_shift.color = shift.color
        
        db_shift.set_days_list(shift.days)
        
        # Save role requirements
        roles_data = [{'role_id': r.role_id, 'count': r.count, 'max_count': r.max_count} 
                      for r in shift.roles]
        db_shift.set_roles_requirements(roles_data)


def _db_shift_template_to_model(db_shift: DBShiftTemplate) -> ShiftTemplate:
    """Convert a DBShiftTemplate to a ShiftTemplate dataclass."""
    roles_data = db_shift.get_roles_requirements()
    roles = [
        ShiftRoleRequirement(
            role_id=r['role_id'],
            count=r.get('count', 1),
            max_count=r.get('max_count', 0)
        )
        for r in roles_data
    ]
    
    return ShiftTemplate(
        id=db_shift.shift_id,
        name=db_shift.name,
        start_hour=db_shift.start_hour,
        end_hour=db_shift.end_hour,
        roles=roles,
        days=db_shift.get_days_list(),
        color=db_shift.color
    )


# =============================================================================
# SCHEDULE OPERATIONS
# =============================================================================

def save_schedule_to_db(business_id: str, schedule: Schedule, week_start: date, status: str = 'draft') -> Optional[DBSchedule]:
    """Save a generated schedule to the database."""
    db_business = get_db_business(business_id)
    if not db_business:
        return None
    
    # Generate week ID
    week_id = week_start.strftime('%Y-W%V')
    
    # Check for existing schedule
    db_schedule = DBSchedule.query.filter_by(
        business_db_id=db_business.id,
        week_id=week_id
    ).first()
    
    if db_schedule is None:
        db_schedule = DBSchedule(
            business_db_id=db_business.id,
            week_id=week_id,
            week_start_date=week_start,
            status=status
        )
        db.session.add(db_schedule)
    else:
        db_schedule.status = status
    
    # Save schedule data
    db_schedule.set_schedule_data(schedule.to_dict())
    db_schedule.coverage_percentage = schedule.coverage_percentage
    db_schedule.total_hours_needed = schedule.total_hours_needed
    db_schedule.total_hours_filled = schedule.total_hours_filled
    
    if status == 'published':
        db_schedule.published_at = datetime.utcnow()
    
    db.session.flush()
    
    # Save individual assignments for querying
    # First delete existing assignments
    DBShiftAssignment.query.filter_by(schedule_id=db_schedule.id).delete()
    
    # Add new assignments
    for assignment in schedule.assignments:
        db_assignment = DBShiftAssignment(
            schedule_id=db_schedule.id,
            employee_id=assignment.employee_id,
            employee_name=assignment.employee_name,
            day=assignment.day,
            start_hour=assignment.start_hour,
            end_hour=assignment.end_hour,
            role_id=assignment.role_id,
            color=assignment.color
        )
        db.session.add(db_assignment)
    
    db.session.commit()
    return db_schedule


def get_schedule_from_db(business_id: str, week_start: date) -> Optional[Schedule]:
    """Get a schedule from the database."""
    db_business = get_db_business(business_id)
    if not db_business:
        return None
    
    week_id = week_start.strftime('%Y-W%V')
    
    db_schedule = DBSchedule.query.filter_by(
        business_db_id=db_business.id,
        week_id=week_id
    ).first()
    
    if db_schedule:
        return _db_schedule_to_model(db_schedule)
    return None


def get_published_schedule_from_db(business_id: str, week_start: date) -> Optional[Schedule]:
    """Get a published schedule from the database."""
    db_business = get_db_business(business_id)
    if not db_business:
        return None
    
    week_id = week_start.strftime('%Y-W%V')
    
    db_schedule = DBSchedule.query.filter_by(
        business_db_id=db_business.id,
        week_id=week_id,
        status='published'
    ).first()
    
    if db_schedule:
        return _db_schedule_to_model(db_schedule)
    return None


def _db_schedule_to_model(db_schedule: DBSchedule) -> Schedule:
    """Convert a DBSchedule to a Schedule dataclass."""
    data = db_schedule.get_schedule_data()
    
    # Reconstruct assignments
    assignments = []
    for a_data in data.get('assignments', []):
        assignment = ShiftAssignment(
            employee_id=a_data['employee_id'],
            employee_name=a_data['employee_name'],
            day=a_data['day'],
            start_hour=a_data['start_hour'],
            end_hour=a_data['end_hour'],
            role_id=a_data.get('role_id', ''),
            color=a_data.get('color', '#4CAF50')
        )
        assignments.append(assignment)
    
    # Reconstruct coverage matrix
    coverage_matrix = {}
    for key, emp_id in data.get('coverage_matrix', {}).items():
        parts = key.split(',')
        if len(parts) == 3:
            d, h, r = int(parts[0]), int(parts[1]), parts[2]
            coverage_matrix[(d, h, r)] = emp_id
    
    # Reconstruct slot assignments
    slot_assignments = {}
    for key, slot_list in data.get('slot_assignments', {}).items():
        parts = key.split(',')
        if len(parts) == 2:
            d, h = int(parts[0]), int(parts[1])
            slot_assignments[(d, h)] = [(s['employee_id'], s['role_id']) for s in slot_list]
    
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
        objective_value=data.get('objective_value', 0)
    )
    
    return schedule


def publish_schedule_in_db(business_id: str, week_start: date) -> bool:
    """Mark a schedule as published."""
    db_business = get_db_business(business_id)
    if not db_business:
        return False
    
    week_id = week_start.strftime('%Y-W%V')
    
    db_schedule = DBSchedule.query.filter_by(
        business_db_id=db_business.id,
        week_id=week_id
    ).first()
    
    if db_schedule:
        db_schedule.status = 'published'
        db_schedule.published_at = datetime.utcnow()
        db.session.commit()
        return True
    return False


def get_employee_shifts(business_id: str, employee_id: str, week_start: date) -> List[Dict]:
    """Get all shifts for an employee for a specific week."""
    db_business = get_db_business(business_id)
    if not db_business:
        return []
    
    week_id = week_start.strftime('%Y-W%V')
    
    db_schedule = DBSchedule.query.filter_by(
        business_db_id=db_business.id,
        week_id=week_id,
        status='published'
    ).first()
    
    if not db_schedule:
        return []
    
    shifts = DBShiftAssignment.query.filter_by(
        schedule_id=db_schedule.id,
        employee_id=employee_id
    ).order_by(DBShiftAssignment.day, DBShiftAssignment.start_hour).all()
    
    return [s.to_dict() for s in shifts]


# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================

def is_business_persisted(business_id: str) -> bool:
    """Check if a business exists in the database."""
    return get_db_business(business_id) is not None


def get_all_persisted_businesses() -> List[DBBusiness]:
    """Get all businesses from the database."""
    return DBBusiness.query.all()


def sync_business_to_db(scenario: BusinessScenario, owner_id: int):
    """
    Sync a BusinessScenario to the database.
    Call this after any changes to ensure persistence.
    """
    save_business_to_db(scenario, owner_id)

