"""Staff scheduling engine: data models, demo businesses, and the CP-SAT solver."""

from .models import (
    Employee,
    TimeSlot,
    AvailabilityRange,
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
    ShiftRoleRequirement,
)
from .solver import AdvancedScheduleSolver, ScheduleSolver, format_schedule
from .businesses import (
    DEMO_BUSINESS_IDS,
    DEMO_META,
    get_demo_business,
    list_demo_businesses,
    reset_demo_business,
    get_all_businesses,
    get_business_by_id,
    DAYS_OF_WEEK,
)

__all__ = [
    'Employee', 'TimeSlot', 'AvailabilityRange', 'Schedule', 'Role', 'CoverageRequirement',
    'BusinessScenario', 'EmployeeClassification', 'ScheduleMetrics', 'ShiftAssignment',
    'PeakPeriod', 'RoleCoverageConfig', 'CoverageMode', 'ShiftTemplate', 'ShiftRoleRequirement',
    'AdvancedScheduleSolver', 'ScheduleSolver', 'format_schedule',
    'DEMO_BUSINESS_IDS', 'DEMO_META', 'get_demo_business', 'list_demo_businesses',
    'reset_demo_business', 'get_all_businesses', 'get_business_by_id', 'DAYS_OF_WEEK',
]
