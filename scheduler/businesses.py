"""
Business Scenarios for Staff Scheduler Testing.

Contains 5 different business types with varying sizes and complexity:
1. Coffee Shop (5 staff)
2. Retail Store (12 staff)
3. Restaurant (20 staff)
4. Call Center (35 staff)
5. Warehouse (50 staff)

Coverage requirements are calibrated to be achievable with the available staff.
"""

import random
from typing import List, Dict
from .models import (
    BusinessScenario, Employee, Role, CoverageRequirement,
    TimeSlot, EmployeeClassification, PeakPeriod, RoleCoverageConfig,
    CoverageMode, ShiftTemplate, ShiftRoleRequirement
)

# Days of week
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def _random_availability(
    days: List[int],
    start_hour: int,
    end_hour: int,
    is_full_time: bool,
    employee_index: int
) -> tuple:
    """Generate semi-random but realistic availability patterns."""
    availability = set()
    preferences = set()
    
    random.seed(employee_index * 42)
    
    if is_full_time:
        # Full-timers: available most days
        available_days = random.sample(days, min(len(days), random.randint(5, len(days))))
        for day in available_days:
            for hour in range(start_hour, end_hour):
                availability.add(TimeSlot(day, hour))
            if employee_index % 2 == 0:
                for hour in range(start_hour, min(start_hour + 5, end_hour)):
                    preferences.add(TimeSlot(day, hour))
            else:
                for hour in range(max(end_hour - 5, start_hour), end_hour):
                    preferences.add(TimeSlot(day, hour))
    else:
        num_days = random.randint(4, min(6, len(days)))
        available_days = random.sample(days, num_days)
        
        for day in available_days:
            pattern = employee_index % 3
            hours_in_day = end_hour - start_hour
            
            if pattern == 0:
                shift_start = start_hour
                shift_end = start_hour + min(8, hours_in_day)
            elif pattern == 1:
                shift_start = start_hour + hours_in_day // 3
                shift_end = min(shift_start + 6, end_hour)
            else:
                shift_end = end_hour
                shift_start = max(end_hour - 7, start_hour)
            
            for hour in range(shift_start, shift_end):
                availability.add(TimeSlot(day, hour))
                if shift_start + 1 <= hour < shift_end - 1:
                    preferences.add(TimeSlot(day, hour))
    
    return availability, preferences


# =============================================================================
# BUSINESS 1: COFFEE SHOP (5 staff)
# =============================================================================

def create_coffee_shop() -> BusinessScenario:
    """Small coffee shop: 6 employees, 2 roles, with shift-based coverage."""
    
    roles = [
        Role(id="barista", name="Barista", color="#06d6a0"),  # Mint green
        Role(id="shift_lead", name="Shift Lead", color="#264653")  # Dark Blue-Gray
    ]
    
    # Shift templates - the simple way to define coverage!
    # These named shifts are much easier for managers to understand
    shift_templates = [
        # Morning shift: 6am - 12pm, needs 1 shift lead + 1 barista
        ShiftTemplate(
            id="morning",
            name="Morning Shift",
            start_hour=6,
            end_hour=12,
            roles=[
                ShiftRoleRequirement("shift_lead", 1),
                ShiftRoleRequirement("barista", 1)
            ],
            days=list(range(7)),  # All days
            color="#f59e0b"  # Amber
        ),
        # Afternoon shift: 12pm - 6pm, needs 1 shift lead + 1 barista
        ShiftTemplate(
            id="afternoon",
            name="Afternoon Shift",
            start_hour=12,
            end_hour=18,
            roles=[
                ShiftRoleRequirement("shift_lead", 1),
                ShiftRoleRequirement("barista", 1)
            ],
            days=list(range(7)),  # All days
            color="#3b82f6"  # Blue
        ),
        # Busy hour boost: 7am - 9am, adds 1 extra barista (on top of morning shift)
        ShiftTemplate(
            id="busy_hours",
            name="Peak Hours (Extra)",
            start_hour=7,
            end_hour=9,
            roles=[
                ShiftRoleRequirement("barista", 1)  # +1 extra during busy times
            ],
            days=list(range(7)),  # All days
            color="#ef4444"  # Red
        )
    ]
    
    # Define peak periods (for visual indication)
    peak_periods = [
        PeakPeriod(name="Busy Hours", start_hour=7, end_hour=9, days=list(range(7))),
        PeakPeriod(name="Lunch Time", start_hour=12, end_hour=14, days=list(range(5)))
    ]
    
    # Role coverage configurations (for DETAILED mode - kept for switching)
    role_configs = [
        RoleCoverageConfig(
            role_id="shift_lead",
            default_min_staff=1,
            default_max_staff=1,
            peak_boost=0,
            required_hours=[],
            required_days=[]
        ),
        RoleCoverageConfig(
            role_id="barista",
            default_min_staff=1,
            default_max_staff=2,
            peak_boost=1,
            required_hours=[],
            required_days=[]
        )
    ]
    
    # Pre-generated coverage (will be regenerated from shifts)
    coverage = []
    
    employees = []
    
    # Maria - Full-time shift lead
    maria = Employee(
        id="maria_0", name="Maria",
        classification=EmployeeClassification.FULL_TIME,
        min_hours=30, max_hours=40,
        roles=["shift_lead", "barista"],
        can_supervise=True, needs_supervision=False,
        overtime_allowed=True, hourly_rate=18.0,
        color="#8338ec"  # Violet
    )
    for day in range(7):
        maria.add_availability(day, 6, 18)
        maria.add_preference(day, 6, 12)
    employees.append(maria)
    
    # Jake - Part-time shift lead
    jake = Employee(
        id="jake_1", name="Jake",
        classification=EmployeeClassification.PART_TIME,
        min_hours=15, max_hours=28,
        roles=["shift_lead", "barista"],
        can_supervise=True, needs_supervision=False,
        overtime_allowed=False, hourly_rate=17.0,
        color="#2a9d8f"  # Teal
    )
    for day in [0, 2, 4, 5, 6]:
        jake.add_availability(day, 6, 18)
    employees.append(jake)
    
    # Sam - Full-time shift lead (for testing coverage)
    sam = Employee(
        id="sam_5", name="Sam",
        classification=EmployeeClassification.FULL_TIME,
        min_hours=32, max_hours=40,
        roles=["shift_lead", "barista"],
        can_supervise=True, needs_supervision=False,
        overtime_allowed=True, hourly_rate=18.0,
        color="#e9c46a"  # Gold
    )
    for day in range(7):
        sam.add_availability(day, 6, 18)
        sam.add_preference(day, 10, 18)  # Prefers afternoon/evening
    employees.append(sam)
    
    # Emma - Part-time barista
    emma = Employee(
        id="emma_2", name="Emma",
        classification=EmployeeClassification.PART_TIME,
        min_hours=12, max_hours=25,
        roles=["barista"],
        can_supervise=False, needs_supervision=False,
        overtime_allowed=False, hourly_rate=14.0,
        color="#7209b7"  # Purple
    )
    for day in [0, 1, 2, 3, 4]:
        emma.add_availability(day, 6, 14)
    employees.append(emma)
    
    # Tyler - Part-time barista
    tyler = Employee(
        id="tyler_3", name="Tyler",
        classification=EmployeeClassification.PART_TIME,
        min_hours=12, max_hours=25,
        roles=["barista"],
        can_supervise=False, needs_supervision=False,
        overtime_allowed=False, hourly_rate=14.0,
        color="#3a86ff"  # Bright Blue
    )
    for day in [1, 2, 3, 5, 6]:
        tyler.add_availability(day, 10, 18)
    employees.append(tyler)
    
    # Zoe - New hire barista
    zoe = Employee(
        id="zoe_4", name="Zoe",
        classification=EmployeeClassification.PART_TIME,
        min_hours=10, max_hours=20,
        roles=["barista"],
        can_supervise=False, needs_supervision=True,
        overtime_allowed=False, hourly_rate=13.0,
        color="#f4a261"  # Orange
    )
    for day in [1, 3, 4, 5, 6]:
        zoe.add_availability(day, 8, 16)
    employees.append(zoe)
    
    # Alex - Full-time barista
    alex = Employee(
        id="alex_6", name="Alex",
        classification=EmployeeClassification.FULL_TIME,
        min_hours=30, max_hours=40,
        roles=["barista"],
        can_supervise=False, needs_supervision=False,
        overtime_allowed=True, hourly_rate=15.0,
        color="#06d6a0"  # Mint
    )
    for day in range(7):
        alex.add_availability(day, 6, 18)
        alex.add_preference(day, 12, 18)  # Prefers afternoon
    employees.append(alex)
    
    scenario = BusinessScenario(
        id="coffee_shop",
        name="Sunrise Coffee",
        description="Small coffee shop with 7 staff",
        start_hour=6, end_hour=18,
        days_open=list(range(7)),
        roles=roles,
        employees=employees,
        coverage_requirements=coverage,
        peak_periods=peak_periods,
        role_coverage_configs=role_configs,
        coverage_mode=CoverageMode.SHIFTS,
        shift_templates=shift_templates,
        has_completed_setup=True
    )
    # Generate coverage from shift templates
    scenario.coverage_requirements = scenario.generate_coverage_requirements()
    return scenario


# =============================================================================
# BUSINESS 2: RETAIL STORE (12 staff)
# =============================================================================

def create_retail_store() -> BusinessScenario:
    """Retail store: 12 employees, 3 roles."""
    
    roles = [
        Role(id="cashier", name="Cashier", color="#4169E1"),
        Role(id="floor", name="Floor Associate", color="#32CD32"),
        Role(id="supervisor", name="Supervisor", color="#DC143C")
    ]
    
    # Coverage requirements:
    # - Floor Associates: 1-3 between 10am-8pm
    # - Cashier: at least 1 during 10am-8pm
    # - Supervisor: required at opening and closing, preferred throughout
    # - Sunday closes at 7pm (all other days 8pm)
    coverage = []
    for day in range(7):
        # Sunday (day 6) closes at 7pm, others at 8pm
        close_hour = 19 if day == 6 else 20
        
        for hour in range(10, close_hour):
            is_opening = (hour == 10)
            is_closing = (hour == close_hour - 1)
            
            # Supervisor: required at opening and closing, optional mid-day
            if is_opening or is_closing:
                # Required during opening and closing
                coverage.append(CoverageRequirement(day, hour, "supervisor", min_staff=1, max_staff=1))
            else:
                # Preferred but not required during mid-day (min=0, max=1)
                coverage.append(CoverageRequirement(day, hour, "supervisor", min_staff=0, max_staff=1))
            
            # Cashier: at least 1 always
            coverage.append(CoverageRequirement(day, hour, "cashier", min_staff=1, max_staff=2))
            
            # Floor Associates: 1-3
            coverage.append(CoverageRequirement(day, hour, "floor", min_staff=1, max_staff=3))
    
    employees = []
    
    # 2 Full-time supervisors
    for i, name in enumerate(["Rachel", "Marcus"]):
        emp = Employee(
            id=f"{name.lower()}_{i}", name=name,
            classification=EmployeeClassification.FULL_TIME,
            min_hours=32, max_hours=40,
            roles=["supervisor", "cashier", "floor"],
            can_supervise=True, needs_supervision=False,
            overtime_allowed=(i == 0),
            hourly_rate=20.0,
            color="#DC143C"
        )
        for day in range(7):
            close_hour = 19 if day == 6 else 20  # Sunday closes at 7pm
            emp.add_availability(day, 10, close_hour)
        employees.append(emp)
    
    # 4 Full-time floor/cashier
    for i, name in enumerate(["Devon", "Ashley", "Chris", "Jordan"]):
        emp = Employee(
            id=f"{name.lower()}_{i+2}", name=name,
            classification=EmployeeClassification.FULL_TIME,
            min_hours=30, max_hours=40,
            roles=["cashier", "floor"],
            can_supervise=False, needs_supervision=False,
            overtime_allowed=(i < 2),
            hourly_rate=16.0,
            color="#32CD32" if i % 2 == 0 else "#4169E1"
        )
        for day in range(7):
            close_hour = 19 if day == 6 else 20  # Sunday closes at 7pm
            emp.add_availability(day, 10, close_hour)
        employees.append(emp)
    
    # 6 Part-time staff
    for i, name in enumerate(["Maya", "Ethan", "Sophia", "Liam", "Olivia", "Noah"]):
        emp = Employee(
            id=f"{name.lower()}_{i+6}", name=name,
            classification=EmployeeClassification.PART_TIME,
            min_hours=15, max_hours=25,
            roles=["cashier", "floor"],
            can_supervise=False,
            needs_supervision=(i >= 4),
            overtime_allowed=False,
            hourly_rate=14.0,
            color="#228B22" if i % 2 == 0 else "#6495ED"
        )
        avail, prefs = _random_availability(list(range(7)), 10, 20, False, i + 20)
        emp.availability = avail
        emp.preferences = prefs
        employees.append(emp)
    
    # Create shift templates for the Requirements UI
    shift_templates = [
        ShiftTemplate(
            id="full_day",
            name="Full Day Coverage",
            start_hour=10,
            end_hour=20,
            days=list(range(6)),  # Mon-Sat
            color="#6366f1",
            roles=[
                ShiftRoleRequirement(role_id="floor", count=1, max_count=3),
                ShiftRoleRequirement(role_id="cashier", count=1, max_count=2),
            ]
        ),
        ShiftTemplate(
            id="full_day_sun",
            name="Sunday Coverage",
            start_hour=10,
            end_hour=19,  # Sunday closes at 7pm
            days=[6],  # Sunday only
            color="#8b5cf6",
            roles=[
                ShiftRoleRequirement(role_id="floor", count=1, max_count=3),
                ShiftRoleRequirement(role_id="cashier", count=1, max_count=2),
            ]
        ),
        ShiftTemplate(
            id="opening_supervisor",
            name="Opening Supervisor",
            start_hour=10,
            end_hour=11,
            days=list(range(7)),  # All days
            color="#DC143C",
            roles=[
                ShiftRoleRequirement(role_id="supervisor", count=1, max_count=1),
            ]
        ),
        ShiftTemplate(
            id="closing_supervisor",
            name="Closing Supervisor (Mon-Sat)",
            start_hour=19,
            end_hour=20,
            days=list(range(6)),  # Mon-Sat
            color="#DC143C",
            roles=[
                ShiftRoleRequirement(role_id="supervisor", count=1, max_count=1),
            ]
        ),
        ShiftTemplate(
            id="closing_supervisor_sun",
            name="Closing Supervisor (Sun)",
            start_hour=18,
            end_hour=19,
            days=[6],  # Sunday only
            color="#DC143C",
            roles=[
                ShiftRoleRequirement(role_id="supervisor", count=1, max_count=1),
            ]
        ),
    ]
    
    return BusinessScenario(
        id="retail_store",
        name="Urban Outfitters Plus",
        description="Retail store with 12 staff, 3 roles - 10am-8pm (Sun 7pm)",
        start_hour=10, end_hour=20,
        days_open=list(range(7)),
        shift_templates=shift_templates,
        coverage_mode=CoverageMode.SHIFTS,
        roles=roles,
        employees=employees,
        coverage_requirements=coverage
    )


# =============================================================================
# BUSINESS 3: RESTAURANT (20 staff)
# =============================================================================

def create_restaurant() -> BusinessScenario:
    """Restaurant: 20 employees, 4 roles."""
    
    roles = [
        Role(id="server", name="Server", color="#FF6347"),
        Role(id="host", name="Host", color="#9370DB"),
        Role(id="kitchen", name="Kitchen", color="#FF8C00"),
        Role(id="manager", name="Manager", color="#2F4F4F")
    ]
    
    # Coverage: 4-5 staff per hour
    # Total: ~12 hours × 7 days × 4.5 = ~378 slots
    # Staff: 20 × ~25 hours = ~500 hours
    coverage = []
    for day in range(7):
        start = 10
        for hour in range(start, 22):
            # 1 manager
            coverage.append(CoverageRequirement(day, hour, "manager", min_staff=1, max_staff=1))
            # 1 host
            coverage.append(CoverageRequirement(day, hour, "host", min_staff=1, max_staff=2))
            # 2 servers
            coverage.append(CoverageRequirement(day, hour, "server", min_staff=2, max_staff=4))
            # 1 kitchen
            coverage.append(CoverageRequirement(day, hour, "kitchen", min_staff=1, max_staff=3))
    
    employees = []
    
    # 2 Managers
    for i, name in enumerate(["Carlos", "Priya"]):
        emp = Employee(
            id=f"{name.lower()}_{i}", name=name,
            classification=EmployeeClassification.FULL_TIME,
            min_hours=35, max_hours=45,
            roles=["manager", "host", "server"],
            can_supervise=True, needs_supervision=False,
            overtime_allowed=True,
            hourly_rate=25.0,
            color="#2F4F4F"
        )
        for day in range(7):
            emp.add_availability(day, 10, 22)
        employees.append(emp)
    
    # 4 Kitchen staff
    for i, name in enumerate(["Miguel", "Aisha", "James", "Kim"]):
        is_ft = i < 3
        emp = Employee(
            id=f"{name.lower()}_{i+2}", name=name,
            classification=EmployeeClassification.FULL_TIME if is_ft else EmployeeClassification.PART_TIME,
            min_hours=30 if is_ft else 15,
            max_hours=40 if is_ft else 28,
            roles=["kitchen"],
            can_supervise=(i == 0),
            needs_supervision=(i == 3),
            overtime_allowed=(i < 2),
            hourly_rate=18.0 if i == 0 else 15.0,
            color="#FF8C00"
        )
        for day in range(7):
            emp.add_availability(day, 10, 22)
        employees.append(emp)
    
    # 8 Servers
    for i, name in enumerate(["Jessica", "Brandon", "Nicole", "Ryan", "Amanda", "Kevin", "Mia", "Jackson"]):
        is_ft = i < 3
        emp = Employee(
            id=f"{name.lower()}_{i+6}", name=name,
            classification=EmployeeClassification.FULL_TIME if is_ft else EmployeeClassification.PART_TIME,
            min_hours=30 if is_ft else 15,
            max_hours=40 if is_ft else 28,
            roles=["server", "host"],
            can_supervise=(i == 0),
            needs_supervision=(i >= 6),
            overtime_allowed=(i < 2),
            hourly_rate=14.0,
            color="#FF6347"
        )
        avail, prefs = _random_availability(list(range(7)), 10, 22, is_ft, i + 50)
        emp.availability = avail
        emp.preferences = prefs
        employees.append(emp)
    
    # 6 Hosts
    for i, name in enumerate(["Lily", "Daniel", "Grace", "Sean", "Chloe", "David"]):
        emp = Employee(
            id=f"{name.lower()}_{i+14}", name=name,
            classification=EmployeeClassification.PART_TIME,
            min_hours=12, max_hours=24,
            roles=["host", "server"],
            can_supervise=False,
            needs_supervision=(i >= 4),
            overtime_allowed=False,
            hourly_rate=12.0,
            color="#9370DB"
        )
        avail, prefs = _random_availability(list(range(7)), 10, 22, False, i + 60)
        emp.availability = avail
        emp.preferences = prefs
        employees.append(emp)
    
    return BusinessScenario(
        id="restaurant",
        name="Bella Vista Bistro",
        description="Restaurant with 20 staff, 4 roles",
        start_hour=10, end_hour=22,
        days_open=list(range(7)),
        roles=roles,
        employees=employees,
        coverage_requirements=coverage
    )


# =============================================================================
# BUSINESS 4: CALL CENTER (35 staff)
# =============================================================================

def create_call_center() -> BusinessScenario:
    """Call center: 35 employees, 3 roles, weekdays only."""
    
    roles = [
        Role(id="agent", name="Agent", color="#4682B4"),
        Role(id="team_lead", name="Team Lead", color="#9932CC"),
        Role(id="qa", name="QA Specialist", color="#20B2AA")
    ]
    
    # Coverage: 5-6 staff per hour
    # Total: 12 hours × 5 days × 5.5 = ~330 slots
    # Staff: 35 × ~25 hours = ~875 hours
    coverage = []
    for day in range(5):  # Mon-Fri only
        for hour in range(8, 20):
            # 1 team lead
            coverage.append(CoverageRequirement(day, hour, "team_lead", min_staff=1, max_staff=2))
            # 1 QA
            coverage.append(CoverageRequirement(day, hour, "qa", min_staff=1, max_staff=2))
            # 4 agents
            coverage.append(CoverageRequirement(day, hour, "agent", min_staff=4, max_staff=8))
    
    employees = []
    
    # 4 Team Leads
    for i, name in enumerate(["Patricia", "Robert", "Linda", "Michael"]):
        emp = Employee(
            id=f"{name.lower()}_{i}", name=name,
            classification=EmployeeClassification.FULL_TIME,
            min_hours=20, max_hours=40,
            roles=["team_lead", "agent"],
            can_supervise=True, needs_supervision=False,
            overtime_allowed=(i < 2),
            hourly_rate=24.0,
            color="#9932CC"
        )
        for day in range(5):
            emp.add_availability(day, 8, 20)
        employees.append(emp)
    
    # 3 QA Specialists
    for i, name in enumerate(["Susan", "Thomas", "Barbara"]):
        emp = Employee(
            id=f"{name.lower()}_{i+4}", name=name,
            classification=EmployeeClassification.FULL_TIME,
            min_hours=20, max_hours=40,
            roles=["qa", "agent"],
            can_supervise=False, needs_supervision=False,
            overtime_allowed=False,
            hourly_rate=20.0,
            color="#20B2AA"
        )
        for day in range(5):
            emp.add_availability(day, 8, 20)
        employees.append(emp)
    
    # 16 Full-time Agents
    ft_names = [
        "Jennifer", "William", "Elizabeth", "David", "Margaret", "Richard",
        "Dorothy", "Joseph", "Sarah", "Charles", "Betty", "Daniel",
        "Helen", "Matthew", "Sandra", "Anthony"
    ]
    for i, name in enumerate(ft_names):
        emp = Employee(
            id=f"{name.lower()}_{i+7}", name=name,
            classification=EmployeeClassification.FULL_TIME,
            min_hours=20, max_hours=40,
            roles=["agent"],
            can_supervise=False,
            needs_supervision=(i >= 14),
            overtime_allowed=(i < 8),
            hourly_rate=16.0,
            color="#4682B4"
        )
        for day in range(5):
            emp.add_availability(day, 8, 20)
        employees.append(emp)
    
    # 12 Part-time Agents
    pt_names = [
        "Nancy", "Mark", "Karen", "Steven", "Lisa", "Paul",
        "Michelle", "Andrew", "Donna", "Joshua", "Carol", "Kenneth"
    ]
    for i, name in enumerate(pt_names):
        emp = Employee(
            id=f"{name.lower()}_{i+23}", name=name,
            classification=EmployeeClassification.PART_TIME,
            min_hours=10, max_hours=28,
            roles=["agent"],
            can_supervise=False,
            needs_supervision=False,  # Simplified for testing
            overtime_allowed=False,
            hourly_rate=14.0,
            color="#5F9EA0"
        )
        avail, prefs = _random_availability(list(range(5)), 8, 20, False, i + 150)
        emp.availability = avail
        emp.preferences = prefs
        employees.append(emp)
    
    return BusinessScenario(
        id="call_center",
        name="Premier Support Services",
        description="Call center with 35 staff, weekdays only",
        start_hour=8, end_hour=20,
        days_open=list(range(5)),  # Mon-Fri
        roles=roles,
        employees=employees,
        coverage_requirements=coverage
    )


# =============================================================================
# BUSINESS 5: WAREHOUSE (50 staff)
# =============================================================================

def create_warehouse() -> BusinessScenario:
    """Warehouse: 50 employees, 4 roles, Mon-Sat."""
    
    roles = [
        Role(id="picker", name="Picker", color="#8B0000"),
        Role(id="packer", name="Packer", color="#006400"),
        Role(id="forklift", name="Forklift Operator", color="#FF4500"),
        Role(id="supervisor", name="Supervisor", color="#191970")
    ]
    
    # Coverage: 5-6 staff per hour (reduced for feasibility)
    # Total: 16 hours × 6 days × 5 = ~480 slots
    # Staff: 50 × ~25 hours = ~1250 hours
    coverage = []
    for day in range(6):  # Mon-Sat
        for hour in range(6, 22):
            # 1 supervisor
            coverage.append(CoverageRequirement(day, hour, "supervisor", min_staff=1, max_staff=2))
            # 1 forklift
            coverage.append(CoverageRequirement(day, hour, "forklift", min_staff=1, max_staff=3))
            # 2 pickers
            coverage.append(CoverageRequirement(day, hour, "picker", min_staff=2, max_staff=5))
            # 1 packer
            coverage.append(CoverageRequirement(day, hour, "packer", min_staff=1, max_staff=3))
    
    employees = []
    
    # 6 Supervisors
    sup_names = ["George", "Maria", "Frank", "Angela", "Raymond", "Catherine"]
    for i, name in enumerate(sup_names):
        emp = Employee(
            id=f"{name.lower()}_{i}", name=name,
            classification=EmployeeClassification.FULL_TIME,
            min_hours=20, max_hours=45,
            roles=["supervisor", "forklift", "picker", "packer"],
            can_supervise=True, needs_supervision=False,
            overtime_allowed=True,
            hourly_rate=28.0,
            color="#191970"
        )
        for day in range(6):
            emp.add_availability(day, 6, 22)
        employees.append(emp)
    
    # 10 Forklift Operators
    fork_names = [
        "Larry", "Teresa", "Gerald", "Debra", "Russell",
        "Pamela", "Roy", "Jacqueline", "Eugene", "Sharon"
    ]
    for i, name in enumerate(fork_names):
        emp = Employee(
            id=f"{name.lower()}_{i+6}", name=name,
            classification=EmployeeClassification.FULL_TIME,
            min_hours=20, max_hours=42,
            roles=["forklift", "picker"],
            can_supervise=False,
            needs_supervision=False,  # Simplified
            overtime_allowed=(i < 6),
            hourly_rate=22.0,
            color="#FF4500"
        )
        for day in range(6):
            emp.add_availability(day, 6, 22)
        employees.append(emp)
    
    # 20 Pickers
    picker_names = [
        "Albert", "Ruth", "Harold", "Judith", "Carl", "Virginia", "Henry", "Diana",
        "Arthur", "Frances", "Wayne", "Jean", "Billy", "Alice", "Dennis", "Julie",
        "Johnny", "Martha", "Gary", "Christine"
    ]
    for i, name in enumerate(picker_names):
        is_ft = i < 14
        emp = Employee(
            id=f"{name.lower()}_{i+16}", name=name,
            classification=EmployeeClassification.FULL_TIME if is_ft else EmployeeClassification.PART_TIME,
            min_hours=15 if is_ft else 10,
            max_hours=40 if is_ft else 30,
            roles=["picker"],
            can_supervise=False,
            needs_supervision=False,  # Simplified
            overtime_allowed=(i < 8 and is_ft),
            hourly_rate=17.0 if is_ft else 15.0,
            color="#8B0000"
        )
        avail, prefs = _random_availability(list(range(6)), 6, 22, is_ft, i + 200)
        emp.availability = avail
        emp.preferences = prefs
        employees.append(emp)
    
    # 14 Packers
    packer_names = [
        "Vincent", "Brenda", "Ralph", "Carolyn", "Philip", "Janet",
        "Bobby", "Donna", "Howard", "Katherine", "Victor", "Gloria",
        "Frederick", "Evelyn"
    ]
    for i, name in enumerate(packer_names):
        is_ft = i < 10
        emp = Employee(
            id=f"{name.lower()}_{i+36}", name=name,
            classification=EmployeeClassification.FULL_TIME if is_ft else EmployeeClassification.PART_TIME,
            min_hours=15 if is_ft else 10,
            max_hours=40 if is_ft else 28,
            roles=["packer"],
            can_supervise=False,
            needs_supervision=False,  # Simplified
            overtime_allowed=(i < 5 and is_ft),
            hourly_rate=16.0 if is_ft else 14.0,
            color="#006400"
        )
        avail, prefs = _random_availability(list(range(6)), 6, 22, is_ft, i + 250)
        emp.availability = avail
        emp.preferences = prefs
        employees.append(emp)
    
    return BusinessScenario(
        id="warehouse",
        name="Global Logistics Hub",
        description="Warehouse with 50 staff, 4 roles, Mon-Sat",
        start_hour=6, end_hour=22,
        days_open=list(range(6)),  # Mon-Sat
        roles=roles,
        employees=employees,
        coverage_requirements=coverage
    )


# =============================================================================
# REGISTRY
# =============================================================================

# Cache for business instances to persist changes across page loads
_business_cache = {}  # type: Dict[str, BusinessScenario]

# Map of business IDs to their creator functions
_business_creators = {
    "coffee_shop": create_coffee_shop,
    "retail_store": create_retail_store,
    "restaurant": create_restaurant,
    "call_center": create_call_center,
    "warehouse": create_warehouse
}

# User-created businesses (stored by user_id)
_user_businesses = {}  # type: Dict[int, str]  # user_id -> business_id

# Flag to track if we've loaded from database
_db_loaded = False


def _try_import_db_service():
    """Try to import db_service module. Returns None if not in app context."""
    try:
        from db_service import (
            get_db_business, get_user_db_business, save_business_to_db,
            load_business_from_db, get_all_persisted_businesses, is_business_persisted
        )
        return {
            'get_db_business': get_db_business,
            'get_user_db_business': get_user_db_business,
            'save_business_to_db': save_business_to_db,
            'load_business_from_db': load_business_from_db,
            'get_all_persisted_businesses': get_all_persisted_businesses,
            'is_business_persisted': is_business_persisted
        }
    except ImportError:
        return None
    except Exception as e:
        print(f"Warning: Could not import db_service: {e}")
        return None


def load_businesses_from_db(force_reload=False):
    """Load all persisted businesses from the database into cache.
    
    Args:
        force_reload: If True, reload from DB even if already loaded
    """
    global _db_loaded, _business_cache, _user_businesses
    
    if _db_loaded and not force_reload:
        return
    
    db_funcs = _try_import_db_service()
    if not db_funcs:
        return
    
    try:
        db_businesses = db_funcs['get_all_persisted_businesses']()
        for db_business in db_businesses:
            scenario = db_funcs['load_business_from_db'](db_business)
            _business_cache[scenario.id] = scenario
            _user_businesses[db_business.owner_id] = scenario.id
        _db_loaded = True
    except Exception as e:
        # Database might not be initialized yet or we're outside app context
        # Don't set _db_loaded so we try again next time
        print(f"Warning: Could not load businesses from database: {e}")


def create_user_business(user_id: int, company_name: str, owner_name: str = None) -> BusinessScenario:
    """Create a new business for a user based on their company name."""
    import re
    
    # Generate a unique business ID
    slug = re.sub(r'[^a-z0-9]+', '_', company_name.lower()).strip('_')
    business_id = f"user_{user_id}_{slug}"
    
    # Check if we already have this business in the database
    db_funcs = _try_import_db_service()
    if db_funcs:
        try:
            # Check if user already has a business
            db_business = db_funcs['get_user_db_business'](user_id)
            if db_business:
                scenario = db_funcs['load_business_from_db'](db_business)
                _business_cache[scenario.id] = scenario
                _user_businesses[user_id] = scenario.id
                return scenario
        except Exception:
            pass
    
    # Default roles for a new business
    # Note: Avoid purple (#8b5cf6) as it's reserved for time-off display
    roles = [
        Role(id="staff", name="Staff", color="#3b82f6"),  # Blue
        Role(id="manager", name="Manager", color="#10b981")  # Emerald Green
    ]
    
    # Create the owner as the first employee/manager
    employees = []
    if owner_name:
        owner = Employee(
            id=f"owner_{user_id}",
            name=owner_name,
            classification=EmployeeClassification.FULL_TIME,
            min_hours=0, max_hours=40,
            roles=["manager", "staff"],
            can_supervise=True, needs_supervision=False,
            overtime_allowed=True, hourly_rate=25.0,
            color="#8b5cf6"  # Purple
        )
        # Make owner available all days
        for day in range(7):
            owner.add_availability(day, 9, 17)
        employees.append(owner)
    
    # Basic shift templates
    shift_templates = [
        ShiftTemplate(
            id="morning",
            name="Morning Shift",
            start_hour=9,
            end_hour=13,
            roles=[
                ShiftRoleRequirement("staff", 1),
            ],
            days=list(range(7)),
            color="#f59e0b"  # Amber
        ),
        ShiftTemplate(
            id="afternoon",
            name="Afternoon Shift",
            start_hour=13,
            end_hour=17,
            roles=[
                ShiftRoleRequirement("staff", 1),
            ],
            days=list(range(7)),
            color="#3b82f6"  # Blue
        ),
    ]
    
    scenario = BusinessScenario(
        id=business_id,
        name=company_name,
        description=f"{company_name} - Your business",
        start_hour=9, end_hour=17,
        days_open=list(range(7)),
        roles=roles,
        employees=employees,
        coverage_requirements=[],
        peak_periods=[],
        role_coverage_configs=[],
        coverage_mode=CoverageMode.SHIFTS,
        shift_templates=shift_templates,
        has_completed_setup=False  # New businesses need setup
    )
    scenario.coverage_requirements = scenario.generate_coverage_requirements()
    
    # Store in cache and user mapping
    _business_cache[business_id] = scenario
    _user_businesses[user_id] = business_id
    
    # Persist to database
    if db_funcs:
        try:
            db_funcs['save_business_to_db'](scenario, user_id)
        except Exception as e:
            print(f"Warning: Could not save business to database: {e}")
    
    return scenario


def get_user_business(user_id: int) -> BusinessScenario:
    """Get the business for a specific user."""
    # First check the in-memory cache
    if user_id in _user_businesses:
        return _business_cache.get(_user_businesses[user_id])
    
    # Try to load from database
    db_funcs = _try_import_db_service()
    if db_funcs:
        try:
            db_business = db_funcs['get_user_db_business'](user_id)
            if db_business:
                scenario = db_funcs['load_business_from_db'](db_business)
                _business_cache[scenario.id] = scenario
                _user_businesses[user_id] = scenario.id
                return scenario
        except Exception as e:
            print(f"Warning: Could not load business from database: {e}")
    
    return None


def get_all_businesses() -> List[BusinessScenario]:
    """Get all available business scenarios (cached)."""
    # Load from database first
    load_businesses_from_db()
    
    # Ensure all built-in businesses are cached
    for business_id in _business_creators:
        if business_id not in _business_cache:
            _business_cache[business_id] = _business_creators[business_id]()
    return list(_business_cache.values())


def get_business_by_id(business_id: str, force_reload: bool = False) -> BusinessScenario:
    """Get a specific business scenario by ID (cached).
    
    Args:
        business_id: The unique business identifier
        force_reload: If True, bypass cache and reload from database
    """
    # Check cache first (unless force_reload)
    if not force_reload and business_id in _business_cache:
        return _business_cache[business_id]
    
    # Try to load from database
    db_funcs = _try_import_db_service()
    if db_funcs:
        try:
            db_business = db_funcs['get_db_business'](business_id)
            if db_business:
                scenario = db_funcs['load_business_from_db'](db_business)
                _business_cache[scenario.id] = scenario
                _user_businesses[db_business.owner_id] = scenario.id
                return scenario
        except Exception as e:
            print(f"Warning: Could not load business from database: {e}")
    
    # Check built-in creators (only if not forcing reload or not in cache)
    if business_id in _business_creators:
        _business_cache[business_id] = _business_creators[business_id]()
        return _business_cache[business_id]
    
    raise ValueError(f"Unknown business ID: {business_id}")


def sync_business_to_db(business_id: str, user_id: int, business_obj=None):
    """Sync a business from cache to database.
    
    Args:
        business_id: The business ID to sync
        user_id: The owner user ID
        business_obj: Optional - the actual business object to save (bypasses cache lookup)
    """
    # Use provided business object or try to get from cache
    business_to_save = business_obj
    if business_to_save is None:
        business_to_save = _business_cache.get(business_id)
    
    if business_to_save is None:
        print(f"Warning: sync_business_to_db called but business {business_id} not found in cache and no business_obj provided", flush=True)
        return False
    
    db_funcs = _try_import_db_service()
    if db_funcs:
        try:
            db_funcs['save_business_to_db'](business_to_save, user_id)
            # Also update cache to ensure consistency
            _business_cache[business_id] = business_to_save
            print(f"[DB] Successfully synced business {business_id} to database", flush=True)
            return True
        except Exception as e:
            print(f"Warning: Could not sync business to database: {e}", flush=True)
            import traceback
            traceback.print_exc()
            return False
    else:
        print(f"Warning: db_funcs not available for sync_business_to_db", flush=True)
        return False


DAYS_OF_WEEK = DAYS
