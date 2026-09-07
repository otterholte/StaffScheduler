"""
Built-in demo businesses.

Five ready-made scenarios of increasing size let visitors try the scheduler
without signing up:

1. Coffee Shop  (7 staff, 2 roles, shift-based coverage)
2. Retail Store (12 staff, 3 roles)
3. Restaurant   (20 staff, 4 roles)
4. Call Center  (35 staff, 3 roles, weekdays only)
5. Warehouse    (50 staff, 4 roles, Mon-Sat)

They are created in memory on first use and are never written to the
database. Real (user-owned) businesses live in the database and are loaded by
`services/business_context.py`.
"""

import random
from typing import Dict, List

from .models import (
    AvailabilityRange, BusinessScenario, CoverageMode, CoverageRequirement, Employee,
    EmployeeClassification, PeakPeriod, Role, RoleCoverageConfig, ShiftRoleRequirement,
    ShiftTemplate, TimeSlot,
)

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
DAYS_OF_WEEK = DAYS

DEMO_BUSINESS_IDS = {"coffee_shop", "retail_store", "restaurant", "call_center", "warehouse"}

# Display metadata for the location switcher
DEMO_META = {
    "coffee_shop": {"emoji": "☕", "color": "#3b82f6"},
    "retail_store": {"emoji": "👗", "color": "#f59e0b"},
    "restaurant": {"emoji": "🍽️", "color": "#ef4444"},
    "call_center": {"emoji": "💻", "color": "#4b5563"},
    "warehouse": {"emoji": "📦", "color": "#8b5cf6"},
}


def _random_availability(days: List[int], start_hour: int, end_hour: int,
                         is_full_time: bool, employee_index: int) -> tuple:
    """Deterministic pseudo-random availability so demo data is stable."""
    availability, preferences = set(), set()
    rng = random.Random(employee_index * 42)

    if is_full_time:
        available_days = rng.sample(days, min(len(days), rng.randint(5, len(days))))
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
        available_days = rng.sample(days, rng.randint(4, min(6, len(days))))
        hours_in_day = end_hour - start_hour
        for day in available_days:
            pattern = employee_index % 3
            if pattern == 0:
                shift_start, shift_end = start_hour, start_hour + min(8, hours_in_day)
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


def _apply_slots(emp: Employee, availability, preferences):
    """Store slot-based availability and derive the range representation from it."""
    emp.availability = availability
    emp.preferences = preferences
    by_day: Dict[int, List[int]] = {}
    for slot in availability:
        by_day.setdefault(slot.day, []).append(slot.hour)
    for day, hours in by_day.items():
        hours.sort()
        start = prev = hours[0]
        for h in hours[1:]:
            if h != prev + 1:
                emp.availability_ranges.append(AvailabilityRange(day, start, prev + 1))
                start = h
            prev = h
        emp.availability_ranges.append(AvailabilityRange(day, start, prev + 1))


# =============================================================================
# 1. COFFEE SHOP
# =============================================================================

def create_coffee_shop() -> BusinessScenario:
    roles = [
        Role(id="barista", name="Barista", color="#06d6a0"),
        Role(id="shift_lead", name="Shift Lead", color="#264653"),
    ]
    shift_templates = [
        ShiftTemplate(id="morning", name="Morning Shift", start_hour=6, end_hour=12,
                      roles=[ShiftRoleRequirement("shift_lead", 1), ShiftRoleRequirement("barista", 1)],
                      days=list(range(7)), color="#f59e0b"),
        ShiftTemplate(id="afternoon", name="Afternoon Shift", start_hour=12, end_hour=18,
                      roles=[ShiftRoleRequirement("shift_lead", 1), ShiftRoleRequirement("barista", 1)],
                      days=list(range(7)), color="#3b82f6"),
        ShiftTemplate(id="busy_hours", name="Peak Hours (Extra)", start_hour=7, end_hour=9,
                      roles=[ShiftRoleRequirement("barista", 1)], days=list(range(7)), color="#ef4444"),
    ]
    peak_periods = [
        PeakPeriod(name="Busy Hours", start_hour=7, end_hour=9, days=list(range(7))),
        PeakPeriod(name="Lunch Time", start_hour=12, end_hour=14, days=list(range(5))),
    ]
    role_configs = [
        RoleCoverageConfig(role_id="shift_lead", default_min_staff=1, default_max_staff=1),
        RoleCoverageConfig(role_id="barista", default_min_staff=1, default_max_staff=2, peak_boost=1),
    ]

    employees = []

    maria = Employee(id="maria_0", name="Maria", classification=EmployeeClassification.FULL_TIME,
                     min_hours=30, max_hours=40, roles=["shift_lead", "barista"], can_supervise=True,
                     overtime_allowed=True, hourly_rate=18.0, color="#8338ec")
    for day in range(7):
        maria.add_availability(day, 6, 18)
        maria.add_preference(day, 6, 12)
    employees.append(maria)

    jake = Employee(id="jake_1", name="Jake", classification=EmployeeClassification.PART_TIME,
                    min_hours=15, max_hours=28, roles=["shift_lead", "barista"], can_supervise=True,
                    hourly_rate=17.0, color="#2a9d8f")
    for day in [0, 2, 4, 5, 6]:
        jake.add_availability(day, 6, 18)
    employees.append(jake)

    sam = Employee(id="sam_5", name="Sam", classification=EmployeeClassification.FULL_TIME,
                   min_hours=32, max_hours=40, roles=["shift_lead", "barista"], can_supervise=True,
                   overtime_allowed=True, hourly_rate=18.0, color="#e9c46a")
    for day in range(7):
        sam.add_availability(day, 6, 18)
        sam.add_preference(day, 10, 18)
    employees.append(sam)

    emma = Employee(id="emma_2", name="Emma", classification=EmployeeClassification.PART_TIME,
                    min_hours=12, max_hours=25, roles=["barista"], hourly_rate=14.0, color="#7209b7")
    for day in [0, 1, 2, 3, 4]:
        emma.add_availability(day, 6, 14)
    employees.append(emma)

    tyler = Employee(id="tyler_3", name="Tyler", classification=EmployeeClassification.PART_TIME,
                     min_hours=12, max_hours=25, roles=["barista"], hourly_rate=14.0, color="#3a86ff")
    for day in [1, 2, 3, 5, 6]:
        tyler.add_availability(day, 10, 18)
    employees.append(tyler)

    zoe = Employee(id="zoe_4", name="Zoe", classification=EmployeeClassification.PART_TIME,
                   min_hours=10, max_hours=20, roles=["barista"], needs_supervision=True,
                   hourly_rate=13.0, color="#f4a261")
    for day in [1, 3, 4, 5, 6]:
        zoe.add_availability(day, 8, 16)
    employees.append(zoe)

    alex = Employee(id="alex_6", name="Alex", classification=EmployeeClassification.FULL_TIME,
                    min_hours=30, max_hours=40, roles=["barista"], overtime_allowed=True,
                    hourly_rate=15.0, color="#06d6a0")
    for day in range(7):
        alex.add_availability(day, 6, 18)
        alex.add_preference(day, 12, 18)
    employees.append(alex)

    scenario = BusinessScenario(
        id="coffee_shop", name="Sunrise Coffee", description="Small coffee shop with 7 staff",
        start_hour=6, end_hour=18, days_open=list(range(7)), roles=roles, employees=employees,
        peak_periods=peak_periods, role_coverage_configs=role_configs,
        coverage_mode=CoverageMode.SHIFTS, shift_templates=shift_templates, has_completed_setup=True,
    )
    scenario.coverage_requirements = scenario.generate_coverage_requirements()
    return scenario


# =============================================================================
# 2. RETAIL STORE
# =============================================================================

def create_retail_store() -> BusinessScenario:
    roles = [
        Role(id="cashier", name="Cashier", color="#4169E1"),
        Role(id="floor", name="Floor Associate", color="#32CD32"),
        Role(id="supervisor", name="Supervisor", color="#DC143C"),
    ]
    shift_templates = [
        ShiftTemplate(id="full_day", name="Full Day Coverage", start_hour=10, end_hour=20, days=list(range(6)),
                      color="#6366f1", roles=[ShiftRoleRequirement("floor", 1, 3), ShiftRoleRequirement("cashier", 1, 2)]),
        ShiftTemplate(id="full_day_sun", name="Sunday Coverage", start_hour=10, end_hour=19, days=[6],
                      color="#8b5cf6", roles=[ShiftRoleRequirement("floor", 1, 3), ShiftRoleRequirement("cashier", 1, 2)]),
        ShiftTemplate(id="opening_supervisor", name="Opening Supervisor", start_hour=10, end_hour=11,
                      days=list(range(7)), color="#DC143C", roles=[ShiftRoleRequirement("supervisor", 1, 1)]),
        ShiftTemplate(id="closing_supervisor", name="Closing Supervisor (Mon-Sat)", start_hour=19, end_hour=20,
                      days=list(range(6)), color="#DC143C", roles=[ShiftRoleRequirement("supervisor", 1, 1)]),
        ShiftTemplate(id="closing_supervisor_sun", name="Closing Supervisor (Sun)", start_hour=18, end_hour=19,
                      days=[6], color="#DC143C", roles=[ShiftRoleRequirement("supervisor", 1, 1)]),
        ShiftTemplate(id="midday_supervisor", name="Supervisor (optional mid-day)", start_hour=11, end_hour=19,
                      days=list(range(7)), color="#f97316", roles=[ShiftRoleRequirement("supervisor", 0, 1)]),
    ]

    employees = []
    for i, name in enumerate(["Rachel", "Marcus"]):
        emp = Employee(id=f"{name.lower()}_{i}", name=name, classification=EmployeeClassification.FULL_TIME,
                       min_hours=32, max_hours=40, roles=["supervisor", "cashier", "floor"], can_supervise=True,
                       overtime_allowed=(i == 0), hourly_rate=20.0, color="#DC143C")
        for day in range(7):
            emp.add_availability(day, 10, 19 if day == 6 else 20)
        employees.append(emp)

    for i, name in enumerate(["Devon", "Ashley", "Chris", "Jordan"]):
        emp = Employee(id=f"{name.lower()}_{i + 2}", name=name, classification=EmployeeClassification.FULL_TIME,
                       min_hours=30, max_hours=40, roles=["cashier", "floor"], overtime_allowed=(i < 2),
                       hourly_rate=16.0, color="#32CD32" if i % 2 == 0 else "#4169E1")
        for day in range(7):
            emp.add_availability(day, 10, 19 if day == 6 else 20)
        employees.append(emp)

    for i, name in enumerate(["Maya", "Ethan", "Sophia", "Liam", "Olivia", "Noah"]):
        emp = Employee(id=f"{name.lower()}_{i + 6}", name=name, classification=EmployeeClassification.PART_TIME,
                       min_hours=15, max_hours=25, roles=["cashier", "floor"], needs_supervision=(i >= 4),
                       hourly_rate=14.0, color="#228B22" if i % 2 == 0 else "#6495ED")
        _apply_slots(emp, *_random_availability(list(range(7)), 10, 20, False, i + 20))
        employees.append(emp)

    scenario = BusinessScenario(
        id="retail_store", name="Urban Outfitters Plus",
        description="Retail store with 12 staff, 3 roles - 10am-8pm (Sun 7pm)",
        start_hour=10, end_hour=20, days_open=list(range(7)), shift_templates=shift_templates,
        coverage_mode=CoverageMode.SHIFTS, roles=roles, employees=employees,
    )
    scenario.coverage_requirements = scenario.generate_coverage_requirements()
    return scenario


# =============================================================================
# 3. RESTAURANT
# =============================================================================

def create_restaurant() -> BusinessScenario:
    roles = [
        Role(id="server", name="Server", color="#FF6347"),
        Role(id="host", name="Host", color="#9370DB"),
        Role(id="kitchen", name="Kitchen", color="#FF8C00"),
        Role(id="manager", name="Manager", color="#2F4F4F"),
    ]
    shift_templates = [
        ShiftTemplate(id="service", name="Service Hours", start_hour=10, end_hour=22, days=list(range(7)),
                      color="#6366f1", roles=[
                          ShiftRoleRequirement("manager", 1, 1), ShiftRoleRequirement("host", 1, 2),
                          ShiftRoleRequirement("server", 2, 4), ShiftRoleRequirement("kitchen", 1, 3)]),
    ]

    employees = []
    for i, name in enumerate(["Carlos", "Priya"]):
        emp = Employee(id=f"{name.lower()}_{i}", name=name, classification=EmployeeClassification.FULL_TIME,
                       min_hours=35, max_hours=45, roles=["manager", "host", "server"], can_supervise=True,
                       overtime_allowed=True, hourly_rate=25.0, color="#2F4F4F")
        for day in range(7):
            emp.add_availability(day, 10, 22)
        employees.append(emp)

    for i, name in enumerate(["Miguel", "Aisha", "James", "Kim"]):
        is_ft = i < 3
        emp = Employee(id=f"{name.lower()}_{i + 2}", name=name,
                       classification=EmployeeClassification.FULL_TIME if is_ft else EmployeeClassification.PART_TIME,
                       min_hours=30 if is_ft else 15, max_hours=40 if is_ft else 28, roles=["kitchen"],
                       can_supervise=(i == 0), needs_supervision=(i == 3), overtime_allowed=(i < 2),
                       hourly_rate=18.0 if i == 0 else 15.0, color="#FF8C00")
        for day in range(7):
            emp.add_availability(day, 10, 22)
        employees.append(emp)

    for i, name in enumerate(["Jessica", "Brandon", "Nicole", "Ryan", "Amanda", "Kevin", "Mia", "Jackson"]):
        is_ft = i < 3
        emp = Employee(id=f"{name.lower()}_{i + 6}", name=name,
                       classification=EmployeeClassification.FULL_TIME if is_ft else EmployeeClassification.PART_TIME,
                       min_hours=30 if is_ft else 15, max_hours=40 if is_ft else 28, roles=["server", "host"],
                       can_supervise=(i == 0), needs_supervision=(i >= 6), overtime_allowed=(i < 2),
                       hourly_rate=14.0, color="#FF6347")
        _apply_slots(emp, *_random_availability(list(range(7)), 10, 22, is_ft, i + 50))
        employees.append(emp)

    for i, name in enumerate(["Lily", "Daniel", "Grace", "Sean", "Chloe", "David"]):
        emp = Employee(id=f"{name.lower()}_{i + 14}", name=name, classification=EmployeeClassification.PART_TIME,
                       min_hours=12, max_hours=24, roles=["host", "server"], needs_supervision=(i >= 4),
                       hourly_rate=12.0, color="#9370DB")
        _apply_slots(emp, *_random_availability(list(range(7)), 10, 22, False, i + 60))
        employees.append(emp)

    scenario = BusinessScenario(
        id="restaurant", name="Bella Vista Bistro", description="Restaurant with 20 staff, 4 roles",
        start_hour=10, end_hour=22, days_open=list(range(7)), roles=roles, employees=employees,
        shift_templates=shift_templates, coverage_mode=CoverageMode.SHIFTS,
    )
    scenario.coverage_requirements = scenario.generate_coverage_requirements()
    return scenario


# =============================================================================
# 4. CALL CENTER
# =============================================================================

def create_call_center() -> BusinessScenario:
    roles = [
        Role(id="agent", name="Agent", color="#4682B4"),
        Role(id="team_lead", name="Team Lead", color="#9932CC"),
        Role(id="qa", name="QA Specialist", color="#20B2AA"),
    ]
    shift_templates = [
        ShiftTemplate(id="floor", name="Support Floor", start_hour=8, end_hour=20, days=list(range(5)),
                      color="#6366f1", roles=[
                          ShiftRoleRequirement("team_lead", 1, 2), ShiftRoleRequirement("qa", 1, 2),
                          ShiftRoleRequirement("agent", 4, 8)]),
    ]

    employees = []
    for i, name in enumerate(["Patricia", "Robert", "Linda", "Michael"]):
        emp = Employee(id=f"{name.lower()}_{i}", name=name, classification=EmployeeClassification.FULL_TIME,
                       min_hours=20, max_hours=40, roles=["team_lead", "agent"], can_supervise=True,
                       overtime_allowed=(i < 2), hourly_rate=24.0, color="#9932CC")
        for day in range(5):
            emp.add_availability(day, 8, 20)
        employees.append(emp)

    for i, name in enumerate(["Susan", "Thomas", "Barbara"]):
        emp = Employee(id=f"{name.lower()}_{i + 4}", name=name, classification=EmployeeClassification.FULL_TIME,
                       min_hours=20, max_hours=40, roles=["qa", "agent"], hourly_rate=20.0, color="#20B2AA")
        for day in range(5):
            emp.add_availability(day, 8, 20)
        employees.append(emp)

    ft_names = ["Jennifer", "William", "Elizabeth", "David", "Margaret", "Richard", "Dorothy", "Joseph",
                "Sarah", "Charles", "Betty", "Daniel", "Helen", "Matthew", "Sandra", "Anthony"]
    for i, name in enumerate(ft_names):
        emp = Employee(id=f"{name.lower()}_{i + 7}", name=name, classification=EmployeeClassification.FULL_TIME,
                       min_hours=20, max_hours=40, roles=["agent"], needs_supervision=(i >= 14),
                       overtime_allowed=(i < 8), hourly_rate=16.0, color="#4682B4")
        for day in range(5):
            emp.add_availability(day, 8, 20)
        employees.append(emp)

    pt_names = ["Nancy", "Mark", "Karen", "Steven", "Lisa", "Paul", "Michelle", "Andrew", "Donna", "Joshua",
                "Carol", "Kenneth"]
    for i, name in enumerate(pt_names):
        emp = Employee(id=f"{name.lower()}_{i + 23}", name=name, classification=EmployeeClassification.PART_TIME,
                       min_hours=10, max_hours=28, roles=["agent"], hourly_rate=14.0, color="#5F9EA0")
        _apply_slots(emp, *_random_availability(list(range(5)), 8, 20, False, i + 150))
        employees.append(emp)

    scenario = BusinessScenario(
        id="call_center", name="Premier Support Services", description="Call center with 35 staff, weekdays only",
        start_hour=8, end_hour=20, days_open=list(range(5)), roles=roles, employees=employees,
        shift_templates=shift_templates, coverage_mode=CoverageMode.SHIFTS,
    )
    scenario.coverage_requirements = scenario.generate_coverage_requirements()
    return scenario


# =============================================================================
# 5. WAREHOUSE
# =============================================================================

def create_warehouse() -> BusinessScenario:
    roles = [
        Role(id="picker", name="Picker", color="#8B0000"),
        Role(id="packer", name="Packer", color="#006400"),
        Role(id="forklift", name="Forklift Operator", color="#FF4500"),
        Role(id="supervisor", name="Supervisor", color="#191970"),
    ]
    shift_templates = [
        ShiftTemplate(id="operations", name="Operations", start_hour=6, end_hour=22, days=list(range(6)),
                      color="#6366f1", roles=[
                          ShiftRoleRequirement("supervisor", 1, 2), ShiftRoleRequirement("forklift", 1, 3),
                          ShiftRoleRequirement("picker", 2, 5), ShiftRoleRequirement("packer", 1, 3)]),
    ]

    employees = []
    for i, name in enumerate(["George", "Maria", "Frank", "Angela", "Raymond", "Catherine"]):
        emp = Employee(id=f"{name.lower()}_{i}", name=name, classification=EmployeeClassification.FULL_TIME,
                       min_hours=20, max_hours=45, roles=["supervisor", "forklift", "picker", "packer"],
                       can_supervise=True, overtime_allowed=True, hourly_rate=28.0, color="#191970")
        for day in range(6):
            emp.add_availability(day, 6, 22)
        employees.append(emp)

    fork_names = ["Larry", "Teresa", "Gerald", "Debra", "Russell", "Pamela", "Roy", "Jacqueline", "Eugene", "Sharon"]
    for i, name in enumerate(fork_names):
        emp = Employee(id=f"{name.lower()}_{i + 6}", name=name, classification=EmployeeClassification.FULL_TIME,
                       min_hours=20, max_hours=42, roles=["forklift", "picker"], overtime_allowed=(i < 6),
                       hourly_rate=22.0, color="#FF4500")
        for day in range(6):
            emp.add_availability(day, 6, 22)
        employees.append(emp)

    picker_names = ["Albert", "Ruth", "Harold", "Judith", "Carl", "Virginia", "Henry", "Diana", "Arthur", "Frances",
                    "Wayne", "Jean", "Billy", "Alice", "Dennis", "Julie", "Johnny", "Martha", "Gary", "Christine"]
    for i, name in enumerate(picker_names):
        is_ft = i < 14
        emp = Employee(id=f"{name.lower()}_{i + 16}", name=name,
                       classification=EmployeeClassification.FULL_TIME if is_ft else EmployeeClassification.PART_TIME,
                       min_hours=15 if is_ft else 10, max_hours=40 if is_ft else 30, roles=["picker"],
                       overtime_allowed=(i < 8 and is_ft), hourly_rate=17.0 if is_ft else 15.0, color="#8B0000")
        _apply_slots(emp, *_random_availability(list(range(6)), 6, 22, is_ft, i + 200))
        employees.append(emp)

    packer_names = ["Vincent", "Brenda", "Ralph", "Carolyn", "Philip", "Janet", "Bobby", "Donna", "Howard",
                    "Katherine", "Victor", "Gloria", "Frederick", "Evelyn"]
    for i, name in enumerate(packer_names):
        is_ft = i < 10
        emp = Employee(id=f"{name.lower()}_{i + 36}", name=name,
                       classification=EmployeeClassification.FULL_TIME if is_ft else EmployeeClassification.PART_TIME,
                       min_hours=15 if is_ft else 10, max_hours=40 if is_ft else 28, roles=["packer"],
                       overtime_allowed=(i < 5 and is_ft), hourly_rate=16.0 if is_ft else 14.0, color="#006400")
        _apply_slots(emp, *_random_availability(list(range(6)), 6, 22, is_ft, i + 250))
        employees.append(emp)

    scenario = BusinessScenario(
        id="warehouse", name="Global Logistics Hub", description="Warehouse with 50 staff, 4 roles, Mon-Sat",
        start_hour=6, end_hour=22, days_open=list(range(6)), roles=roles, employees=employees,
        shift_templates=shift_templates, coverage_mode=CoverageMode.SHIFTS,
    )
    scenario.coverage_requirements = scenario.generate_coverage_requirements()
    return scenario


# =============================================================================
# REGISTRY
# =============================================================================

_business_creators = {
    "coffee_shop": create_coffee_shop,
    "retail_store": create_retail_store,
    "restaurant": create_restaurant,
    "call_center": create_call_center,
    "warehouse": create_warehouse,
}

# One shared instance per demo business per process (edits are ephemeral)
_demo_cache: Dict[str, BusinessScenario] = {}


def get_demo_business(business_id: str) -> BusinessScenario:
    if business_id not in _business_creators:
        raise ValueError(f"Unknown demo business: {business_id}")
    if business_id not in _demo_cache:
        scenario = _business_creators[business_id]()
        meta = DEMO_META.get(business_id, {})
        scenario.emoji = meta.get("emoji", "🏢")
        scenario.color = meta.get("color", "#6366f1")
        _demo_cache[business_id] = scenario
    return _demo_cache[business_id]


def list_demo_businesses() -> List[BusinessScenario]:
    return [get_demo_business(bid) for bid in _business_creators]


def reset_demo_business(business_id: str):
    """Discard in-memory edits and rebuild the pristine demo."""
    _demo_cache.pop(business_id, None)


# Backwards-compatible names used by older modules/tests
def get_all_businesses() -> List[BusinessScenario]:
    return list_demo_businesses()


def get_business_by_id(business_id: str) -> BusinessScenario:
    return get_demo_business(business_id)
