"""
Sample data module - now uses business scenarios.

This module provides backwards compatibility while using the new
BusinessScenario system from businesses.py.
"""

from .businesses import (
    get_all_businesses,
    get_business_by_id,
    create_coffee_shop,
    DAYS_OF_WEEK
)

# Default to coffee shop for backwards compatibility
_default_business = None

def _get_default():
    global _default_business
    if _default_business is None:
        _default_business = create_coffee_shop()
    return _default_business

# Operating hours from default business
def get_operating_hours():
    b = _get_default()
    return range(b.start_hour, b.end_hour)

OPERATING_HOURS = range(6, 18)  # Will be overridden by business
START_HOUR = 6
END_HOUR = 18
NUM_DAYS = 7


def get_sample_employees():
    """Get employees from the default business scenario."""
    return _get_default().employees


def get_total_required_hours() -> int:
    """Calculate total hours needed per week."""
    b = _get_default()
    return len(range(b.start_hour, b.end_hour)) * len(b.days_open)


def print_availability_matrix():
    """Debug function to print availability as a readable matrix."""
    employees = get_sample_employees()
    business = _get_default()
    
    print("\n" + "=" * 80)
    print(f"EMPLOYEE AVAILABILITY MATRIX - {business.name}")
    print("=" * 80)
    
    for emp in employees:
        print(f"\n{emp.name} ({emp.classification.value}, {emp.min_hours}-{emp.max_hours} hrs/week):")
        print(f"  Roles: {', '.join(emp.roles)}")
        print(f"  Can supervise: {emp.can_supervise}, Needs supervision: {emp.needs_supervision}")
        print(f"  Overtime allowed: {emp.overtime_allowed}")
        print("-" * 60)
        
        # Header
        print(f"{'Hour':<6}", end="")
        for day in DAYS_OF_WEEK:
            print(f"{day[:3]:<6}", end="")
        print()
        
        # Hours
        for hour in range(business.start_hour, business.end_hour):
            print(f"{hour:02d}:00 ", end="")
            for day_idx in range(7):
                if emp.is_available(day_idx, hour):
                    if emp.prefers(day_idx, hour):
                        print("  *   ", end="")  # Preferred
                    else:
                        print("  +   ", end="")  # Available
                elif emp.is_blocked(day_idx, hour):
                    print("  X   ", end="")  # Time off
                else:
                    print("  -   ", end="")  # Not available
            print()
    
    print("\n" + "=" * 80)
    print("Legend: + = Available, * = Preferred, X = Time off, - = Not available")
    print("=" * 80)


if __name__ == "__main__":
    print_availability_matrix()
