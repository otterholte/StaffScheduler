"""
OR-Tools CP-SAT solver for weekly staff scheduling.

This is the heart of the product. It turns a `BusinessScenario` (employees,
roles, availability, and hour-by-hour coverage requirements) into a weekly
schedule that satisfies every hard rule and does as well as possible on the
soft ones.

The model is built once per solve. Decision variables:

    x[e, d, h, r]   employee e works hour h on day d in role r   (bool)
    w[e, d, h]      employee e works hour h on day d in ANY role  (bool)
    start[e, d, h]  hour h is the first hour of a shift           (bool)
    end[e, d, h]    hour h is the last hour of a shift            (bool)
    day[e, d]       employee e works at all on day d              (bool)

Variables are only created where they can possibly be 1: the employee must be
available (and not on time-off), must hold the role, and there must be a
coverage requirement (with max_staff > 0) for that role at that hour. That
pruning is what makes the model small, and small models solve fast.

HARD RULES (never violated):
    - availability / approved time-off
    - one role per hour, max staff per requirement
    - weekly max hours (40 unless overtime is allowed)
    - max hours per day, max shift length, min shift length
    - max separate shifts per day, max split-shift days per week
    - max days per week (when the mode is "required")
    - supervision: an employee who needs supervision only works when a
      supervisor is also on the clock

SOFT RULES (penalised in the objective, in rough priority order):
    - coverage shortfall (dominant weight, extra on peak hours)
    - weekly minimum hours not reached
    - clopenings (too little rest between a closing and an opening shift)
    - too many consecutive days
    - max days per week (when the mode is "preferred")
    - overtime hours
    - fairness: max hours-shortfall across staff, weekend distribution
    - preferences (bonus for preferred hours)
    - fragmentation: extra shift starts, mid-shift role switches
    - scheduling strategy (minimise / balanced / maximise hours)

The solver stops as soon as it proves optimality, hits the time limit, or the
best solution has not improved for `stall_seconds`. A progress callback lets the
web layer show live status to the user.
"""

import os
import time
from typing import Callable, Dict, List, Optional, Set, Tuple

from ortools.sat.python import cp_model

from .models import (
    BusinessScenario, CoverageRequirement, Employee, Role, Schedule,
    ScheduleMetrics, ShiftAssignment,
)


# Day names used in human-readable diagnostics.
_DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def _fmt_hour(hour: int) -> str:
    """Format an integer hour (0-24) as '6am', '12pm', '5pm'."""
    hour = hour % 24
    if hour == 0:
        return "12am"
    if hour < 12:
        return f"{hour}am"
    if hour == 12:
        return "12pm"
    return f"{hour - 12}pm"


class _ProgressCallback(cp_model.CpSolverSolutionCallback):
    """Tracks improving solutions, reports progress, and stops on stall.

    CP-SAT calls `on_solution_callback` every time it finds a better solution.
    We record when that happened so we can stop the search once the solution
    has stopped improving for `stall_seconds` (there is no point burning the
    full time limit proving optimality of a schedule that is already as good
    as it is going to get in practice).
    """

    def __init__(self, shortfall_vars, stall_seconds: float, min_seconds: float,
                 progress: Optional[Callable[[dict], None]], started_at: float,
                 significant_delta: float = 40.0, stop_when_fully_covered: bool = False):
        super().__init__()
        self._shortfall_vars = shortfall_vars
        self._stall_seconds = stall_seconds
        self._min_seconds = min_seconds
        self._significant_delta = significant_delta
        # Pass 1 only cares about coverage: once every hour is filled there is
        # nothing left to improve, so stop immediately.
        self._stop_when_fully_covered = stop_when_fully_covered
        self.fully_covered = False
        self._progress = progress
        self._started_at = started_at
        self.solution_count = 0
        # Only *meaningful* improvements (a coverage slot, an hour of minimum
        # hours, a clopening) reset the stall timer. Improvements smaller than
        # `significant_delta` are cosmetic (a preference here, a shift start
        # there) and should not keep the user waiting.
        self.last_improvement_at = started_at
        self.best_objective = None
        self.best_shortfall = None

    def on_solution_callback(self):
        now = time.time()
        self.solution_count += 1
        objective = self.ObjectiveValue()
        if self.best_objective is None or objective - self.best_objective >= self._significant_delta:
            self.last_improvement_at = now
        self.best_objective = objective
        self.best_shortfall = int(sum(self.Value(v) for v in self._shortfall_vars))
        if self._stop_when_fully_covered and self.best_shortfall == 0:
            self.fully_covered = True
            self.StopSearch()
        if self._progress:
            self._progress({
                "phase": "improving",
                "solutions": self.solution_count,
                "objective": self.best_objective,
                "bound": self.BestObjectiveBound(),
                "unfilled_slots": self.best_shortfall,
                "elapsed": now - self._started_at,
            })

    def should_stop(self) -> bool:
        """Called from a timer thread; returns True when the search should end."""
        if self.solution_count == 0:
            return False
        now = time.time()
        if now - self._started_at < self._min_seconds:
            return False
        return (now - self.last_improvement_at) >= self._stall_seconds


class AdvancedScheduleSolver:
    """Builds and solves the weekly scheduling model for one business."""

    # ---- Objective weights (integers; larger = more important) --------------
    # Think of these as "how many preference-hours is this worth". A preferred
    # hour is 10, so a clopening (60) is worth giving up six preferred hours,
    # and one missing hour of coverage (1000) outranks everything else.
    WEIGHT_COVERAGE = 1000        # per missing person-hour of required coverage
    WEIGHT_PEAK_EXTRA = 250       # additional penalty when the missing hour is a peak hour
    WEIGHT_MIN_HOURS = 40         # per hour an employee lands under their weekly minimum
    WEIGHT_OVER_DAYS = 80         # per day over the (preferred) max days per week
    WEIGHT_CLOPEN = 60            # per closing shift followed by an opening shift
    WEIGHT_CONSECUTIVE = 40       # per day worked beyond the consecutive-days limit
    WEIGHT_SHIFT_START = 25       # per shift: fewer, longer shifts beat many short ones
    WEIGHT_SPLIT_DAY = 60         # per day with a split shift (allowed, but a last resort)
    WEIGHT_SHORT_DAY = 12         # per hour a worked day falls short of that person's usual shift length
    WEIGHT_TARGET_HOURS = 12      # per hour a full-timer lands under their contracted hours
    WEIGHT_FAIRNESS_HOURS = 25    # on the worst hours-shortfall across all staff
    WEIGHT_OVERTIME = 20          # per overtime hour (only while "avoid overtime" is on)
    WEIGHT_DAY_WORKED = 8         # per day worked: same hours in fewer days is better
    WEIGHT_START_VARIETY = 8      # per extra distinct start time in a person's week
    WEIGHT_WEEKEND_FAIRNESS = 10  # per weekend day for staff above the weekend average
    WEIGHT_PREFERENCE = 10        # bonus per hour worked inside a preferred window
    WEIGHT_ROLE_SWITCH = 4        # per mid-shift role change
    WEIGHT_STRATEGY_HOUR = 5      # per hour, sign depends on strategy

    def __init__(
        self,
        business: BusinessScenario,
        min_shift_hours: int = 2,
        max_hours_per_day: int = 8,
        max_splits_per_day: int = 2,
        max_split_shifts_per_week: int = 2,
        scheduling_strategy: str = "balanced",   # 'minimize' | 'balanced' | 'maximize'
        max_days_ft: int = 5,
        max_days_ft_mode: str = "required",      # 'off' | 'preferred' | 'required'
        max_days_pt: int = 3,
        max_days_pt_mode: str = "required",
        max_shift_hours: Optional[int] = None,   # defaults to max_hours_per_day
        min_rest_hours: int = 10,                # hours between a close and the next open
        max_consecutive_days: int = 6,           # soft limit on days worked in a row
        supervision_required: bool = True,       # enforce the needs_supervision rule
        weekend_fairness: bool = True,           # spread weekend work by history
        avoid_overtime: bool = True,             # penalise hours above 40
        progress_callback: Optional[Callable[[dict], None]] = None,
    ):
        self.business = business
        self.employees: List[Employee] = list(business.employees)
        self.roles: Dict[str, Role] = {r.id: r for r in business.roles}
        self.coverage_requirements: List[CoverageRequirement] = list(business.coverage_requirements)

        # Policy knobs (all validated so a bad value from the UI cannot break the model)
        self.min_shift_hours = max(1, int(min_shift_hours or 1))
        self.max_hours_per_day = max(self.min_shift_hours, int(max_hours_per_day or 8))
        self.max_shift_hours = max(self.min_shift_hours, int(max_shift_hours or self.max_hours_per_day))
        self.max_splits_per_day = max(1, int(max_splits_per_day or 1))
        self.max_split_shifts_per_week = max(0, int(max_split_shifts_per_week or 0))
        self.scheduling_strategy = scheduling_strategy if scheduling_strategy in ("minimize", "balanced", "maximize") else "balanced"
        self.max_days_ft = max(1, int(max_days_ft or 5))
        self.max_days_ft_mode = max_days_ft_mode if max_days_ft_mode in ("off", "preferred", "required") else "required"
        self.max_days_pt = max(1, int(max_days_pt or 3))
        self.max_days_pt_mode = max_days_pt_mode if max_days_pt_mode in ("off", "preferred", "required") else "required"
        self.min_rest_hours = max(0, int(min_rest_hours or 0))
        self.max_consecutive_days = max(1, int(max_consecutive_days or 6))
        self.supervision_required = bool(supervision_required)
        self.weekend_fairness = bool(weekend_fairness)
        self.avoid_overtime = bool(avoid_overtime)
        self.progress_callback = progress_callback

        # Operating window
        self.operating_hours: List[int] = list(business.get_operating_hours())
        self.days_open: List[int] = sorted(business.days_open)
        self.num_days = len(self.days_open)

        # Requirements indexed by slot; only requirements inside the operating
        # window and on open days can ever be met, so the rest are ignored.
        self._req_index: Dict[Tuple[int, int, str], CoverageRequirement] = {}
        for req in self.coverage_requirements:
            if req.day in self.days_open and req.hour in self.operating_hours and req.max_staff > 0:
                self._req_index[(req.day, req.hour, req.role_id)] = req

        # Solutions found so far (used to force *different* alternatives)
        self._previous_solutions: List[Set[Tuple[str, int, int]]] = []

        # Per-solve model state (populated by _build_model)
        self._model: Optional[cp_model.CpModel] = None
        self._x: Dict[Tuple[str, int, int, str], cp_model.IntVar] = {}
        self._w: Dict[Tuple[str, int, int], cp_model.IntVar] = {}
        self._start: Dict[Tuple[str, int, int], cp_model.IntVar] = {}
        self._end: Dict[Tuple[str, int, int], cp_model.IntVar] = {}
        self._day: Dict[Tuple[str, int], cp_model.IntVar] = {}
        self._hours: Dict[str, cp_model.LinearExpr] = {}
        self._shortfall: Dict[Tuple[int, int, str], cp_model.IntVar] = {}
        self._under_min: Dict[str, cp_model.IntVar] = {}
        self._clopen_vars: List[Tuple[str, int, int, int, cp_model.IntVar]] = []

    # ------------------------------------------------------------------ helpers

    def _report(self, phase: str, message: str, **extra):
        """Send a progress event to the web layer (if anyone is listening)."""
        if self.progress_callback:
            event = {"phase": phase, "message": message}
            event.update(extra)
            try:
                self.progress_callback(event)
            except Exception:
                pass  # progress reporting must never break a solve

    def _eligible_roles_at(self, emp: Employee, day: int, hour: int) -> List[str]:
        """Roles this employee could fill at (day, hour) given the requirements."""
        return [r for r in emp.roles if (day, hour, r) in self._req_index]

    def _weekly_cap(self, emp: Employee) -> int:
        """Hard weekly ceiling: max_hours, or 40 when overtime is not allowed."""
        return int(emp.max_hours) if emp.overtime_allowed else min(40, int(emp.max_hours))

    def _target_hours(self, emp: Employee) -> int:
        """Hours we *aim* to give this person (a soft goal, above their minimum).

        Full-timers are contracted for a full week, so their target is their
        max hours (capped at 40 unless overtime is allowed and not avoided).
        Part-timers' target is their minimum: extra hours go to them only when
        coverage needs it, which keeps the full-timers' schedules whole.
        """
        cap = self._weekly_cap(emp)
        if emp.is_full_time:
            if emp.overtime_allowed and not self.avoid_overtime:
                return cap
            return min(cap, 40)
        return min(cap, max(0, int(emp.min_hours)))

    def _target_shift_length(self, emp: Employee) -> int:
        """The shift length this person would normally work (used to discourage short days)."""
        max_days = self.max_days_ft if emp.is_full_time else self.max_days_pt
        weekly = self._target_hours(emp) if emp.is_full_time else max(int(emp.min_hours), 1)
        per_day = int(round(weekly / max(1, max_days)))
        # Nobody wants a 2-3 hour shift: aim for at least 6h (full-time) / 4h (part-time)
        floor = max(self.min_shift_hours, 6 if emp.is_full_time else 4)
        return max(self.min_shift_hours, min(self.max_shift_hours, max(floor, per_day)))

    # -------------------------------------------------------------- the model

    def _build_model(self, exclude_solutions: Optional[List[Set[Tuple[str, int, int]]]] = None,
                     coverage_only: bool = False, max_shortfall: Optional[int] = None):
        """Create all variables, constraints, and the objective.

        Args:
            exclude_solutions: earlier solutions an "alternative" must differ from
            coverage_only: pass 1 - objective is coverage alone (fast to solve)
            max_shortfall: pass 2 - total unfilled hours may not exceed this, and
                coverage leaves the objective so the solver can focus on the
                human factors (shift length, days, fairness, preferences)
        """
        m = cp_model.CpModel()
        self._model = m
        self._x, self._w, self._start, self._end, self._day = {}, {}, {}, {}, {}
        self._hours, self._shortfall, self._under_min, self._clopen_vars = {}, {}, {}, []
        objective: List[cp_model.LinearExpr] = []
        coverage_terms: List[cp_model.LinearExpr] = []
        # Every HARD rule is built in both passes. Soft terms go to `soft`,
        # which is the real objective in pass 2 and a discarded list in pass 1;
        # purely-soft sections loop over `soft_employees` (empty in pass 1).
        soft: List[cp_model.LinearExpr] = objective if not coverage_only else []
        soft_employees: List[Employee] = self.employees if not coverage_only else []

        hours = self.operating_hours
        H = len(hours)
        hour_pos = {h: i for i, h in enumerate(hours)}

        # ---------------------------------------------------------------
        # 1. Decision variables (only where an assignment is possible)
        # ---------------------------------------------------------------
        for emp in self.employees:
            for d in self.days_open:
                for h in hours:
                    if not emp.is_available(d, h):
                        continue
                    roles_here = self._eligible_roles_at(emp, d, h)
                    if not roles_here:
                        continue
                    if len(roles_here) == 1:
                        # Single eligible role: the role var IS the work var.
                        v = m.NewBoolVar(f"x_{emp.id}_{d}_{h}_{roles_here[0]}")
                        self._x[(emp.id, d, h, roles_here[0])] = v
                        self._w[(emp.id, d, h)] = v
                    else:
                        w = m.NewBoolVar(f"w_{emp.id}_{d}_{h}")
                        role_vars = []
                        for r in roles_here:
                            v = m.NewBoolVar(f"x_{emp.id}_{d}_{h}_{r}")
                            self._x[(emp.id, d, h, r)] = v
                            role_vars.append(v)
                        # Exactly one role when working, none when not.
                        m.Add(sum(role_vars) == w)
                        self._w[(emp.id, d, h)] = w

        # ---------------------------------------------------------------
        # 2. Shift structure per employee-day: starts, ends, day worked
        # ---------------------------------------------------------------
        for emp in self.employees:
            for d in self.days_open:
                day_w = [(h, self._w[(emp.id, d, h)]) for h in hours if (emp.id, d, h) in self._w]
                day_var = m.NewBoolVar(f"day_{emp.id}_{d}")
                self._day[(emp.id, d)] = day_var
                if not day_w:
                    m.Add(day_var == 0)
                    continue

                # day_var = OR(all hours)
                m.AddMaxEquality(day_var, [v for _, v in day_w])

                # Daily hour cap
                m.Add(sum(v for _, v in day_w) <= self.max_hours_per_day)

                # start[h] = w[h] AND NOT w[h-1];  end[h] = w[h] AND NOT w[h+1]
                # (a missing neighbour var means the employee cannot work then, i.e. 0)
                starts = []
                for h, v in day_w:
                    prev = self._w.get((emp.id, d, h - 1)) if (h - 1) in hour_pos else None
                    nxt = self._w.get((emp.id, d, h + 1)) if (h + 1) in hour_pos else None

                    if prev is None:
                        s = v
                    else:
                        s = m.NewBoolVar(f"s_{emp.id}_{d}_{h}")
                        m.AddBoolAnd([v, prev.Not()]).OnlyEnforceIf(s)
                        m.AddBoolOr([v.Not(), prev]).OnlyEnforceIf(s.Not())
                    self._start[(emp.id, d, h)] = s
                    starts.append(s)

                    if nxt is None:
                        e = v
                    else:
                        e = m.NewBoolVar(f"e_{emp.id}_{d}_{h}")
                        m.AddBoolAnd([v, nxt.Not()]).OnlyEnforceIf(e)
                        m.AddBoolOr([v.Not(), nxt]).OnlyEnforceIf(e.Not())
                    self._end[(emp.id, d, h)] = e

                    # Minimum shift length: a shift starting at h covers the next
                    # min_shift_hours hours. If that is impossible (end of the
                    # window, or an unavailable hour), a shift cannot start here.
                    needed = [self._w.get((emp.id, d, h + j)) for j in range(1, self.min_shift_hours)]
                    if any(n is None for n in needed):
                        m.Add(s == 0)
                    else:
                        for n in needed:
                            m.AddImplication(s, n)

                # Maximum shift length: no window of max_shift_hours+1 consecutive
                # hours can be fully worked. Only needed when the daily cap does
                # not already guarantee it.
                if self.max_shift_hours < self.max_hours_per_day:
                    L = self.max_shift_hours + 1
                    for i in range(0, H - L + 1):
                        window = [self._w.get((emp.id, d, hours[i + j])) for j in range(L)]
                        if all(v is not None for v in window):
                            m.Add(sum(window) <= self.max_shift_hours)

                # Shifts per day
                m.Add(sum(starts) <= self.max_splits_per_day)
                # Soft: prefer fewer, longer shifts and fewer days for the same hours
                for s in starts:
                    soft.append(-self.WEIGHT_SHIFT_START * s)
                soft.append(-self.WEIGHT_DAY_WORKED * day_var)

                # Soft: a worked day should look like a normal shift for this
                # person, not a 2-3 hour fragment. Penalise the hours a worked
                # day falls short of their usual shift length.
                target_len = self._target_shift_length(emp)
                if target_len > self.min_shift_hours and not coverage_only:
                    short_day = m.NewIntVar(0, target_len, f"shortday_{emp.id}_{d}")
                    m.Add(short_day >= target_len * day_var - sum(v for _, v in day_w))
                    soft.append(-self.WEIGHT_SHORT_DAY * short_day)

        # ---------------------------------------------------------------
        # 3. Split-shift days per week (hard)
        # ---------------------------------------------------------------
        if self.max_splits_per_day > 1:
            for emp in self.employees:
                split_days = []
                for d in self.days_open:
                    starts = [self._start[(emp.id, d, h)] for h in hours if (emp.id, d, h) in self._start]
                    if len(starts) < 2:
                        continue
                    has_split = m.NewBoolVar(f"split_{emp.id}_{d}")
                    m.Add(sum(starts) >= 2).OnlyEnforceIf(has_split)
                    m.Add(sum(starts) <= 1).OnlyEnforceIf(has_split.Not())
                    split_days.append(has_split)
                    soft.append(-self.WEIGHT_SPLIT_DAY * has_split)
                if split_days:
                    m.Add(sum(split_days) <= self.max_split_shifts_per_week)

        # ---------------------------------------------------------------
        # 4. Coverage: shortfall variables (soft) and max staff (hard)
        # ---------------------------------------------------------------
        for (d, h, r), req in self._req_index.items():
            staffed = [self._x[(e.id, d, h, r)] for e in self.employees if (e.id, d, h, r) in self._x]
            need = int(req.min_staff)
            if need <= 0 and not staffed:
                continue
            if staffed:
                m.Add(sum(staffed) <= int(req.max_staff))
            if need > 0:
                short = m.NewIntVar(0, need, f"short_{d}_{h}_{r}")
                m.Add(short >= need - sum(staffed))
                self._shortfall[(d, h, r)] = short
                weight = self.WEIGHT_COVERAGE + (self.WEIGHT_PEAK_EXTRA if req.is_peak else 0)
                coverage_terms.append(-weight * short)

        if max_shortfall is not None and self._shortfall:
            # Pass 2: coverage is locked at the level pass 1 proved achievable,
            # so it can leave the objective entirely.
            m.Add(sum(self._shortfall.values()) <= max_shortfall)
        else:
            objective.extend(coverage_terms)

        # ---------------------------------------------------------------
        # 5. Weekly hours: hard max, soft min, overtime
        # ---------------------------------------------------------------
        max_possible = H * self.num_days
        for emp in self.employees:
            week_vars = [self._w[(emp.id, d, h)] for d in self.days_open for h in hours if (emp.id, d, h) in self._w]
            total = sum(week_vars) if week_vars else 0
            self._hours[emp.id] = total

            cap = self._weekly_cap(emp)
            if week_vars:
                m.Add(total <= cap)

            # Soft minimum: penalty for every hour under min_hours
            min_h = max(0, int(emp.min_hours))
            under = m.NewIntVar(0, max(min_h, 0), f"under_{emp.id}")
            if min_h > 0:
                m.Add(under >= min_h - total)
                soft.append(-self.WEIGHT_MIN_HOURS * under)
            else:
                m.Add(under == 0)
            self._under_min[emp.id] = under

            # Soft target: full-timers should get their contracted week before
            # extra hours go to part-timers (weaker than the minimum, so
            # nobody's minimum is sacrificed for someone else's target).
            target_h = self._target_hours(emp)
            if week_vars and target_h > min_h and not coverage_only:
                under_target = m.NewIntVar(0, target_h - min_h, f"undertarget_{emp.id}")
                m.Add(under_target >= target_h - total - under)
                soft.append(-self.WEIGHT_TARGET_HOURS * under_target)

            # Overtime: when "avoid overtime" is on, every hour past 40 costs a
            # little (coverage still wins). When it is off, overtime is free and
            # the target above actively uses it.
            if self.avoid_overtime and emp.overtime_allowed and cap > 40 and week_vars and not coverage_only:
                ot = m.NewIntVar(0, cap - 40, f"ot_{emp.id}")
                m.Add(ot >= total - 40)
                soft.append(-self.WEIGHT_OVERTIME * ot)

        # Fairness on hours: penalise the worst shortfall so it is shared
        if self._under_min and not coverage_only:
            worst = m.NewIntVar(0, max(max(int(e.min_hours), 0) for e in self.employees) if self.employees else 0, "worst_under")
            m.AddMaxEquality(worst, list(self._under_min.values()))
            soft.append(-self.WEIGHT_FAIRNESS_HOURS * worst)

        # ---------------------------------------------------------------
        # 6. Days per week (hard or soft by classification)
        # ---------------------------------------------------------------
        for emp in self.employees:
            days_worked = sum(self._day[(emp.id, d)] for d in self.days_open)
            # Everyone gets at least one day off a week, whatever the settings say.
            if self.num_days >= 6:
                m.Add(days_worked <= self.num_days - 1)

            max_days = self.max_days_ft if emp.is_full_time else self.max_days_pt
            mode = self.max_days_ft_mode if emp.is_full_time else self.max_days_pt_mode
            if mode == "off":
                continue
            if mode == "required":
                m.Add(days_worked <= max_days)
            elif not coverage_only:
                over = m.NewIntVar(0, max(0, self.num_days - max_days), f"overdays_{emp.id}")
                m.Add(over >= days_worked - max_days)
                soft.append(-self.WEIGHT_OVER_DAYS * over)

        # ---------------------------------------------------------------
        # 6b. Consistent start times (soft) - people like a predictable week
        # ---------------------------------------------------------------
        for emp in soft_employees:
            any_start = []
            for h in hours:
                starts_h = [self._start[(emp.id, d, h)] for d in self.days_open if (emp.id, d, h) in self._start]
                if not starts_h:
                    continue
                a = m.NewBoolVar(f"anystart_{emp.id}_{h}")
                m.AddMaxEquality(a, starts_h)
                any_start.append(a)
            if len(any_start) > 1:
                variety = m.NewIntVar(0, len(any_start), f"variety_{emp.id}")
                m.Add(variety >= sum(any_start) - 1)
                soft.append(-self.WEIGHT_START_VARIETY * variety)

        # ---------------------------------------------------------------
        # 7. Consecutive days (soft) - any run of K+1 calendar days
        # ---------------------------------------------------------------
        K = self.max_consecutive_days
        if self.num_days > K:
            for emp in soft_employees:
                for i in range(0, self.num_days - K):
                    window_days = self.days_open[i:i + K + 1]
                    # Only a run of truly consecutive calendar days counts
                    if window_days[-1] - window_days[0] != K:
                        continue
                    over = m.NewIntVar(0, 1, f"consec_{emp.id}_{window_days[0]}")
                    m.Add(over >= sum(self._day[(emp.id, d)] for d in window_days) - K)
                    soft.append(-self.WEIGHT_CONSECUTIVE * over)

        # ---------------------------------------------------------------
        # 8. Rest between shifts / clopenings (soft)
        # ---------------------------------------------------------------
        if self.min_rest_hours > 0 and hours:
            for emp in soft_employees:
                for d in self.days_open:
                    if d + 1 not in self.days_open:
                        continue
                    for h1 in hours:
                        e_var = self._end.get((emp.id, d, h1))
                        if e_var is None:
                            continue
                        for h2 in hours:
                            s_var = self._start.get((emp.id, d + 1, h2))
                            if s_var is None:
                                continue
                            rest = (24 - (h1 + 1)) + h2
                            if rest >= self.min_rest_hours:
                                break  # later starts only give more rest
                            c = m.NewBoolVar(f"clopen_{emp.id}_{d}_{h1}_{h2}")
                            m.AddBoolOr([e_var.Not(), s_var.Not(), c])
                            self._clopen_vars.append((emp.id, d, h1, h2, c))
                            soft.append(-self.WEIGHT_CLOPEN * c)

        # ---------------------------------------------------------------
        # 9. Supervision (hard)
        # ---------------------------------------------------------------
        if self.supervision_required:
            supervisors = [e for e in self.employees if e.can_supervise]
            for emp in self.employees:
                if not emp.needs_supervision:
                    continue
                for d in self.days_open:
                    for h in hours:
                        w = self._w.get((emp.id, d, h))
                        if w is None:
                            continue
                        sup_vars = [self._w[(s.id, d, h)] for s in supervisors
                                    if s.id != emp.id and (s.id, d, h) in self._w]
                        if sup_vars:
                            m.Add(sum(sup_vars) >= 1).OnlyEnforceIf(w)
                        else:
                            m.Add(w == 0)

        # ---------------------------------------------------------------
        # 10. Preferences (soft bonus)
        # ---------------------------------------------------------------
        for emp in soft_employees:
            if not emp.preferences:
                continue
            for d in self.days_open:
                for h in hours:
                    w = self._w.get((emp.id, d, h))
                    if w is not None and emp.prefers(d, h):
                        soft.append(self.WEIGHT_PREFERENCE * w)

        # ---------------------------------------------------------------
        # 11. Role switches mid-shift (soft)
        # ---------------------------------------------------------------
        for emp in soft_employees:
            if len(emp.roles) < 2:
                continue
            for d in self.days_open:
                for h in hours:
                    if (h + 1) not in hour_pos:
                        continue
                    w_next = self._w.get((emp.id, d, h + 1))
                    if w_next is None:
                        continue
                    for r in emp.roles:
                        x_now = self._x.get((emp.id, d, h, r))
                        if x_now is None:
                            continue
                        x_next = self._x.get((emp.id, d, h + 1, r))
                        # worked role r at h, still working at h+1, but not role r
                        sw = m.NewBoolVar(f"sw_{emp.id}_{d}_{h}_{r}")
                        if x_next is None:
                            m.AddBoolOr([x_now.Not(), w_next.Not(), sw])
                        else:
                            m.AddBoolOr([x_now.Not(), w_next.Not(), x_next, sw])
                        soft.append(-self.WEIGHT_ROLE_SWITCH * sw)

        # ---------------------------------------------------------------
        # 12. Weekend fairness (soft, uses history from previous weeks)
        # ---------------------------------------------------------------
        weekend_days = [d for d in self.days_open if d >= 5]
        if self.weekend_fairness and weekend_days and self.employees:
            avg = sum(e.weekend_shifts_worked for e in self.employees) / len(self.employees)
            for emp in soft_employees:
                excess = emp.weekend_shifts_worked - avg
                if excess <= 0:
                    continue
                penalty = int(round(excess * self.WEIGHT_WEEKEND_FAIRNESS))
                if penalty <= 0:
                    continue
                for d in weekend_days:
                    soft.append(-penalty * self._day[(emp.id, d)])

        # ---------------------------------------------------------------
        # 13. Scheduling strategy (soft)
        # ---------------------------------------------------------------
        # minimize: every hour costs, and pricier staff cost more (fewer hours,
        #           cheaper coverage - minimums and targets still apply)
        # maximize: every hour is a small bonus (fill optional capacity)
        if self.scheduling_strategy != "balanced" and not coverage_only:
            emp_by_id = {e.id: e for e in self.employees}
            for emp_id, total in self._hours.items():
                if isinstance(total, int):
                    continue
                if self.scheduling_strategy == "minimize":
                    rate = emp_by_id[emp_id].hourly_rate or 0.0
                    soft.append(-(self.WEIGHT_STRATEGY_HOUR + int(rate // 4)) * total)
                else:
                    soft.append(self.WEIGHT_STRATEGY_HOUR * total)

        if coverage_only:
            # Small tie-breakers (coverage is worth 1000) so pass 1 already hands
            # pass 2 a tidy hint: few shift starts, few days.
            for s in self._start.values():
                objective.append(-3 * s)
            for dv in self._day.values():
                objective.append(-2 * dv)

        # ---------------------------------------------------------------
        # 14. Alternatives: must differ meaningfully from earlier solutions
        # ---------------------------------------------------------------
        if exclude_solutions:
            self._add_alternative_constraints(m, exclude_solutions)

        m.Maximize(sum(objective) if objective else 0)

    def _add_alternative_constraints(self, m: cp_model.CpModel, exclude_solutions):
        """Force a Hamming distance from each earlier solution (>= 10%, min 3 hours)."""
        all_keys = list(self._w.keys())
        for prev in exclude_solutions:
            worked = [self._w[k] for k in all_keys if k in prev]
            not_worked = [self._w[k] for k in all_keys if k not in prev]
            min_diff = max(3, len(worked) // 10)
            if not worked and not not_worked:
                continue
            m.Add(sum(v.Not() for v in worked) + sum(not_worked) >= min(min_diff, len(all_keys)))

    # ------------------------------------------------------------------ solve

    def solve(
        self,
        find_alternative: bool = False,
        time_limit_seconds: float = 25.0,
        stall_seconds: float = 3.0,
        min_seconds: float = 1.5,
    ) -> Schedule:
        """Build and solve the model, returning a populated `Schedule`.

        Args:
            find_alternative: force a solution that differs from earlier ones
            time_limit_seconds: hard wall-clock limit for the search
            stall_seconds: stop early once no better solution appears for this long
            min_seconds: never stop before this much time has passed (gives the
                solver a fair chance on medium problems)
        """
        started = time.time()
        self._report("building", "Analyzing staff, roles, and coverage needs...")
        exclude = self._previous_solutions if find_alternative else None

        # ---- Pass 1: how much coverage is achievable at all? ---------------
        # Only the hard rules and the coverage objective: this solves fast and
        # gives pass 2 both a coverage guarantee and a good starting point.
        self._build_model(exclude_solutions=exclude, coverage_only=True)
        num_vars = len(self._w)
        self._report("solving", f"Filling every required hour across {num_vars:,} possible assignments...",
                     variables=num_vars)
        hint = self._previous_solutions[-1] if self._previous_solutions else None
        # Coverage is what the manager sees first, so pass 1 gets up to half the
        # budget and is not cut short unless it has been stuck for a while.
        pass1_budget = max(3.0, float(time_limit_seconds) * 0.5)
        status1, solver1, cb1 = self._run(pass1_budget, stall_seconds=max(2.0, stall_seconds),
                                          min_seconds=1.0, hint=hint, started=started,
                                          significant_delta=float(self.WEIGHT_COVERAGE),
                                          stop_when_fully_covered=True)
        if status1 not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            schedule = Schedule()
            schedule.solve_time_ms = (time.time() - started) * 1000.0
            schedule.is_feasible = False
            schedule.solution_index = 0
            schedule.metrics = self._infeasibility_metrics()
            self._report("done", "No schedule satisfies the hard rules.", feasible=False)
            return schedule
        best_shortfall = int(sum(solver1.Value(v) for v in self._shortfall.values()))
        pass1_solution = {k for k, v in self._w.items() if solver1.Value(v) == 1}

        # ---- Pass 2: with coverage locked in, make it a good week for people --
        self._build_model(exclude_solutions=exclude, max_shortfall=best_shortfall)
        self._report("solving", "Balancing hours, shift lengths, rest, and preferences...",
                     unfilled_slots=best_shortfall)
        remaining = max(3.0, float(time_limit_seconds) - (time.time() - started))
        status, solver, callback = self._run(remaining, stall_seconds=stall_seconds + 1.5,
                                             min_seconds=max(min_seconds, 3.0),
                                             hint=pass1_solution, started=started,
                                             significant_delta=float(self.WEIGHT_MIN_HOURS))
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            # Should not happen (pass 1's solution satisfies pass 2), but fall
            # back to the coverage-only result rather than fail.
            self._build_model(exclude_solutions=exclude, coverage_only=True)
            status, solver, callback = self._run(2.0, 1.0, 0.0, hint=pass1_solution, started=started,
                                                 significant_delta=float(self.WEIGHT_COVERAGE))

        schedule = Schedule()
        schedule.solve_time_ms = (time.time() - started) * 1000.0

        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            schedule.is_feasible = False
            schedule.solution_index = 0
            schedule.metrics = self._infeasibility_metrics()
            self._report("done", "No schedule satisfies the hard rules.", feasible=False)
            return schedule

        schedule.is_feasible = True
        schedule.objective_value = int(round(solver.ObjectiveValue()))
        schedule.solver_status = "optimal" if status == cp_model.OPTIMAL else "feasible"

        # Remember this solution so an "alternative" is forced to be different
        worked = {k for k, v in self._w.items() if solver.Value(v) == 1}
        self._previous_solutions.append(worked)
        schedule.solution_index = len(self._previous_solutions)

        # Coverage matrix + per-slot assignments
        employee_hours = {e.id: 0 for e in self.employees}
        for (emp_id, d, h, r), var in self._x.items():
            if solver.Value(var) != 1:
                continue
            schedule.coverage_matrix[(d, h, r)] = emp_id
            schedule.slot_assignments.setdefault((d, h), []).append((emp_id, r))
            employee_hours[emp_id] += 1
        for slot in schedule.slot_assignments.values():
            slot.sort()
        schedule.employee_hours = employee_hours
        schedule.employee_overtime = {e.id: max(0, employee_hours[e.id] - 40) for e in self.employees}

        # Consecutive days per employee
        for emp in self.employees:
            best = cur = 0
            prev_day = None
            for d in self.days_open:
                if solver.Value(self._day[(emp.id, d)]) == 1:
                    cur = cur + 1 if prev_day == d - 1 else 1
                    best = max(best, cur)
                else:
                    cur = 0
                prev_day = d if solver.Value(self._day[(emp.id, d)]) == 1 else None
            schedule.consecutive_days[emp.id] = best

        schedule.assignments = self._extract_shift_assignments(solver)
        schedule.metrics = self._calculate_metrics(solver, schedule)
        schedule.total_hours_needed = schedule.metrics.total_slots_required
        schedule.total_hours_filled = schedule.metrics.total_slots_filled

        self._report(
            "done",
            f"Done in {schedule.solve_time_ms / 1000:.1f}s - {schedule.metrics.to_dict()['coverage_percentage']}% coverage.",
            feasible=True,
        )
        return schedule

    def _run(self, time_limit: float, stall_seconds: float, min_seconds: float,
             hint: Optional[Set[Tuple[str, int, int]]], started: float, significant_delta: float,
             stop_when_fully_covered: bool = False):
        """Solve the currently built model with early stopping. Returns (status, solver, callback)."""
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = float(time_limit)
        solver.parameters.num_workers = max(2, min(8, os.cpu_count() or 4))
        solver.parameters.relative_gap_limit = 0.002   # 0.2% of optimum is "good enough"
        solver.parameters.log_search_progress = False

        # Warm start: a known-good assignment lets the search improve instead of hunt
        if hint is not None:
            for key, var in self._w.items():
                self._model.AddHint(var, 1 if key in hint else 0)

        callback = _ProgressCallback(
            list(self._shortfall.values()), stall_seconds, min_seconds,
            self.progress_callback, started, significant_delta=significant_delta,
            stop_when_fully_covered=stop_when_fully_covered,
        )

        # A small watchdog thread implements the stall-based early stop.
        import threading
        stop_event = threading.Event()

        def watchdog():
            while not stop_event.wait(0.25):
                if callback.should_stop():
                    solver.StopSearch()
                    return

        watcher = threading.Thread(target=watchdog, daemon=True)
        watcher.start()
        try:
            status = solver.Solve(self._model, callback)
        finally:
            stop_event.set()
            watcher.join(timeout=1.0)
        return status, solver, callback

    # ------------------------------------------------------------ extraction

    def _extract_shift_assignments(self, solver: cp_model.CpSolver) -> List[ShiftAssignment]:
        """Merge consecutive worked hours (per role) into shift blocks."""
        assignments: List[ShiftAssignment] = []
        for emp in self.employees:
            for d in self.days_open:
                # hour -> role worked
                worked: Dict[int, str] = {}
                for h in self.operating_hours:
                    for r in emp.roles:
                        var = self._x.get((emp.id, d, h, r))
                        if var is not None and solver.Value(var) == 1:
                            worked[h] = r
                if not worked:
                    continue
                hrs = sorted(worked)
                i = 0
                while i < len(hrs):
                    start_h = hrs[i]
                    role_id = worked[start_h]
                    end_h = start_h + 1
                    while i + 1 < len(hrs) and hrs[i + 1] == end_h and worked[hrs[i + 1]] == role_id:
                        end_h += 1
                        i += 1
                    role = self.roles.get(role_id)
                    assignments.append(ShiftAssignment(
                        employee_id=emp.id,
                        employee_name=emp.name,
                        day=d,
                        start_hour=start_h,
                        end_hour=end_h,
                        role_id=role_id,
                        color=role.color if role else emp.color,
                    ))
                    i += 1
        assignments.sort(key=lambda a: (a.day, a.start_hour, a.employee_name))
        return assignments

    def _calculate_metrics(self, solver: cp_model.CpSolver, schedule: Schedule) -> ScheduleMetrics:
        """Compute coverage, cost, fairness, and diagnostic information."""
        metrics = ScheduleMetrics()
        metrics.unfilled_by_day = {d: 0 for d in self.days_open}

        # Per-slot staffing counts from the solution
        staffed_count: Dict[Tuple[int, int, str], int] = {}
        for (emp_id, d, h, r), var in self._x.items():
            if solver.Value(var) == 1:
                staffed_count[(d, h, r)] = staffed_count.get((d, h, r), 0) + 1

        # Hours/days per employee (for diagnostics)
        emp_by_id = {e.id: e for e in self.employees}
        days_worked = {e.id: sum(solver.Value(self._day[(e.id, d)]) for d in self.days_open) for e in self.employees}
        hours_by_day = {}
        for (emp_id, d, h), var in self._w.items():
            if solver.Value(var) == 1:
                hours_by_day[(emp_id, d)] = hours_by_day.get((emp_id, d), 0) + 1

        for req in self.coverage_requirements:
            key = (req.day, req.hour, req.role_id)
            if key not in self._req_index or req.min_staff <= 0:
                continue
            filled = staffed_count.get(key, 0)
            metrics.total_slots_required += req.min_staff
            metrics.total_slots_filled += min(filled, req.min_staff)
            if filled >= req.min_staff:
                continue
            needed = req.min_staff - filled
            role_name = self.roles[req.role_id].name if req.role_id in self.roles else req.role_id
            metrics.unfilled_slots.append({
                "day": req.day, "hour": req.hour, "role_id": req.role_id,
                "role_name": role_name, "needed": needed, "filled": filled,
                "required": req.min_staff, "is_peak": bool(req.is_peak),
                "reason": self._explain_gap(req, emp_by_id, days_worked, hours_by_day, schedule),
            })
            metrics.unfilled_by_role[req.role_id] = metrics.unfilled_by_role.get(req.role_id, 0) + needed
            metrics.unfilled_by_day[req.day] = metrics.unfilled_by_day.get(req.day, 0) + needed
            metrics.total_hours_still_needed += needed

        # Labour cost
        total_cost = 0.0
        for emp in self.employees:
            hrs = schedule.employee_hours.get(emp.id, 0)
            ot = schedule.employee_overtime.get(emp.id, 0)
            regular = hrs - ot
            metrics.total_regular_hours += regular
            metrics.total_overtime_hours += ot
            total_cost += regular * emp.hourly_rate + ot * emp.hourly_rate * 1.5
        metrics.estimated_labor_cost = total_cost

        # Weekend distribution + preferences + consecutive days
        weekend_days = [d for d in self.days_open if d >= 5]
        for emp in self.employees:
            metrics.weekend_distribution[emp.id] = sum(
                solver.Value(self._day[(emp.id, d)]) for d in weekend_days
            )
            for d in self.days_open:
                for h in self.operating_hours:
                    if not emp.prefers(d, h):
                        continue
                    w = self._w.get((emp.id, d, h))
                    if w is not None and solver.Value(w) == 1:
                        metrics.preference_matches += 1
                    else:
                        metrics.preference_misses += 1
            over = schedule.consecutive_days.get(emp.id, 0) - emp.max_consecutive_days_preferred
            if over > 0:
                metrics.consecutive_day_violations += over

        # Per-employee warnings (hours under minimum, clopenings)
        for emp in self.employees:
            hrs = schedule.employee_hours.get(emp.id, 0)
            if emp.min_hours > 0 and hrs < emp.min_hours:
                metrics.employees_under_min.append({
                    "employee_id": emp.id, "employee_name": emp.name,
                    "hours": hrs, "min_hours": emp.min_hours,
                })
        for emp_id, d, h1, h2, var in self._clopen_vars:
            if solver.Value(var) == 1:
                metrics.clopenings.append({
                    "employee_id": emp_id, "employee_name": emp_by_id[emp_id].name,
                    "close_day": d, "close_hour": h1 + 1, "open_day": d + 1, "open_hour": h2,
                    "rest_hours": (24 - (h1 + 1)) + h2,
                })

        metrics.unfilled_ranges = self._group_unfilled(metrics.unfilled_slots)
        metrics.suggestions = self._build_suggestions(metrics)
        return metrics

    @staticmethod
    def _group_unfilled(unfilled_slots: List[Dict]) -> List[Dict]:
        """Merge hour-by-hour gaps into shift-sized ranges for the UI.

        "Tue 10am, Tue 11am, Tue 12pm, Tue 1pm (Manager)" becomes one entry:
        Tue 10am-2pm, Manager, needed 1. Grouped by day, role and reason.
        """
        by_key: Dict[Tuple[int, str, str], List[Dict]] = {}
        for s in unfilled_slots:
            by_key.setdefault((s["day"], s["role_id"], s.get("reason", "")), []).append(s)
        ranges: List[Dict] = []
        for (day, role_id, reason), slots in by_key.items():
            slots.sort(key=lambda s: s["hour"])
            cur = None
            for s in slots:
                if cur and s["hour"] == cur["end_hour"]:
                    cur["end_hour"] = s["hour"] + 1
                    cur["needed"] = max(cur["needed"], s["needed"])
                    cur["is_peak"] = cur["is_peak"] or bool(s.get("is_peak"))
                    continue
                cur = {
                    "day": day, "role_id": role_id, "role_name": s.get("role_name", role_id),
                    "start_hour": s["hour"], "end_hour": s["hour"] + 1, "needed": s["needed"],
                    "is_peak": bool(s.get("is_peak")), "reason": reason,
                }
                ranges.append(cur)
        ranges.sort(key=lambda r: (r["day"], r["start_hour"], r["role_name"]))
        return ranges

    def _explain_gap(self, req, emp_by_id, days_worked, hours_by_day, schedule) -> str:
        """Best-effort, human-readable reason a required slot stayed unfilled."""
        day_name = _DAY_NAMES[req.day]
        when = f"{day_name} {_fmt_hour(req.hour)}"
        role_name = self.roles[req.role_id].name if req.role_id in self.roles else req.role_id

        eligible = [e for e in self.employees if req.role_id in e.roles]
        if not eligible:
            return f"No staff member has the {role_name} role."
        available = [e for e in eligible if e.is_available(req.day, req.hour)]
        if not available:
            return f"Nobody with the {role_name} role is available on {when}."

        # Everyone available is already working this hour (in another role) or capped out
        blocked_reasons = []
        for e in available:
            working_now = any(
                (e.id, req.day, req.hour, r) in self._x and schedule.coverage_matrix.get((req.day, req.hour, r)) == e.id
                for r in e.roles
            )
            if working_now:
                blocked_reasons.append("already working another role")
                continue
            cap = e.max_hours if e.overtime_allowed else min(40, e.max_hours)
            if schedule.employee_hours.get(e.id, 0) >= cap:
                blocked_reasons.append("at max weekly hours")
                continue
            max_days = self.max_days_ft if e.is_full_time else self.max_days_pt
            mode = self.max_days_ft_mode if e.is_full_time else self.max_days_pt_mode
            if mode == "required" and days_worked.get(e.id, 0) >= max_days and hours_by_day.get((e.id, req.day), 0) == 0:
                blocked_reasons.append("at max days per week")
                continue
            if hours_by_day.get((e.id, req.day), 0) >= self.max_hours_per_day:
                blocked_reasons.append("at max hours for the day")
                continue
            if e.needs_supervision and self.supervision_required:
                blocked_reasons.append("needs a supervisor on shift")
                continue
            blocked_reasons.append("shift-length or split-shift rules")

        counts: Dict[str, int] = {}
        for r in blocked_reasons:
            counts[r] = counts.get(r, 0) + 1
        top = max(counts.items(), key=lambda kv: kv[1])[0]
        return f"{len(available)} available {role_name}(s), but they are {top}."

    def _build_suggestions(self, metrics: ScheduleMetrics) -> List[str]:
        """Turn the diagnostics into concrete, actionable suggestions."""
        tips: List[str] = []
        if metrics.unfilled_slots:
            reasons = [s["reason"] for s in metrics.unfilled_slots]
            if any("max weekly hours" in r for r in reasons):
                tips.append("Some gaps exist because staff hit their weekly max hours. Raising max hours, allowing overtime, or hiring another person for that role would close them.")
            if any("max days per week" in r for r in reasons):
                tips.append("Some staff are at their max days per week. Setting 'Max days per week' to 'Preferred' instead of 'Required' lets the scheduler use them when needed.")
            if any("is available" in r or "has the" in r for r in reasons):
                tips.append("Some hours have nobody available with the required role. Consider cross-training staff into that role or asking for extra availability on those days.")
            if any("split-shift" in r for r in reasons):
                tips.append("Shift-length and split-shift rules are blocking some assignments. Allowing more split shifts per week or a shorter minimum shift may help.")
            if any("needs a supervisor" in r for r in reasons):
                tips.append("Staff who need supervision could not be scheduled without a supervisor present. Adding another supervisor gives you more flexibility.")
            # Single point of failure: a role with only one qualified person
            role_counts: Dict[str, int] = {}
            for e in self.employees:
                for r in e.roles:
                    role_counts[r] = role_counts.get(r, 0) + 1
            for rid, cnt in role_counts.items():
                if cnt == 1 and rid in metrics.unfilled_by_role:
                    name = self.roles[rid].name if rid in self.roles else rid
                    tips.append(f"Only one person holds the {name} role, so any call-out leaves it uncovered. Hiring or cross-training a backup is worth considering.")
        if metrics.clopenings:
            tips.append(f"{len(metrics.clopenings)} 'clopening' (closing then opening with little rest) could not be avoided. Widening availability on those days would remove them.")
        if metrics.employees_under_min:
            names = ", ".join(e["employee_name"] for e in metrics.employees_under_min[:4])
            tips.append(f"Under their minimum hours this week: {names}. There simply are not enough required hours for everyone; reduce their minimums or add coverage.")
        return tips

    def _infeasibility_metrics(self) -> ScheduleMetrics:
        """Explain a hard infeasibility as well as we can (rare after the soft-min change)."""
        metrics = ScheduleMetrics()
        metrics.suggestions = [
            "The hard rules could not all be satisfied at once. This usually means the max hours per day is smaller than the minimum shift length, or every hour of a required role falls outside everyone's availability while a supervision rule applies. Relax one rule and try again."
        ]
        return metrics

    def reset(self):
        """Forget previous solutions (so the next solve is not forced to differ)."""
        self._previous_solutions = []
        self._model = None


# Backwards-compatible alias used by older imports
ScheduleSolver = AdvancedScheduleSolver


def format_schedule(schedule: Schedule, business: BusinessScenario) -> str:
    """Render a schedule as a readable text grid (handy for debugging/tests)."""
    lines = ["=" * 90,
             f"SCHEDULE #{schedule.solution_index} - {business.name}",
             f"Coverage: {schedule.coverage_percentage:.1f}% | Solve: {schedule.solve_time_ms:.0f}ms | Score: {schedule.objective_value}",
             "=" * 90]
    days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    header = f"{'Time':<8}" + "".join(f"{days[d]:<12}" for d in business.days_open)
    lines.append(header)
    lines.append("-" * 90)
    names = {e.id: e.name for e in business.employees}
    for hour in business.get_operating_hours():
        row = f"{hour:02d}:00   "
        for d in business.days_open:
            slot = schedule.slot_assignments.get((d, hour))
            cell = ",".join(names.get(e, e)[:6] for e, _ in slot)[:10] if slot else "---"
            row += f"{cell:<12}"
        lines.append(row)
    lines.append("-" * 90)
    lines.append("\nEmployee Summary:")
    for emp in business.employees:
        hrs = schedule.employee_hours.get(emp.id, 0)
        ot = schedule.employee_overtime.get(emp.id, 0)
        consec = schedule.consecutive_days.get(emp.id, 0)
        status = "OK" if emp.min_hours <= hrs <= emp.max_hours else "!!"
        ot_str = f"+{ot}OT" if ot else ""
        lines.append(f"  {emp.name:<12} {hrs:>2}hrs {ot_str:<6} consec:{consec} [{status}]")
    return "\n".join(lines)
