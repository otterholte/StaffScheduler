"""
Advanced OR-Tools CP-SAT Solver for Staff Scheduling.

This module implements a comprehensive constraint programming solution with:
- Role-based coverage requirements
- Employee classification (FT/PT)
- Time-off requests
- Peak hour staffing
- Overtime control
- Soft preferences
- Fairness tracking
- Supervision requirements
- Consecutive days preferences
"""

import time
from typing import List, Optional, Dict, Tuple, Set
from ortools.sat.python import cp_model

from .models import (
    Employee, Schedule, ShiftAssignment, ScheduleMetrics,
    BusinessScenario, CoverageRequirement, Role, TimeSlot,
    EmployeeClassification
)


class AdvancedScheduleSolver:
    """
    Advanced solver for staff scheduling with role-based constraints.
    
    Features:
    - Multiple roles with separate coverage requirements
    - Hard constraints: availability, time-off, supervision, OT caps
    - Soft constraints: preferences, consecutive days, fairness, OT avoidance
    - Weighted objective function for optimization
    """
    
    # Soft constraint weights
    WEIGHT_COVERAGE = 1000        # Primary: fill required slots
    WEIGHT_PREFERENCE = 10        # Bonus for preferred times
    WEIGHT_CONSECUTIVE_PT = 5     # Penalty per day over 3 for PT
    WEIGHT_CONSECUTIVE_FT = 5     # Penalty per day over 5 for FT
    WEIGHT_FAIRNESS = 10          # Penalty for unfair weekend distribution
    WEIGHT_OVERTIME = 20          # Penalty per overtime hour
    
    def __init__(
        self,
        business: BusinessScenario,
        min_shift_hours: int = 2,
        max_hours_per_day: int = 8,
        max_splits_per_day: int = 2,
        max_split_shifts_per_week: int = 2,
        scheduling_strategy: str = 'balanced',  # 'minimize', 'balanced', 'maximize'
        max_days_ft: int = 5,
        max_days_ft_mode: str = 'required',  # 'off', 'preferred', 'required'
        max_days_pt: int = 3,
        max_days_pt_mode: str = 'required'   # 'off', 'preferred', 'required'
    ):
        self.business = business
        self.employees = business.employees
        self.roles = {r.id: r for r in business.roles}
        self.coverage_requirements = business.coverage_requirements
        self.min_shift_hours = min_shift_hours
        self.max_hours_per_day = max_hours_per_day
        self.max_splits_per_day = max_splits_per_day
        self.max_split_shifts_per_week = max_split_shifts_per_week
        self.scheduling_strategy = scheduling_strategy
        
        # Max days per week constraints
        self.max_days_ft = max_days_ft
        self.max_days_ft_mode = max_days_ft_mode
        self.max_days_pt = max_days_pt
        self.max_days_pt_mode = max_days_pt_mode
        
        # Operating parameters
        self.operating_hours = list(business.get_operating_hours())
        self.days_open = business.days_open
        self.num_days = len(self.days_open)
        
        # Solver state
        self._model: Optional[cp_model.CpModel] = None
        self._shift_vars: Dict[Tuple[str, int, int, str], cp_model.IntVar] = {}
        self._works_day_vars: Dict[Tuple[str, int], cp_model.IntVar] = {}
        self._previous_solutions: List[Dict] = []
        
        # Index coverage requirements for faster lookup
        self._coverage_index: Dict[Tuple[int, int, str], CoverageRequirement] = {}
        for req in self.coverage_requirements:
            self._coverage_index[(req.day, req.hour, req.role_id)] = req
    
    def _get_employees_for_role(self, role_id: str) -> List[Employee]:
        """Get all employees who can fill a specific role."""
        return [e for e in self.employees if role_id in e.roles]
    
    def _get_supervisors(self) -> List[Employee]:
        """Get all employees who can supervise."""
        return [e for e in self.employees if e.can_supervise]
    
    def _get_employees_needing_supervision(self) -> List[Employee]:
        """Get all employees who need supervision."""
        return [e for e in self.employees if e.needs_supervision]
    
    def _build_model(self, exclude_solutions: List[Dict] = None):
        """Build the CP-SAT model with all constraints."""
        self._model = cp_model.CpModel()
        self._shift_vars = {}
        self._works_day_vars = {}
        
        # Track objective components
        objective_terms = []
        
        # =================================================================
        # DECISION VARIABLES
        # =================================================================
        
        # shift[emp_id, day, hour, role] = 1 if employee works that hour in that role
        for emp in self.employees:
            for day in self.days_open:
                for hour in self.operating_hours:
                    for role_id in emp.roles:
                        var_name = f"shift_{emp.id}_{day}_{hour}_{role_id}"
                        self._shift_vars[(emp.id, day, hour, role_id)] = self._model.NewBoolVar(var_name)
        
        # works_day[emp_id, day] = 1 if employee works at all on that day
        for emp in self.employees:
            for day in self.days_open:
                var_name = f"works_day_{emp.id}_{day}"
                self._works_day_vars[(emp.id, day)] = self._model.NewBoolVar(var_name)
                
                # Link to shift vars: works_day = 1 iff any shift var is 1
                day_shifts = []
                for hour in self.operating_hours:
                    for role_id in emp.roles:
                        key = (emp.id, day, hour, role_id)
                        if key in self._shift_vars:
                            day_shifts.append(self._shift_vars[key])
                
                if day_shifts:
                    self._model.AddMaxEquality(self._works_day_vars[(emp.id, day)], day_shifts)
                else:
                    self._model.Add(self._works_day_vars[(emp.id, day)] == 0)
        
        # =================================================================
        # HARD CONSTRAINTS
        # =================================================================
        
        # 1. AVAILABILITY & TIME-OFF CONSTRAINT
        for emp in self.employees:
            for day in self.days_open:
                for hour in self.operating_hours:
                    for role_id in emp.roles:
                        key = (emp.id, day, hour, role_id)
                        if key not in self._shift_vars:
                            continue
                        
                        # Not available or has time-off
                        if not emp.is_available(day, hour):
                            self._model.Add(self._shift_vars[key] == 0)
        
        # 2. ONE ROLE PER HOUR CONSTRAINT
        # An employee can only work one role at a time
        for emp in self.employees:
            for day in self.days_open:
                for hour in self.operating_hours:
                    role_vars = []
                    for role_id in emp.roles:
                        key = (emp.id, day, hour, role_id)
                        if key in self._shift_vars:
                            role_vars.append(self._shift_vars[key])
                    if role_vars:
                        self._model.Add(sum(role_vars) <= 1)
        
        # 2b. MAX HOURS PER DAY CONSTRAINT
        # Limit total hours an employee can work in a single day
        for emp in self.employees:
            for day in self.days_open:
                daily_hours = []
                for hour in self.operating_hours:
                    for role_id in emp.roles:
                        key = (emp.id, day, hour, role_id)
                        if key in self._shift_vars:
                            daily_hours.append(self._shift_vars[key])
                if daily_hours:
                    self._model.Add(sum(daily_hours) <= self.max_hours_per_day)
        
        # 3. ROLE COVERAGE CONSTRAINTS
        coverage_vars = {}
        for req in self.coverage_requirements:
            if req.day not in self.days_open:
                continue
            if req.hour not in self.operating_hours:
                continue
            
            # Get employees who can fill this role
            eligible = self._get_employees_for_role(req.role_id)
            
            role_shifts = []
            for emp in eligible:
                key = (emp.id, req.day, req.hour, req.role_id)
                if key in self._shift_vars:
                    role_shifts.append(self._shift_vars[key])
            
            if role_shifts:
                # Minimum coverage
                coverage_met = self._model.NewBoolVar(f"cov_{req.day}_{req.hour}_{req.role_id}")
                self._model.Add(sum(role_shifts) >= req.min_staff).OnlyEnforceIf(coverage_met)
                self._model.Add(sum(role_shifts) < req.min_staff).OnlyEnforceIf(coverage_met.Not())
                
                # Maximum coverage (hard cap)
                self._model.Add(sum(role_shifts) <= req.max_staff)
                
                # Track for objective
                coverage_vars[(req.day, req.hour, req.role_id)] = coverage_met
                objective_terms.append(coverage_met * self.WEIGHT_COVERAGE)
            else:
                # No eligible employees - coverage impossible
                coverage_vars[(req.day, req.hour, req.role_id)] = None
        
        # 4. SUPERVISION CONSTRAINT
        # If an employee needs supervision, at least one supervisor must be working
        supervisors = self._get_supervisors()
        needs_supervision = self._get_employees_needing_supervision()
        
        for emp in needs_supervision:
            for day in self.days_open:
                for hour in self.operating_hours:
                    # Check if this employee is working at this time
                    emp_working_vars = []
                    for role_id in emp.roles:
                        key = (emp.id, day, hour, role_id)
                        if key in self._shift_vars:
                            emp_working_vars.append(self._shift_vars[key])
                    
                    if not emp_working_vars:
                        continue
                    
                    emp_working = self._model.NewBoolVar(f"working_{emp.id}_{day}_{hour}")
                    self._model.AddMaxEquality(emp_working, emp_working_vars)
                    
                    # If employee is working, at least one supervisor must be working
                    supervisor_working_vars = []
                    for sup in supervisors:
                        for role_id in sup.roles:
                            key = (sup.id, day, hour, role_id)
                            if key in self._shift_vars:
                                supervisor_working_vars.append(self._shift_vars[key])
                    
                    if supervisor_working_vars:
                        # If emp_working, then sum(supervisor_working_vars) >= 1
                        self._model.Add(sum(supervisor_working_vars) >= 1).OnlyEnforceIf(emp_working)
        
        # 5. WEEKLY HOURS CONSTRAINT
        for emp in self.employees:
            weekly_hours = []
            for day in self.days_open:
                for hour in self.operating_hours:
                    for role_id in emp.roles:
                        key = (emp.id, day, hour, role_id)
                        if key in self._shift_vars:
                            weekly_hours.append(self._shift_vars[key])
            
            if weekly_hours:
                total_hours = sum(weekly_hours)
                self._model.Add(total_hours >= emp.min_hours)
                
                # Overtime cap
                if emp.overtime_allowed:
                    self._model.Add(total_hours <= emp.max_hours)
                else:
                    # Can't exceed 40 hours
                    self._model.Add(total_hours <= min(40, emp.max_hours))
        
        # 6. MINIMUM SHIFT LENGTH (simplified)
        # If working, must work at least min_shift_hours
        for emp in self.employees:
            for day in self.days_open:
                hours_list = self.operating_hours
                
                for i, hour in enumerate(hours_list):
                    # Get all role vars for this employee at this hour
                    current_working_vars = []
                    for role_id in emp.roles:
                        key = (emp.id, day, hour, role_id)
                        if key in self._shift_vars:
                            current_working_vars.append(self._shift_vars[key])
                    
                    if not current_working_vars:
                        continue
                    
                    current_working = self._model.NewBoolVar(f"cw_{emp.id}_{day}_{hour}")
                    self._model.AddMaxEquality(current_working, current_working_vars)
                    
                    # Check if this is a shift start
                    if i == 0:
                        is_shift_start = current_working
                    else:
                        prev_hour = hours_list[i - 1]
                        prev_working_vars = []
                        for role_id in emp.roles:
                            key = (emp.id, day, prev_hour, role_id)
                            if key in self._shift_vars:
                                prev_working_vars.append(self._shift_vars[key])
                        
                        if prev_working_vars:
                            prev_working = self._model.NewBoolVar(f"pw_{emp.id}_{day}_{hour}")
                            self._model.AddMaxEquality(prev_working, prev_working_vars)
                            
                            is_shift_start = self._model.NewBoolVar(f"start_{emp.id}_{day}_{hour}")
                            self._model.AddBoolAnd([current_working, prev_working.Not()]).OnlyEnforceIf(is_shift_start)
                            self._model.AddBoolOr([current_working.Not(), prev_working]).OnlyEnforceIf(is_shift_start.Not())
                        else:
                            is_shift_start = current_working
                    
                    # If shift start, must work min_shift_hours
                    if i + self.min_shift_hours <= len(hours_list):
                        for j in range(self.min_shift_hours):
                            future_hour = hours_list[i + j]
                            future_vars = []
                            for role_id in emp.roles:
                                key = (emp.id, day, future_hour, role_id)
                                if key in self._shift_vars:
                                    future_vars.append(self._shift_vars[key])
                            if future_vars:
                                future_working = self._model.NewBoolVar(f"fw_{emp.id}_{day}_{future_hour}")
                                self._model.AddMaxEquality(future_working, future_vars)
                                self._model.AddImplication(is_shift_start, future_working)
                    else:
                        # Not enough hours remaining in the day - cannot start a shift here
                        # This prevents shifts shorter than min_shift_hours at end of day
                        self._model.Add(is_shift_start == 0)
        
        # 7. MAX SPLIT SHIFTS PER DAY CONSTRAINT
        # Limit the number of separate shift segments an employee can have in a day
        for emp in self.employees:
            for day in self.days_open:
                hours_list = self.operating_hours
                shift_start_vars = []
                
                for i, hour in enumerate(hours_list):
                    # Get all role vars for this employee at this hour
                    current_working_vars = []
                    for role_id in emp.roles:
                        key = (emp.id, day, hour, role_id)
                        if key in self._shift_vars:
                            current_working_vars.append(self._shift_vars[key])
                    
                    if not current_working_vars:
                        continue
                    
                    current_working = self._model.NewBoolVar(f"split_cw_{emp.id}_{day}_{hour}")
                    self._model.AddMaxEquality(current_working, current_working_vars)
                    
                    # Check if this is a shift start (working now but not before)
                    if i == 0:
                        # First hour - if working, it's a shift start
                        shift_start_vars.append(current_working)
                    else:
                        prev_hour = hours_list[i - 1]
                        prev_working_vars = []
                        for role_id in emp.roles:
                            key = (emp.id, day, prev_hour, role_id)
                            if key in self._shift_vars:
                                prev_working_vars.append(self._shift_vars[key])
                        
                        if prev_working_vars:
                            prev_working = self._model.NewBoolVar(f"split_pw_{emp.id}_{day}_{hour}")
                            self._model.AddMaxEquality(prev_working, prev_working_vars)
                            
                            # is_shift_start = current_working AND NOT prev_working
                            is_shift_start = self._model.NewBoolVar(f"split_start_{emp.id}_{day}_{hour}")
                            self._model.AddBoolAnd([current_working, prev_working.Not()]).OnlyEnforceIf(is_shift_start)
                            self._model.AddBoolOr([current_working.Not(), prev_working]).OnlyEnforceIf(is_shift_start.Not())
                            shift_start_vars.append(is_shift_start)
                        else:
                            shift_start_vars.append(current_working)
                
                # Total shift starts must not exceed max_splits_per_day
                if shift_start_vars:
                    self._model.Add(sum(shift_start_vars) <= self.max_splits_per_day)
        
        # 8. MAX SPLIT SHIFTS PER WEEK CONSTRAINT (HARD)
        # Limit total number of days with split shifts per week
        for emp in self.employees:
            split_day_vars = []
            for day in self.days_open:
                hours_list = self.operating_hours
                day_shift_starts = []
                
                for i, hour in enumerate(hours_list):
                    current_working_vars = []
                    for role_id in emp.roles:
                        key = (emp.id, day, hour, role_id)
                        if key in self._shift_vars:
                            current_working_vars.append(self._shift_vars[key])
                    
                    if not current_working_vars:
                        continue
                    
                    current_working = self._model.NewBoolVar(f"wk_split_cw_{emp.id}_{day}_{hour}")
                    self._model.AddMaxEquality(current_working, current_working_vars)
                    
                    if i == 0:
                        day_shift_starts.append(current_working)
                    else:
                        prev_hour = hours_list[i - 1]
                        prev_working_vars = []
                        for role_id in emp.roles:
                            key = (emp.id, day, prev_hour, role_id)
                            if key in self._shift_vars:
                                prev_working_vars.append(self._shift_vars[key])
                        
                        if prev_working_vars:
                            prev_working = self._model.NewBoolVar(f"wk_split_pw_{emp.id}_{day}_{hour}")
                            self._model.AddMaxEquality(prev_working, prev_working_vars)
                            
                            is_shift_start = self._model.NewBoolVar(f"wk_split_start_{emp.id}_{day}_{hour}")
                            self._model.AddBoolAnd([current_working, prev_working.Not()]).OnlyEnforceIf(is_shift_start)
                            self._model.AddBoolOr([current_working.Not(), prev_working]).OnlyEnforceIf(is_shift_start.Not())
                            day_shift_starts.append(is_shift_start)
                        else:
                            day_shift_starts.append(current_working)
                
                # Create indicator for "this day has a split shift" (2+ shift starts)
                if len(day_shift_starts) >= 2:
                    has_split = self._model.NewBoolVar(f"has_split_{emp.id}_{day}")
                    self._model.Add(sum(day_shift_starts) >= 2).OnlyEnforceIf(has_split)
                    self._model.Add(sum(day_shift_starts) <= 1).OnlyEnforceIf(has_split.Not())
                    split_day_vars.append(has_split)
            
            # Limit total split shift days per week (HARD constraint)
            if split_day_vars:
                self._model.Add(sum(split_day_vars) <= self.max_split_shifts_per_week)
        
        # =================================================================
        # SOFT CONSTRAINTS (added to objective)
        # =================================================================
        
        # 7. PREFERENCE BONUS
        for emp in self.employees:
            for day in self.days_open:
                for hour in self.operating_hours:
                    if emp.prefers(day, hour):
                        for role_id in emp.roles:
                            key = (emp.id, day, hour, role_id)
                            if key in self._shift_vars:
                                objective_terms.append(self._shift_vars[key] * self.WEIGHT_PREFERENCE)
        
        # 8. MAX DAYS PER WEEK CONSTRAINT
        # Limit total days worked per week based on employee classification
        for emp in self.employees:
            # Get the max days and mode for this employee type
            if emp.is_full_time:
                max_days = self.max_days_ft
                mode = self.max_days_ft_mode
            else:
                max_days = self.max_days_pt
                mode = self.max_days_pt_mode
            
            # Skip if constraint is off
            if mode == 'off':
                continue
            
            # Sum of days worked this week
            days_worked_vars = [self._works_day_vars[(emp.id, d)] for d in self.days_open]
            total_days = sum(days_worked_vars)
            
            if mode == 'required':
                # HARD CONSTRAINT: Cannot exceed max_days
                self._model.Add(total_days <= max_days)
            elif mode == 'preferred':
                # SOFT CONSTRAINT: Penalty for each day over the limit
                # Create indicator variables for days over the max
                for extra_day in range(1, len(self.days_open) - max_days + 1):
                    threshold = max_days + extra_day
                    over_limit = self._model.NewBoolVar(f"over_days_{emp.id}_{threshold}")
                    self._model.Add(total_days >= threshold).OnlyEnforceIf(over_limit)
                    self._model.Add(total_days < threshold).OnlyEnforceIf(over_limit.Not())
                    
                    # Penalty increases with each day over
                    penalty = extra_day * (self.WEIGHT_CONSECUTIVE_FT if emp.is_full_time else self.WEIGHT_CONSECUTIVE_PT)
                    objective_terms.append(-over_limit * penalty)
        
        # 9. WEEKEND FAIRNESS
        # Penalize assigning weekends to employees who already have high weekend counts
        weekend_days = [d for d in self.days_open if d >= 5]  # Sat=5, Sun=6
        if weekend_days:
            avg_weekend_shifts = sum(e.weekend_shifts_worked for e in self.employees) / max(1, len(self.employees))
            
            for emp in self.employees:
                if emp.weekend_shifts_worked > avg_weekend_shifts:
                    excess = emp.weekend_shifts_worked - avg_weekend_shifts
                    for day in weekend_days:
                        # Penalty for assigning more weekend shifts
                        objective_terms.append(-self._works_day_vars[(emp.id, day)] * int(excess * self.WEIGHT_FAIRNESS))
        
        # 10. OVERTIME PENALTY
        # Even when allowed, prefer to avoid overtime
        for emp in self.employees:
            weekly_hours = []
            for day in self.days_open:
                for hour in self.operating_hours:
                    for role_id in emp.roles:
                        key = (emp.id, day, hour, role_id)
                        if key in self._shift_vars:
                            weekly_hours.append(self._shift_vars[key])
            
            if weekly_hours and emp.overtime_allowed:
                # Create var for hours over 40
                total = sum(weekly_hours)
                # We can't directly penalize (total - 40), so we use auxiliary variables
                # For simplicity, penalize any hours over 40 by creating indicator variables
                for threshold in range(41, emp.max_hours + 1):
                    over_threshold = self._model.NewBoolVar(f"ot_{emp.id}_{threshold}")
                    self._model.Add(total >= threshold).OnlyEnforceIf(over_threshold)
                    self._model.Add(total < threshold).OnlyEnforceIf(over_threshold.Not())
                    objective_terms.append(-over_threshold * self.WEIGHT_OVERTIME)
        
        # =================================================================
        # EXCLUDE PREVIOUS SOLUTIONS
        # =================================================================
        if exclude_solutions:
            for prev_sol in exclude_solutions:
                differences = []
                for key, val in prev_sol.items():
                    if key in self._shift_vars:
                        if val == 1:
                            differences.append(self._shift_vars[key].Not())
                        else:
                            differences.append(self._shift_vars[key])
                if differences:
                    self._model.AddBoolOr(differences)
        
        # =================================================================
        # SCHEDULING STRATEGY
        # =================================================================
        # Adjust objective based on strategy:
        # - 'minimize': Penalize hours to use fewest staff hours while meeting coverage
        # - 'balanced': No adjustment (default behavior)
        # - 'maximize': Reward hours to give staff as many hours as possible
        
        if self.scheduling_strategy == 'minimize':
            # Penalize each assigned hour to minimize total staffing cost
            WEIGHT_MINIMIZE_HOURS = 5
            for emp in self.employees:
                for day in self.days_open:
                    for hour in self.operating_hours:
                        for role_id in emp.roles:
                            key = (emp.id, day, hour, role_id)
                            if key in self._shift_vars:
                                objective_terms.append(-self._shift_vars[key] * WEIGHT_MINIMIZE_HOURS)
        
        elif self.scheduling_strategy == 'maximize':
            # Reward each assigned hour to maximize staff hours
            WEIGHT_MAXIMIZE_HOURS = 5
            for emp in self.employees:
                for day in self.days_open:
                    for hour in self.operating_hours:
                        for role_id in emp.roles:
                            key = (emp.id, day, hour, role_id)
                            if key in self._shift_vars:
                                objective_terms.append(self._shift_vars[key] * WEIGHT_MAXIMIZE_HOURS)
        
        # 'balanced' strategy: no adjustment, use default objective
        
        # =================================================================
        # OBJECTIVE FUNCTION
        # =================================================================
        self._model.Maximize(sum(objective_terms))
    
    def solve(self, find_alternative: bool = False, time_limit_seconds: float = 60.0) -> Schedule:
        """
        Solve the scheduling problem and return the schedule.
        
        Args:
            find_alternative: If True, find a different solution
            time_limit_seconds: Maximum solve time
            
        Returns:
            Schedule object with assignments and metrics
        """
        start_time = time.time()
        
        # Build model
        exclude = self._previous_solutions if find_alternative else []
        self._build_model(exclude_solutions=exclude)
        
        # Configure solver
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = time_limit_seconds
        solver.parameters.num_search_workers = 8
        
        # Solve
        status = solver.Solve(self._model)
        
        solve_time = (time.time() - start_time) * 1000
        
        # Extract solution
        schedule = Schedule()
        schedule.solve_time_ms = solve_time
        
        if status == cp_model.OPTIMAL or status == cp_model.FEASIBLE:
            schedule.is_feasible = True
            schedule.objective_value = int(solver.ObjectiveValue())
            
            # Store solution for exclusion
            current_solution = {}
            for key, var in self._shift_vars.items():
                current_solution[key] = solver.Value(var)
            self._previous_solutions.append(current_solution)
            schedule.solution_index = len(self._previous_solutions)
            
            # Build coverage matrix and assignments
            employee_hours = {emp.id: 0 for emp in self.employees}
            employee_overtime = {emp.id: 0 for emp in self.employees}
            
            for emp in self.employees:
                for day in self.days_open:
                    for hour in self.operating_hours:
                        for role_id in emp.roles:
                            key = (emp.id, day, hour, role_id)
                            if key in self._shift_vars and solver.Value(self._shift_vars[key]) == 1:
                                schedule.coverage_matrix[(day, hour, role_id)] = emp.id
                                
                                # Track slot assignments
                                slot_key = (day, hour)
                                if slot_key not in schedule.slot_assignments:
                                    schedule.slot_assignments[slot_key] = []
                                schedule.slot_assignments[slot_key].append((emp.id, role_id))
                                
                                employee_hours[emp.id] += 1
            
            schedule.employee_hours = employee_hours
            
            # Calculate overtime
            for emp in self.employees:
                hrs = employee_hours.get(emp.id, 0)
                if hrs > 40:
                    employee_overtime[emp.id] = hrs - 40
            schedule.employee_overtime = employee_overtime
            
            # Calculate consecutive days
            for emp in self.employees:
                max_consec = 0
                current_consec = 0
                for day in sorted(self.days_open):
                    if solver.Value(self._works_day_vars[(emp.id, day)]) == 1:
                        current_consec += 1
                        max_consec = max(max_consec, current_consec)
                    else:
                        current_consec = 0
                schedule.consecutive_days[emp.id] = max_consec
            
            # Build shift assignments (consolidated)
            schedule.assignments = self._extract_shift_assignments(solver)
            
            # Calculate metrics
            schedule.metrics = self._calculate_metrics(solver, schedule)
            schedule.total_hours_needed = schedule.metrics.total_slots_required
            schedule.total_hours_filled = schedule.metrics.total_slots_filled
        else:
            schedule.is_feasible = False
            schedule.solution_index = 0
        
        return schedule
    
    def _extract_shift_assignments(self, solver: cp_model.CpSolver) -> List[ShiftAssignment]:
        """Extract consolidated shift assignments."""
        assignments = []
        
        for emp in self.employees:
            for day in self.days_open:
                # Track hours worked in each role
                role_hours = {role_id: [] for role_id in emp.roles}
                
                for hour in self.operating_hours:
                    for role_id in emp.roles:
                        key = (emp.id, day, hour, role_id)
                        if key in self._shift_vars and solver.Value(self._shift_vars[key]) == 1:
                            role_hours[role_id].append(hour)
                
                # Create assignments for each role
                for role_id, hours in role_hours.items():
                    if not hours:
                        continue
                    
                    # Consolidate consecutive hours
                    hours = sorted(hours)
                    i = 0
                    while i < len(hours):
                        start_hour = hours[i]
                        end_hour = hours[i] + 1
                        
                        while i + 1 < len(hours) and hours[i + 1] == end_hour:
                            end_hour += 1
                            i += 1
                        
                        role = self.roles.get(role_id)
                        color = role.color if role else emp.color
                        
                        assignments.append(ShiftAssignment(
                            employee_id=emp.id,
                            employee_name=emp.name,
                            day=day,
                            start_hour=start_hour,
                            end_hour=end_hour,
                            role_id=role_id,
                            color=color
                        ))
                        i += 1
        
        return assignments
    
    def _calculate_metrics(self, solver: cp_model.CpSolver, schedule: Schedule) -> ScheduleMetrics:
        """Calculate detailed schedule metrics."""
        metrics = ScheduleMetrics()
        
        # Coverage - calculate what's filled vs required per slot
        metrics.total_slots_required = 0
        metrics.total_slots_filled = 0
        metrics.unfilled_slots = []
        metrics.unfilled_by_role = {}
        metrics.unfilled_by_day = {d: 0 for d in self.days_open}
        
        for req in self.coverage_requirements:
            if req.day not in self.days_open:
                continue
            if req.hour not in self.operating_hours:
                continue
                
            metrics.total_slots_required += req.min_staff
            
            # Count how many we actually filled for this role at this time
            filled = 0
            eligible = self._get_employees_for_role(req.role_id)
            for emp in eligible:
                key = (emp.id, req.day, req.hour, req.role_id)
                if key in self._shift_vars and solver.Value(self._shift_vars[key]) == 1:
                    filled += 1
            
            metrics.total_slots_filled += min(filled, req.min_staff)
            
            # Track unfilled
            if filled < req.min_staff:
                needed = req.min_staff - filled
                metrics.unfilled_slots.append({
                    "day": req.day,
                    "hour": req.hour,
                    "role_id": req.role_id,
                    "role_name": self.roles.get(req.role_id, Role(req.role_id, req.role_id, "#666")).name,
                    "needed": needed,
                    "filled": filled,
                    "required": req.min_staff
                })
                
                # Aggregate by role
                if req.role_id not in metrics.unfilled_by_role:
                    metrics.unfilled_by_role[req.role_id] = 0
                metrics.unfilled_by_role[req.role_id] += needed
                
                # Aggregate by day
                metrics.unfilled_by_day[req.day] += needed
                
                # Total hours still needed
                metrics.total_hours_still_needed += needed
        
        # Cost
        total_cost = 0.0
        for emp in self.employees:
            hours = schedule.employee_hours.get(emp.id, 0)
            ot_hours = schedule.employee_overtime.get(emp.id, 0)
            regular_hours = hours - ot_hours
            
            metrics.total_regular_hours += regular_hours
            metrics.total_overtime_hours += ot_hours
            
            # Regular pay + 1.5x overtime
            total_cost += (regular_hours * emp.hourly_rate) + (ot_hours * emp.hourly_rate * 1.5)
        
        metrics.estimated_labor_cost = total_cost
        
        # Weekend distribution
        weekend_days = [d for d in self.days_open if d >= 5]
        for emp in self.employees:
            weekend_hours = 0
            for day in weekend_days:
                if (emp.id, day) in self._works_day_vars:
                    if solver.Value(self._works_day_vars[(emp.id, day)]) == 1:
                        weekend_hours += 1
            metrics.weekend_distribution[emp.id] = weekend_hours
        
        # Preference tracking
        for emp in self.employees:
            for day in self.days_open:
                for hour in self.operating_hours:
                    is_working = False
                    for role_id in emp.roles:
                        key = (emp.id, day, hour, role_id)
                        if key in self._shift_vars and solver.Value(self._shift_vars[key]) == 1:
                            is_working = True
                            break
                    
                    if emp.prefers(day, hour):
                        if is_working:
                            metrics.preference_matches += 1
                        else:
                            metrics.preference_misses += 1
        
        # Consecutive day violations
        for emp in self.employees:
            max_consec = schedule.consecutive_days.get(emp.id, 0)
            preferred_max = emp.max_consecutive_days_preferred
            if max_consec > preferred_max:
                metrics.consecutive_day_violations += (max_consec - preferred_max)
        
        return metrics
    
    def reset(self):
        """Reset solver state."""
        self._previous_solutions = []
        self._model = None
        self._shift_vars = {}
        self._works_day_vars = {}


# Backwards compatibility alias
ScheduleSolver = AdvancedScheduleSolver


def format_schedule(schedule: Schedule, business: BusinessScenario) -> str:
    """Format a schedule as a readable string."""
    lines = []
    lines.append("=" * 90)
    lines.append(f"SCHEDULE #{schedule.solution_index} - {business.name}")
    lines.append(f"Coverage: {schedule.coverage_percentage:.1f}% | Solve: {schedule.solve_time_ms:.0f}ms | Score: {schedule.objective_value}")
    lines.append("=" * 90)
    
    # Header
    days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    header = f"{'Time':<8}"
    for day in business.days_open:
        header += f"{days[day]:<12}"
    lines.append(header)
    lines.append("-" * 90)
    
    # Build employee lookup
    emp_lookup = {emp.id: emp.name for emp in business.employees}
    
    # Hours
    for hour in business.get_operating_hours():
        row = f"{hour:02d}:00   "
        for day in business.days_open:
            slot_key = (day, hour)
            if slot_key in schedule.slot_assignments:
                names = []
                for emp_id, role_id in schedule.slot_assignments[slot_key]:
                    name = emp_lookup.get(emp_id, emp_id)[:6]
                    names.append(name)
                cell = ",".join(names)[:10]
                row += f"{cell:<12}"
            else:
                row += f"{'---':<12}"
        lines.append(row)
    
    lines.append("-" * 90)
    lines.append("\nEmployee Summary:")
    for emp in business.employees:
        hours = schedule.employee_hours.get(emp.id, 0)
        ot = schedule.employee_overtime.get(emp.id, 0)
        consec = schedule.consecutive_days.get(emp.id, 0)
        status = "OK" if emp.min_hours <= hours <= emp.max_hours else "!!"
        ot_str = f"+{ot}OT" if ot > 0 else ""
        lines.append(f"  {emp.name:<12} {hours:>2}hrs {ot_str:<6} consec:{consec} [{status}]")
    
    return "\n".join(lines)
