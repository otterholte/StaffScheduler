"""Data models for the advanced staff scheduler."""

from dataclasses import dataclass, field
from typing import Dict, List, Set, Tuple, Optional
from enum import Enum


class EmployeeClassification(Enum):
    """Employee work classification."""
    FULL_TIME = "full_time"
    PART_TIME = "part_time"


class CoverageMode(Enum):
    """How coverage requirements are defined."""
    SHIFTS = "shifts"      # Simple: named shifts with roles
    DETAILED = "detailed"  # Detailed: hour-by-hour grid


@dataclass
class TimeSlot:
    """Represents a single hour slot that can be worked."""
    day: int  # 0=Monday, 6=Sunday
    hour: int  # Operating hour (e.g., 8 for 8AM)
    
    def __hash__(self):
        return hash((self.day, self.hour))
    
    def __eq__(self, other):
        if not isinstance(other, TimeSlot):
            return False
        return self.day == other.day and self.hour == other.hour
    
    def to_dict(self) -> dict:
        return {"day": self.day, "hour": self.hour}


@dataclass
class Role:
    """Represents a job role/position."""
    id: str
    name: str
    color: str
    
    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "color": self.color
        }


@dataclass
class CoverageRequirement:
    """Defines staffing requirements for a specific time slot and role."""
    day: int
    hour: int
    role_id: str
    min_staff: int  # Minimum required
    max_staff: int = 99  # Maximum allowed (cost control)
    is_peak: bool = False  # Whether this is a peak hour
    
    def to_dict(self) -> dict:
        return {
            "day": self.day,
            "hour": self.hour,
            "role_id": self.role_id,
            "min_staff": self.min_staff,
            "max_staff": self.max_staff,
            "is_peak": self.is_peak
        }


@dataclass
class PeakPeriod:
    """Defines a peak hour period (e.g., morning rush, lunch rush)."""
    name: str
    start_hour: int
    end_hour: int
    days: List[int] = field(default_factory=lambda: list(range(7)))  # Which days this applies
    
    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "start_hour": self.start_hour,
            "end_hour": self.end_hour,
            "days": self.days
        }
    
    def includes(self, day: int, hour: int) -> bool:
        """Check if a given day/hour falls within this peak period."""
        return day in self.days and self.start_hour <= hour < self.end_hour


@dataclass
class ShiftRoleRequirement:
    """Defines how many of a specific role are needed for a shift."""
    role_id: str
    count: int  # Minimum required
    max_count: int = 0  # Maximum allowed (0 means same as count)
    
    def to_dict(self) -> dict:
        return {
            "role_id": self.role_id,
            "count": self.count,
            "max_count": self.max_count if self.max_count > 0 else self.count
        }


@dataclass
class ShiftTemplate:
    """A named shift template with time range and role requirements.
    
    Used in SHIFTS mode for simple coverage definition.
    Example: "Morning Rush" from 6am-11am needs 1 Shift Lead + 2 Baristas
    """
    id: str
    name: str
    start_hour: int
    end_hour: int
    roles: List[ShiftRoleRequirement] = field(default_factory=list)
    days: List[int] = field(default_factory=lambda: list(range(7)))  # Days this shift applies
    color: str = "#6366f1"  # Visual color for the shift
    
    @property
    def duration(self) -> int:
        return self.end_hour - self.start_hour
    
    def applies_to_day(self, day: int) -> bool:
        return day in self.days
    
    def get_role_count(self, role_id: str) -> int:
        """Get the number of staff needed for a specific role in this shift."""
        for role_req in self.roles:
            if role_req.role_id == role_id:
                return role_req.count
        return 0
    
    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "start_hour": self.start_hour,
            "end_hour": self.end_hour,
            "roles": [r.to_dict() for r in self.roles],
            "days": self.days,
            "duration": self.duration,
            "color": self.color
        }


@dataclass
class RoleCoverageConfig:
    """Defines coverage configuration for a role - much easier to work with than individual requirements."""
    role_id: str
    
    # Default staffing level (applies to all operating hours unless overridden)
    default_min_staff: int = 1
    default_max_staff: int = 3
    
    # Peak hour boost (adds to default during peak periods)
    peak_boost: int = 0  # e.g., +1 during peak
    
    # Time-based requirements - if set, role is only required during these hours
    # Format: list of {"start_hour": X, "end_hour": Y}
    # If empty, role is required all operating hours
    required_hours: List[Dict] = field(default_factory=list)
    
    # Days this role is required (empty = all open days)
    required_days: List[int] = field(default_factory=list)
    
    def to_dict(self) -> dict:
        return {
            "role_id": self.role_id,
            "default_min_staff": self.default_min_staff,
            "default_max_staff": self.default_max_staff,
            "peak_boost": self.peak_boost,
            "required_hours": self.required_hours,
            "required_days": self.required_days
        }
    
    def is_required_at(self, day: int, hour: int, days_open: List[int], start_hour: int, end_hour: int) -> bool:
        """Check if this role is required at a specific day/hour."""
        # Check day requirements
        if self.required_days:
            if day not in self.required_days:
                return False
        elif day not in days_open:
            return False
        
        # Check hour requirements
        if self.required_hours:
            for period in self.required_hours:
                if period["start_hour"] <= hour < period["end_hour"]:
                    return True
            return False
        
        # If no specific hours, required during all operating hours
        return start_hour <= hour < end_hour
    
    def get_staff_count(self, is_peak: bool) -> tuple:
        """Get (min_staff, max_staff) for this role, considering if it's peak time."""
        min_staff = self.default_min_staff
        max_staff = self.default_max_staff
        
        if is_peak and self.peak_boost > 0:
            min_staff += self.peak_boost
            max_staff += self.peak_boost
        
        return min_staff, max_staff


@dataclass
class Employee:
    """Represents an employee with all scheduling attributes."""
    id: str
    name: str
    
    # Contact info (for portal invitations)
    email: str = None
    phone: str = None
    
    # Classification
    classification: EmployeeClassification = EmployeeClassification.PART_TIME
    
    # Hour constraints
    min_hours: int = 15
    max_hours: int = 25
    
    # Roles this employee can fill
    roles: List[str] = field(default_factory=list)
    
    # Availability and preferences
    availability: Set[TimeSlot] = field(default_factory=set)  # Hard: can work
    preferences: Set[TimeSlot] = field(default_factory=set)   # Soft: wants to work
    time_off: Set[TimeSlot] = field(default_factory=set)      # Hard: blocked
    
    # Supervision
    needs_supervision: bool = False  # Must work with experienced staff
    can_supervise: bool = False      # Can supervise others
    
    # Overtime
    overtime_allowed: bool = False   # Can exceed 40 hours
    
    # Cost tracking
    hourly_rate: float = 15.0
    
    # Fairness tracking (updated externally)
    weekend_shifts_worked: int = 0
    
    # Display
    color: str = "#4CAF50"
    
    def is_available(self, day: int, hour: int) -> bool:
        """Check if employee is available at a specific time (not on time-off)."""
        slot = TimeSlot(day, hour)
        return slot in self.availability and slot not in self.time_off
    
    def prefers(self, day: int, hour: int) -> bool:
        """Check if employee prefers to work at this time."""
        return TimeSlot(day, hour) in self.preferences
    
    def is_blocked(self, day: int, hour: int) -> bool:
        """Check if employee has time-off for this slot."""
        return TimeSlot(day, hour) in self.time_off
    
    def has_role(self, role_id: str) -> bool:
        """Check if employee can fill a specific role."""
        return role_id in self.roles
    
    def add_availability(self, day: int, start_hour: int, end_hour: int):
        """Add availability for a range of hours on a specific day."""
        for hour in range(start_hour, end_hour):
            self.availability.add(TimeSlot(day, hour))
    
    def add_preference(self, day: int, start_hour: int, end_hour: int):
        """Add preferred hours for a specific day."""
        for hour in range(start_hour, end_hour):
            self.preferences.add(TimeSlot(day, hour))
    
    def add_time_off(self, day: int, start_hour: int = None, end_hour: int = None):
        """Block time off. If no hours specified, blocks entire day."""
        if start_hour is None or end_hour is None:
            # Block all possible hours (0-23) for the day
            for hour in range(24):
                self.time_off.add(TimeSlot(day, hour))
        else:
            for hour in range(start_hour, end_hour):
                self.time_off.add(TimeSlot(day, hour))
    
    @property
    def is_full_time(self) -> bool:
        return self.classification == EmployeeClassification.FULL_TIME
    
    @property
    def max_consecutive_days_preferred(self) -> int:
        """Soft preference for max consecutive days."""
        return 5 if self.is_full_time else 3
    
    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "email": self.email,
            "phone": self.phone,
            "classification": self.classification.value,
            "min_hours": self.min_hours,
            "max_hours": self.max_hours,
            "roles": self.roles,
            "availability": [slot.to_dict() for slot in sorted(self.availability, key=lambda s: (s.day, s.hour))],
            "preferences": [slot.to_dict() for slot in sorted(self.preferences, key=lambda s: (s.day, s.hour))],
            "time_off": [slot.to_dict() for slot in sorted(self.time_off, key=lambda s: (s.day, s.hour))],
            "needs_supervision": self.needs_supervision,
            "can_supervise": self.can_supervise,
            "overtime_allowed": self.overtime_allowed,
            "hourly_rate": self.hourly_rate,
            "weekend_shifts_worked": self.weekend_shifts_worked,
            "color": self.color
        }


@dataclass
class ShiftAssignment:
    """Represents an assigned shift for an employee."""
    employee_id: str
    employee_name: str
    day: int
    start_hour: int
    end_hour: int
    role_id: str = ""
    color: str = "#4CAF50"
    
    @property
    def duration(self) -> int:
        return self.end_hour - self.start_hour
    
    def to_dict(self) -> dict:
        return {
            "employee_id": self.employee_id,
            "employee_name": self.employee_name,
            "day": self.day,
            "start_hour": self.start_hour,
            "end_hour": self.end_hour,
            "duration": self.duration,
            "role_id": self.role_id,
            "color": self.color
        }


@dataclass
class ScheduleMetrics:
    """Tracks schedule quality metrics."""
    # Coverage
    total_slots_required: int = 0
    total_slots_filled: int = 0
    
    # Unfilled details
    unfilled_slots: List[Dict] = field(default_factory=list)  # List of {day, hour, role_id, needed}
    unfilled_by_role: Dict[str, int] = field(default_factory=dict)  # role_id -> count
    unfilled_by_day: Dict[int, int] = field(default_factory=dict)   # day -> count
    total_hours_still_needed: int = 0
    
    # Cost
    total_regular_hours: int = 0
    total_overtime_hours: int = 0
    estimated_labor_cost: float = 0.0
    
    # Fairness
    weekend_distribution: Dict[str, int] = field(default_factory=dict)
    
    # Soft constraint violations
    preference_matches: int = 0
    preference_misses: int = 0
    consecutive_day_violations: int = 0
    
    # Supervision
    unsupervised_violations: int = 0
    
    def to_dict(self) -> dict:
        return {
            "total_slots_required": self.total_slots_required,
            "total_slots_filled": self.total_slots_filled,
            "coverage_percentage": round((self.total_slots_filled / max(1, self.total_slots_required)) * 100, 1),
            "unfilled_slots": self.unfilled_slots,
            "unfilled_by_role": self.unfilled_by_role,
            "unfilled_by_day": self.unfilled_by_day,
            "total_hours_still_needed": self.total_hours_still_needed,
            "total_regular_hours": self.total_regular_hours,
            "total_overtime_hours": self.total_overtime_hours,
            "estimated_labor_cost": round(self.estimated_labor_cost, 2),
            "weekend_distribution": self.weekend_distribution,
            "preference_matches": self.preference_matches,
            "preference_misses": self.preference_misses,
            "consecutive_day_violations": self.consecutive_day_violations,
            "unsupervised_violations": self.unsupervised_violations
        }


@dataclass 
class Schedule:
    """Represents a complete weekly schedule solution."""
    assignments: List[ShiftAssignment] = field(default_factory=list)
    
    # Coverage: (day, hour, role) -> employee_id
    coverage_matrix: Dict[Tuple[int, int, str], str] = field(default_factory=dict)
    
    # Simple coverage for display: (day, hour) -> list of (employee_id, role_id)
    slot_assignments: Dict[Tuple[int, int], List[Tuple[str, str]]] = field(default_factory=dict)
    
    # Hours tracking
    total_hours_needed: int = 0
    total_hours_filled: int = 0
    employee_hours: Dict[str, int] = field(default_factory=dict)
    employee_overtime: Dict[str, int] = field(default_factory=dict)
    
    # Quality metrics
    metrics: ScheduleMetrics = field(default_factory=ScheduleMetrics)
    
    # Consecutive days per employee
    consecutive_days: Dict[str, int] = field(default_factory=dict)
    
    # Status
    is_feasible: bool = False
    solve_time_ms: float = 0.0
    solution_index: int = 0
    objective_value: int = 0
    
    @property
    def coverage_percentage(self) -> float:
        if self.total_hours_needed == 0:
            return 0.0
        return (self.total_hours_filled / self.total_hours_needed) * 100
    
    def get_uncovered_slots(self, requirements: List[CoverageRequirement]) -> List[Tuple[int, int, str]]:
        """Get list of (day, hour, role) tuples that are not adequately covered."""
        uncovered = []
        for req in requirements:
            key = (req.day, req.hour, req.role_id)
            if key not in self.coverage_matrix:
                uncovered.append(key)
        return uncovered
    
    def to_dict(self) -> dict:
        # Convert coverage matrix to string keys for JSON
        coverage_dict = {}
        for (d, h, r), emp_id in self.coverage_matrix.items():
            coverage_dict[f"{d},{h},{r}"] = emp_id
        
        # Convert slot assignments
        slots_dict = {}
        for (d, h), assignments in self.slot_assignments.items():
            slots_dict[f"{d},{h}"] = [{"employee_id": e, "role_id": r} for e, r in assignments]
        
        return {
            "assignments": [a.to_dict() for a in self.assignments],
            "coverage_matrix": coverage_dict,
            "slot_assignments": slots_dict,
            "total_hours_needed": self.total_hours_needed,
            "total_hours_filled": self.total_hours_filled,
            "coverage_percentage": round(self.coverage_percentage, 1),
            "employee_hours": self.employee_hours,
            "employee_overtime": self.employee_overtime,
            "consecutive_days": self.consecutive_days,
            "metrics": self.metrics.to_dict(),
            "is_feasible": self.is_feasible,
            "solve_time_ms": round(self.solve_time_ms, 2),
            "solution_index": self.solution_index,
            "objective_value": self.objective_value
        }


@dataclass
class BusinessScenario:
    """Represents a complete business configuration for testing."""
    id: str
    name: str
    description: str
    
    # Operating parameters
    start_hour: int
    end_hour: int
    days_open: List[int]  # 0-6 for Mon-Sun
    
    # Roles
    roles: List[Role] = field(default_factory=list)
    
    # Employees
    employees: List[Employee] = field(default_factory=list)
    
    # Coverage requirements (can be auto-generated from configs or shifts)
    coverage_requirements: List[CoverageRequirement] = field(default_factory=list)
    
    # Peak periods for this business
    peak_periods: List[PeakPeriod] = field(default_factory=list)
    
    # Role coverage configurations (for DETAILED mode)
    role_coverage_configs: List[RoleCoverageConfig] = field(default_factory=list)
    
    # NEW: Coverage mode - "shifts" or "detailed"
    coverage_mode: CoverageMode = CoverageMode.SHIFTS
    
    # NEW: Shift templates (for SHIFTS mode)
    shift_templates: List[ShiftTemplate] = field(default_factory=list)
    
    # NEW: Has user completed initial setup? (shows onboarding if False)
    has_completed_setup: bool = True
    
    def get_operating_hours(self) -> range:
        return range(self.start_hour, self.end_hour)
    
    def get_role_by_id(self, role_id: str) -> Optional[Role]:
        for role in self.roles:
            if role.id == role_id:
                return role
        return None
    
    def is_peak_hour(self, day: int, hour: int) -> bool:
        """Check if a given day/hour falls within any peak period."""
        for period in self.peak_periods:
            if period.includes(day, hour):
                return True
        return False
    
    def get_role_config(self, role_id: str) -> Optional[RoleCoverageConfig]:
        """Get the coverage configuration for a specific role."""
        for config in self.role_coverage_configs:
            if config.role_id == role_id:
                return config
        return None
    
    def generate_coverage_from_shifts(self) -> List[CoverageRequirement]:
        """Generate coverage requirements from shift templates.
        
        Used in SHIFTS mode - converts named shifts to individual requirements.
        """
        if not self.shift_templates:
            return []
        
        # Build a dict to aggregate requirements by (day, hour, role)
        # This handles overlapping shifts by summing staff counts
        # Store both min and max counts
        req_map: Dict[Tuple[int, int, str], Tuple[int, int]] = {}
        
        for shift in self.shift_templates:
            for day in shift.days:
                if day not in self.days_open:
                    continue
                for hour in range(shift.start_hour, shift.end_hour):
                    if hour < self.start_hour or hour >= self.end_hour:
                        continue
                    for role_req in shift.roles:
                        key = (day, hour, role_req.role_id)
                        max_count = role_req.max_count if role_req.max_count > 0 else role_req.count
                        if key not in req_map:
                            req_map[key] = (0, 0)
                        current_min, current_max = req_map[key]
                        req_map[key] = (current_min + role_req.count, current_max + max_count)
        
        # Convert to CoverageRequirement objects
        requirements = []
        for (day, hour, role_id), (min_count, max_count) in req_map.items():
            is_peak = self.is_peak_hour(day, hour)
            requirements.append(CoverageRequirement(
                day=day,
                hour=hour,
                role_id=role_id,
                min_staff=min_count,
                max_staff=max_count,
                is_peak=is_peak
            ))
        
        return requirements
    
    def generate_coverage_from_detailed(self) -> List[CoverageRequirement]:
        """Generate coverage requirements from role configs (detailed mode).
        
        This allows for a much simpler way to configure coverage:
        - Set default staff levels per role
        - Define peak periods
        - Define when each role is needed
        
        The system automatically generates all the individual time/day/role requirements.
        """
        if not self.role_coverage_configs:
            return []
        
        requirements = []
        
        for day in self.days_open:
            for hour in range(self.start_hour, self.end_hour):
                is_peak = self.is_peak_hour(day, hour)
                
                for config in self.role_coverage_configs:
                    # Check if this role is required at this time
                    if config.is_required_at(day, hour, self.days_open, self.start_hour, self.end_hour):
                        min_staff, max_staff = config.get_staff_count(is_peak)
                        
                        requirements.append(CoverageRequirement(
                            day=day,
                            hour=hour,
                            role_id=config.role_id,
                            min_staff=min_staff,
                            max_staff=max_staff,
                            is_peak=is_peak
                        ))
        
        return requirements
    
    def generate_coverage_requirements(self) -> List[CoverageRequirement]:
        """Generate coverage requirements based on current mode.
        
        Automatically chooses between shift-based and detailed generation.
        """
        if self.coverage_mode == CoverageMode.SHIFTS:
            return self.generate_coverage_from_shifts()
        elif self.coverage_mode == CoverageMode.DETAILED:
            return self.generate_coverage_from_detailed()
        else:
            # Fallback to existing requirements
            return self.coverage_requirements
    
    def rebuild_coverage_requirements(self):
        """Regenerate coverage requirements from configs and update in place."""
        if self.role_coverage_configs:
            self.coverage_requirements = self.generate_coverage_requirements()
    
    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "start_hour": self.start_hour,
            "end_hour": self.end_hour,
            "days_open": self.days_open,
            "roles": [r.to_dict() for r in self.roles],
            "employees": [e.to_dict() for e in self.employees],
            "coverage_requirements": [c.to_dict() for c in self.coverage_requirements],
            "peak_periods": [p.to_dict() for p in self.peak_periods],
            "role_coverage_configs": [c.to_dict() for c in self.role_coverage_configs],
            "coverage_mode": self.coverage_mode.value,
            "shift_templates": [s.to_dict() for s in self.shift_templates],
            "has_completed_setup": self.has_completed_setup,
            "total_employees": len(self.employees),
            "total_roles": len(self.roles)
        }
