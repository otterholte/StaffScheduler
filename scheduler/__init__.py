"""Advanced Staff Scheduler Package - OR-Tools powered optimization engine."""

from .models import (
    Employee, 
    TimeSlot, 
    Schedule,
    Role,
    CoverageRequirement,
    BusinessScenario,
    EmployeeClassification,
    ScheduleMetrics,
    ShiftAssignment,
    PeakPeriod,
    RoleCoverageConfig,
    CoverageMode,
    ShiftTemplate,
    ShiftRoleRequirement
)
from .solver import AdvancedScheduleSolver, ScheduleSolver, format_schedule
from .businesses import (
    get_all_businesses,
    get_business_by_id,
    DAYS_OF_WEEK
)
from .sample_data import (
    get_sample_employees,
    OPERATING_HOURS,
    NUM_DAYS
)

__all__ = [
    # Models
    'Employee',
    'TimeSlot', 
    'Schedule',
    'Role',
    'CoverageRequirement',
    'BusinessScenario',
    'EmployeeClassification',
    'ScheduleMetrics',
    'ShiftAssignment',
    
    # Solver
    'AdvancedScheduleSolver',
    'ScheduleSolver',
    'format_schedule',
    
    # Business scenarios
    'get_all_businesses',
    'get_business_by_id',
    
    # Compatibility
    'get_sample_employees',
    'OPERATING_HOURS',
    'NUM_DAYS',
    'DAYS_OF_WEEK'
]
