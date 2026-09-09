/**
 * Staff Scheduler Pro - Main Application
 * Professional UI/UX with full CRUD operations
 */

// ==================== URL ROUTING HELPERS ====================
const PAGE_SLUGS = INITIAL_DATA.pageSlugs || {
    'schedule': 'schedule',
    'staff': 'settings',
    'availability': 'settings',
    'requirements': 'help'
};

const TAB_TO_SLUG = INITIAL_DATA.tabToSlug || {
    'schedule': 'schedule',
    'settings': 'availability',
    'help': 'requirements'
};

function slugify(text) {
    return text.toLowerCase().trim()
        .replace(/[^\w\s-]/g, '')
        .replace(/[\s_]+/g, '-')
        .replace(/-+/g, '-');
}

function getLocationSlug() {
    // Prefer the slug the server sent; fall back to slugifying the name
    const businessData = state.businesses.find(b => b.id === state.business.id);
    return businessData?.slug || state.business?.slug || (state.business?.name ? slugify(state.business.name) : null);
}

function getLocationSlugSafe() {
    try {
        return getLocationSlug();
    } catch (err) {
        return null;
    }
}

function getAvailabilityApiUrl(empId) {
    // The API accepts the business id in the path too, which is unambiguous
    return `/api/${encodeURIComponent(state.business.id)}/employees/${empId}/availability`;
}

/**
 * Local (browser-timezone) Monday for a week offset, as YYYY-MM-DD.
 * Sent to the server so a manager on the US west coast late on Sunday
 * evening still sees the week they expect.
 */
function getWeekStartIso(offset = state.weekOffset) {
    const monday = getWeekDates(offset)[0];
    const y = monday.getFullYear();
    const m = String(monday.getMonth() + 1).padStart(2, '0');
    const d = String(monday.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function getCurrentUrlPath() {
    const locationSlug = getLocationSlug();
    const pageSlug = TAB_TO_SLUG[state.currentTab] || 'schedule';
    return `/${locationSlug}/${pageSlug}`;
}

function updateUrl(push = true) {
    const newPath = getCurrentUrlPath();
    if (window.location.pathname !== newPath) {
        if (push) {
            history.pushState({ tab: state.currentTab, businessId: state.business.id }, '', newPath);
        } else {
            history.replaceState({ tab: state.currentTab, businessId: state.business.id }, '', newPath);
        }
    }
}

// ==================== STATE ====================
const state = {
    business: INITIAL_DATA.business,
    businesses: INITIAL_DATA.businesses,
    employees: INITIAL_DATA.employees,
    roles: INITIAL_DATA.roles,
    days: INITIAL_DATA.days,
    daysOpen: INITIAL_DATA.daysOpen,
    hours: INITIAL_DATA.hours,
    startHour: INITIAL_DATA.startHour,
    endHour: INITIAL_DATA.endHour,
    currentSchedule: null,
    currentTab: INITIAL_DATA.initialTab || 'schedule',
    editingEmployee: null,
    editingAvailability: null,
    theme: localStorage.getItem('theme') || 'dark', // Default to dark mode
    currentUser: INITIAL_DATA.user || null, // Current logged-in user
    isDemo: INITIAL_DATA.isDemo || false, // Demo mode flag
    peakPeriods: INITIAL_DATA.business.peak_periods || [],
    roleCoverageConfigs: INITIAL_DATA.business.role_coverage_configs || [],
    // Coverage mode state
    coverageMode: INITIAL_DATA.business.coverage_mode || 'shifts',
    shiftTemplates: INITIAL_DATA.business.shift_templates || [],
    hasCompletedSetup: INITIAL_DATA.business.has_completed_setup !== false,
    editingShift: null,
    // Schedule view state ('table' is the default: quickest to read)
    scheduleViewMode: 'timeline', // 'timeline' (default), 'grid', or 'table'
    tableFilter: { search: '', roles: new Set() }, // search/role filter for the table view
    hoursFilter: { search: '', roles: new Set() }, // search/role filter for Employee Hours
    scheduleColorMode: 'role', // 'role' or 'employee'
    // Week navigation state
    weekOffset: 0, // 0 = current week, -1 = last week, 1 = next week, etc.
    // Publish state tracking per week (keyed by week start date string)
    publishedWeeks: {}, // { 'YYYY-MM-DD': { published: true/false, editCount: 0 } }
    currentWeekHasSchedule: false,
    currentWeekEditCount: 0,
    // Approved PTO for current week
    approvedPTO: [] // [{ employee_id, employee_name, start_date, end_date, pto_type }]
};

// ==================== BUSINESS-SCOPED API CALLS ====================
/**
 * Every /api/ request carries the current business id so the server never
 * has to guess which location an edit belongs to. This wrapper appends
 * `businessId` to the query string when a call didn't include one itself.
 */
(function installBusinessScopedFetch() {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
        try {
            const isRequest = typeof Request !== 'undefined' && input instanceof Request;
            let url = isRequest ? input.url : String(input);
            const isRelativeApi = url.startsWith('/api/');
            if (isRelativeApi && state.business && state.business.id && !/[?&]businessId=/.test(url)) {
                url += (url.includes('?') ? '&' : '?') + 'businessId=' + encodeURIComponent(state.business.id);
                input = isRequest ? new Request(url, input) : url;
            }
        } catch (err) {
            // Never let the wrapper break a request
        }
        return nativeFetch(input, init);
    };
})();

// ==================== LOCAL STORAGE PERSISTENCE ====================
const DEBUG_SCHEDULE = (() => {
    try {
        return localStorage.getItem('debugSchedule') === 'true';
    } catch (err) {
        return false;
    }
})();

function debugSchedule(...args) {
    if (DEBUG_SCHEDULE) {
        console.log('[ScheduleDebug]', ...args);
    }
}

function getScheduleStorageKey() {
    return `schedule_${state.business.id}_week_${state.weekOffset}`;
}

function saveScheduleToStorage() {
    if (!state.currentSchedule) return;
    try {
        const key = getScheduleStorageKey();
        localStorage.setItem(key, JSON.stringify(state.currentSchedule));
        debugSchedule('Saved schedule to localStorage', {
            key,
            hasShiftTimes: !!state.currentSchedule.shift_times,
            shiftTimesCount: state.currentSchedule.shift_times ? Object.keys(state.currentSchedule.shift_times).length : 0,
            slotAssignmentsCount: state.currentSchedule.slot_assignments ? Object.keys(state.currentSchedule.slot_assignments).length : 0
        });
    } catch (e) {
        console.warn('Failed to save schedule to localStorage:', e);
        debugSchedule('Save schedule to localStorage failed', e);
    }
}

function loadScheduleFromStorage() {
    try {
        const key = getScheduleStorageKey();
        const saved = localStorage.getItem(key);
        if (saved) {
            const parsed = JSON.parse(saved);
            debugSchedule('Loaded schedule from localStorage', {
                key,
                hasShiftTimes: !!parsed?.shift_times,
                shiftTimesCount: parsed?.shift_times ? Object.keys(parsed.shift_times).length : 0,
                slotAssignmentsCount: parsed?.slot_assignments ? Object.keys(parsed.slot_assignments).length : 0
            });
            return parsed;
        }
        debugSchedule('No schedule found in localStorage', { key });
    } catch (e) {
        console.warn('Failed to load schedule from localStorage:', e);
        debugSchedule('Load schedule from localStorage failed', e);
    }
    return null;
}

function clearScheduleFromStorage() {
    try {
        const key = getScheduleStorageKey();
        localStorage.removeItem(key);
        debugSchedule('Cleared schedule from localStorage', { key });
    } catch (e) {
        console.warn('Failed to clear schedule from localStorage:', e);
        debugSchedule('Clear schedule from localStorage failed', e);
    }
}

function isEmpScheduledOnDay(slotAssignments, empId, dayIdx) {
    if (!slotAssignments) return false;
    const dayPrefix = `${dayIdx},`;
    for (const [key, assignments] of Object.entries(slotAssignments)) {
        if (!key.startsWith(dayPrefix)) continue;
        if (assignments?.some(a => a.employee_id === empId)) {
            return true;
        }
    }
    return false;
}

function mergeShiftTimesFromLocal(schedule) {
    const savedSchedule = loadScheduleFromStorage();
    if (!savedSchedule?.shift_times || !schedule?.slot_assignments) {
        debugSchedule('mergeShiftTimesFromLocal skipped', {
            hasSavedShiftTimes: !!savedSchedule?.shift_times,
            hasSlotAssignments: !!schedule?.slot_assignments
        });
        return;
    }

    if (!schedule.shift_times) {
        schedule.shift_times = {};
    }

    const stats = {
        total: 0,
        merged: 0,
        skippedExisting: 0,
        skippedInvalid: 0,
        skippedKey: 0,
        skippedNotScheduled: 0
    };

    for (const [key, times] of Object.entries(savedSchedule.shift_times)) {
        stats.total += 1;
        if (schedule.shift_times[key]) {
            stats.skippedExisting += 1;
            continue;
        }
        if (!times || typeof times.start !== 'number' || typeof times.end !== 'number') {
            stats.skippedInvalid += 1;
            continue;
        }

        const separatorIdx = key.lastIndexOf('_');
        if (separatorIdx === -1) {
            stats.skippedKey += 1;
            continue;
        }
        const empId = key.slice(0, separatorIdx);
        const dayIdx = parseInt(key.slice(separatorIdx + 1), 10);
        if (Number.isNaN(dayIdx)) {
            stats.skippedKey += 1;
            continue;
        }

        if (!isEmpScheduledOnDay(schedule.slot_assignments, empId, dayIdx)) {
            stats.skippedNotScheduled += 1;
            continue;
        }

        schedule.shift_times[key] = {
            start: times.start,
            end: times.end,
            roleId: times.roleId
        };
        stats.merged += 1;
    }

    debugSchedule('mergeShiftTimesFromLocal summary', stats);
}

async function loadScheduleForCurrentBusiness(renderAfterLoad = true) {
    /**
     * Load schedule for the current business/week.
     * Tries database first (for cross-device sync), falls back to localStorage.
     */
    let scheduleLoaded = false;
    
    try {
        // Try loading from database first
        const response = await fetch(`/api/schedule/load?businessId=${encodeURIComponent(state.business.id)}&weekOffset=${state.weekOffset}&weekStart=${getWeekStartIso()}`);
        const data = await response.json();
        
        if (data.success && data.schedule) {
            state.currentSchedule = data.schedule;
            mergeShiftTimesFromLocal(state.currentSchedule);
            // Update employees if returned from server (ensures consistency)
            if (data.employees) {
                state.employees = data.employees;
                buildLookups();
            }
            // Mark week as having a schedule and set published status based on database
            if (data.schedule.slot_assignments && Object.keys(data.schedule.slot_assignments).length > 0) {
                markWeekAsGenerated(state.weekOffset, 0);
                // If the schedule is published in the database, mark it as published
                if (data.status === 'published') {
                    markWeekAsPublished(state.weekOffset);
                    updateScheduleStatus('Published schedule loaded', 'success');
                } else {
                    updateScheduleStatus('Draft schedule loaded', 'success');
                }
                if (dom.alternativeBtn) dom.alternativeBtn.disabled = false;
                if (dom.exportBtn) dom.exportBtn.disabled = false;
                scheduleLoaded = true;
            }
            // Also save to localStorage for offline access
            saveScheduleToStorage();
        }
    } catch (error) {
        console.warn('Could not load schedule from database:', error);
    }
    
    // Fall back to localStorage if not loaded from database
    if (!scheduleLoaded) {
        const savedSchedule = loadScheduleFromStorage();
        if (savedSchedule) {
            state.currentSchedule = savedSchedule;
            if (savedSchedule.slot_assignments && Object.keys(savedSchedule.slot_assignments).length > 0) {
                markWeekAsGenerated(state.weekOffset, 0);
                updateScheduleStatus('Schedule loaded', 'success');
                if (dom.alternativeBtn) dom.alternativeBtn.disabled = false;
                if (dom.exportBtn) dom.exportBtn.disabled = false;
                scheduleLoaded = true;
            } else {
                updateScheduleStatus('Ready to generate', '');
                if (dom.alternativeBtn) dom.alternativeBtn.disabled = true;
                if (dom.exportBtn) dom.exportBtn.disabled = true;
            }
        } else {
            state.currentSchedule = null;
            updateScheduleStatus('Ready to generate', '');
            if (dom.alternativeBtn) dom.alternativeBtn.disabled = true;
            if (dom.exportBtn) dom.exportBtn.disabled = true;
        }
    }
    
    // Load approved PTO for the current week
    await loadApprovedPTOForWeek();

    // Metrics, notes and per-person hours for whatever we loaded
    if (scheduleLoaded && state.currentSchedule) {
        try {
            if (state.currentSchedule.metrics) updateMetrics(state.currentSchedule); else clearMetrics();
        } catch (err) { console.warn('Could not refresh metrics:', err); }
        try { updateEmployeeHours(state.currentSchedule); } catch (err) { /* panel may be collapsed */ }
    } else {
        try { clearMetrics(); } catch (err) { /* ignore */ }
    }

    // Re-render the schedule view if requested
    if (renderAfterLoad && state.currentTab === 'schedule') {
        if (state.scheduleViewMode === 'timeline') {
            renderTimelineView(state.currentSchedule || {});
        } else if (state.scheduleViewMode === 'table') {
            renderSimpleTableView(state.currentSchedule || { slot_assignments: {} });
        } else {
            rebuildScheduleGrid();
            if (state.currentSchedule) {
                renderSchedule(state.currentSchedule);
            }
        }
    }
}

async function loadApprovedPTOForWeek() {
    try {
        const response = await fetch(`/api/${encodeURIComponent(state.business.id)}/pto/approved?weekOffset=${state.weekOffset}&weekStart=${getWeekStartIso()}`);
        const data = await response.json();
        
        if (data.success) {
            state.approvedPTO = data.approved_pto || [];
        } else {
            state.approvedPTO = [];
        }
    } catch (error) {
        console.warn('Could not load approved PTO:', error);
        state.approvedPTO = [];
    }
    
    // Render the time off card
    renderTimeOffCard();
}

function renderTimeOffCard() {
    console.log('[TimeOffCard] renderTimeOffCard called');
    console.log('[TimeOffCard] state.approvedPTO:', state.approvedPTO);
    
    const card = document.getElementById('timeOffCard');
    const staffList = document.getElementById('timeOffStaffList');
    const titleText = document.getElementById('timeOffTitleText');
    const titleIcon = document.getElementById('timeOffIcon');
    const countBadge = document.getElementById('timeOffCount');
    const hint = document.getElementById('timeOffHint');
    const toggle = document.getElementById('timeOffToggle');
    const header = document.getElementById('timeOffCardHeader');
    
    console.log('[TimeOffCard] Elements found:', { card: !!card, staffList: !!staffList, titleText: !!titleText });
    
    if (!card || !staffList) {
        console.warn('[TimeOffCard] Required elements not found, aborting render');
        return;
    }
    
    // Get unique employees with time off this week
    const weekDates = getWeekDates(state.weekOffset);
    const timeOffByEmployee = {};
    
    (state.approvedPTO || []).forEach(pto => {
        const empId = pto.employee_id;
        const ptoStart = new Date(pto.start_date + 'T00:00:00');
        const ptoEnd = new Date(pto.end_date + 'T00:00:00');
        
        // Check if any day in the week overlaps with this PTO
        let daysOff = [];
        weekDates.forEach((date, idx) => {
            if (date >= ptoStart && date <= ptoEnd) {
                daysOff.push(idx);
            }
        });
        
        if (daysOff.length > 0) {
            if (!timeOffByEmployee[empId]) {
                timeOffByEmployee[empId] = {
                    employee_name: pto.employee_name,
                    employee_color: pto.employee_color,
                    pto_type: pto.pto_type,
                    days: daysOff,
                    start_date: pto.start_date,
                    end_date: pto.end_date
                };
            }
        }
    });
    
    const staffOffCount = Object.keys(timeOffByEmployee).length;
    console.log('[TimeOffCard] Staff off count:', staffOffCount, 'timeOffByEmployee:', timeOffByEmployee);
    
    // Handle empty state
    if (staffOffCount === 0) {
        console.log('[TimeOffCard] No staff off, showing empty state');
        card.classList.add('empty');
        card.classList.remove('collapsed');
        titleIcon.textContent = '✓';
        titleText.textContent = 'Full Team Available';
        countBadge.style.display = 'none';
        staffList.innerHTML = `
            <div class="time-off-empty-message">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                    <polyline points="22 4 12 14.01 9 11.01"></polyline>
                </svg>
                <span>All staff members are available this week</span>
            </div>
        `;
        if (hint) hint.style.display = 'none';
        return;
    }
    
    // Show time off
    card.classList.remove('empty');
    titleIcon.textContent = '🌴';
    titleText.textContent = 'Time Off This Week';
    countBadge.textContent = staffOffCount;
    countBadge.style.display = 'inline-block';
    if (hint) hint.style.display = 'flex';
    
    // Build staff pills
    let html = '';
    Object.values(timeOffByEmployee).forEach(staff => {
        const initials = getInitials(staff.employee_name);
        const color = staff.employee_color || '#8b5cf6';
        const emoji = getTimeOffTypeEmoji(staff.pto_type);
        const dateRange = formatTimeOffDateRange(staff.start_date, staff.end_date, staff.days);
        
        html += `
            <div class="time-off-staff-pill">
                <div class="time-off-staff-avatar" style="background: ${color}">${initials}</div>
                <div class="time-off-staff-info">
                    <div class="time-off-staff-name">${staff.employee_name}</div>
                    <div class="time-off-staff-dates">
                        <span class="time-off-staff-type">${emoji}</span>
                        <span>${dateRange}</span>
                    </div>
                </div>
            </div>
        `;
    });
    
    staffList.innerHTML = html;
    
    // Setup toggle functionality
    if (header && !header.hasAttribute('data-listener-attached')) {
        header.setAttribute('data-listener-attached', 'true');
        header.addEventListener('click', () => {
            card.classList.toggle('collapsed');
        });
    }
}

function getInitials(name) {
    if (!name) return '??';
    const parts = name.split(' ').filter(p => p.length > 0);
    if (parts.length >= 2) {
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return parts[0].substring(0, 2).toUpperCase();
}

function getTimeOffTypeEmoji(type) {
    switch (type) {
        case 'vacation': return '🌴';
        case 'sick': return '🤒';
        case 'personal': return '👤';
        default: return '📋';
    }
}

function formatTimeOffDateRange(startDate, endDate, daysInWeek) {
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    
    if (daysInWeek.length === 1) {
        return dayNames[daysInWeek[0]];
    }
    
    // Check if consecutive
    let isConsecutive = true;
    for (let i = 1; i < daysInWeek.length; i++) {
        if (daysInWeek[i] !== daysInWeek[i-1] + 1) {
            isConsecutive = false;
            break;
        }
    }
    
    if (isConsecutive) {
        return `${dayNames[daysInWeek[0]]}-${dayNames[daysInWeek[daysInWeek.length - 1]]}`;
    }
    
    // Non-consecutive, list them
    return daysInWeek.map(d => dayNames[d]).join(', ');
}

// ==================== TIMELINE DRAG STATE ====================
const timelineDragState = {
    isDragging: false,
    isResizing: false,
    resizeEdge: null, // 'left' or 'right'
    activeShift: null,
    ghostElement: null,
    originalDayIdx: null,
    originalStartHour: null,
    originalEndHour: null,
    originalRoleId: null,
    grabOffsetHours: 0,      // where on the bar the user grabbed it
    targetLaneIndex: 0,      // lane under the cursor while dragging
    currentTargetDay: null,
    currentTargetHour: null
};

// Build lookup maps
const employeeMap = {};
const roleMap = {};

function buildLookups() {
    // Clear existing maps before rebuilding
    Object.keys(employeeMap).forEach(key => delete employeeMap[key]);
    Object.keys(roleMap).forEach(key => delete roleMap[key]);
    
    state.employees.forEach(emp => employeeMap[emp.id] = emp);
    state.roles.forEach(role => roleMap[role.id] = role);
}
buildLookups();

// ==================== WEEK NAVIGATION HELPERS ====================
/**
 * Get the dates for a week based on offset from current week.
 * Returns an array of Date objects for Mon-Sun.
 * @param {number} offset - 0 = current week, -1 = last week, 1 = next week
 */
function getWeekDates(offset = 0) {
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0 = Sunday, 1 = Monday, etc.
    
    // Calculate Monday of current week
    // If today is Sunday (0), go back 6 days to get Monday
    // Otherwise, go back (dayOfWeek - 1) days
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(today);
    monday.setDate(today.getDate() - daysToMonday + (offset * 7));
    monday.setHours(0, 0, 0, 0);
    
    // Generate all 7 days of the week
    const weekDates = [];
    for (let i = 0; i < 7; i++) {
        const date = new Date(monday);
        date.setDate(monday.getDate() + i);
        weekDates.push(date);
    }
    
    return weekDates;
}

/**
 * Format a date as short month + day (e.g., "Jan 6")
 */
function formatShortDate(date) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[date.getMonth()]} ${date.getDate()}`;
}

/**
 * Navigate to a different week and re-render the current view
 */
async function navigateWeek(direction) {
    state.weekOffset += direction;
    
    // Update the week navigation bar first (for immediate visual feedback)
    updateWeekNavigationBar();
    
    // Load schedule from database first, then localStorage as fallback
    await loadScheduleForCurrentBusiness();
    
    // Re-render based on current view mode
    if (state.scheduleViewMode === 'timeline') {
        renderTimelineView(state.currentSchedule || {});
    } else if (state.scheduleViewMode === 'grid') {
        rebuildScheduleGrid();
        if (state.currentSchedule) {
            renderSchedule(state.currentSchedule);
        }
    } else if (state.scheduleViewMode === 'table') {
        if (state.currentSchedule) {
            renderSimpleTableView(state.currentSchedule);
        } else {
            // Just rebuild the header for empty state
            const table = document.getElementById('simpleScheduleTable');
            const tbody = document.getElementById('simpleScheduleBody');
            if (table && tbody) {
                renderSimpleTableView({ slot_assignments: {} });
            }
        }
    }
}

/**
 * Update the week navigation bar display
 */
function updateWeekNavigationBar() {
    const weekKey = getWeekKey(state.weekOffset);
    const weekState = state.publishedWeeks[weekKey] || { published: false, hasSchedule: false, editCount: 0 };
    
    // Update date range
    if (dom.weekDateRange) {
        dom.weekDateRange.textContent = getWeekRangeString(state.weekOffset);
    }
    
    // Update publish status color and tooltip
    updatePublishStatusDisplay(weekState);
}

/**
 * Get a unique key for a week based on its Monday date
 */
function getWeekKey(offset = 0) {
    const dates = getWeekDates(offset);
    const monday = dates[0];
    return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
}

/**
 * Update the publish status display (badge and tooltip)
 */
function updatePublishStatusDisplay(weekState) {
    const dateRangeEl = dom.weekDateRange;
    const badgeEl = dom.weekStatusBadge;
    
    let status, tooltipText, badgeText;
    
    if (!weekState.hasSchedule) {
        status = 'none';
        tooltipText = 'No schedule generated';
        badgeText = '';
    } else if (weekState.published) {
        status = 'published';
        tooltipText = 'Published';
        badgeText = 'Published';
    } else {
        status = 'draft';
        badgeText = 'Unpublished';
        const editCount = weekState.editCount || 0;
        if (editCount > 0) {
            tooltipText = `Draft - ${editCount} edit${editCount !== 1 ? 's' : ''} to publish`;
        } else {
            tooltipText = 'Draft - Unpublished changes';
        }
    }
    
    // Update status badge
    if (badgeEl) {
        badgeEl.className = 'week-status-badge';
        badgeEl.textContent = badgeText;
        if (status === 'draft') {
            badgeEl.classList.add('status-draft');
        } else if (status === 'published') {
            badgeEl.classList.add('status-published');
        }
    }
    
    // Toggle badge row visibility and toolbar padding
    if (dom.toolbarBadgeRow) {
        const toolbar = dom.toolbarBadgeRow.closest('.schedule-toolbar');
        if (status === 'draft' || status === 'published') {
            dom.toolbarBadgeRow.classList.add('has-badge');
            if (toolbar) toolbar.classList.add('has-badge');
        } else {
            dom.toolbarBadgeRow.classList.remove('has-badge');
            if (toolbar) toolbar.classList.remove('has-badge');
        }
    }
    
    // Update tooltip on date range
    if (dateRangeEl) {
        const weekLabel = getWeekTypeLabel(state.weekOffset);
        if (state.weekOffset !== 0) {
            dateRangeEl.title = `${weekLabel} - Double-click to return to current week`;
        } else {
            dateRangeEl.title = weekLabel;
        }
    }
    
    // Update publish button state
    if (dom.publishBtn) {
        if (weekState.hasSchedule && !weekState.published) {
            dom.publishBtn.disabled = false;
            dom.publishBtn.textContent = 'Publish';
        } else if (weekState.published) {
            dom.publishBtn.disabled = true;
            dom.publishBtn.innerHTML = '<svg class="dropdown-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Published';
        } else {
            dom.publishBtn.disabled = true;
            dom.publishBtn.textContent = 'Publish';
        }
    }
}

/**
 * Mark a week as having a schedule (draft state)
 */
function markWeekAsGenerated(offset = 0, editCount = 1) {
    const weekKey = getWeekKey(offset);
    state.publishedWeeks[weekKey] = {
        hasSchedule: true,
        published: false,
        editCount: editCount
    };
    updateWeekNavigationBar();
}

/**
 * Mark a week as published
 */
function markWeekAsPublished(offset = 0) {
    const weekKey = getWeekKey(offset);
    if (state.publishedWeeks[weekKey]) {
        state.publishedWeeks[weekKey].published = true;
        state.publishedWeeks[weekKey].editCount = 0;
    }
    updateWeekNavigationBar();
}

/**
 * Increment the edit count for a week (when schedule is modified)
 */
function incrementWeekEditCount(offset = 0) {
    const weekKey = getWeekKey(offset);
    if (state.publishedWeeks[weekKey] && state.publishedWeeks[weekKey].hasSchedule) {
        // If it was published, it's now a draft again
        if (state.publishedWeeks[weekKey].published) {
            state.publishedWeeks[weekKey].published = false;
        }
        state.publishedWeeks[weekKey].editCount = (state.publishedWeeks[weekKey].editCount || 0) + 1;
        updateWeekNavigationBar();
    }
}

/**
 * Get the week range string (e.g., "Jan 6 - Jan 12, 2025")
 */
function getWeekRangeString(offset = 0) {
    const dates = getWeekDates(offset);
    const monday = dates[0];
    const sunday = dates[6];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    if (monday.getMonth() === sunday.getMonth()) {
        return `${months[monday.getMonth()]} ${monday.getDate()} - ${sunday.getDate()}, ${sunday.getFullYear()}`;
    } else {
        return `${months[monday.getMonth()]} ${monday.getDate()} - ${months[sunday.getMonth()]} ${sunday.getDate()}, ${sunday.getFullYear()}`;
    }
}

/**
 * Get a short week label for the header (e.g., "Jan 6-12")
 */
function getShortWeekLabel(offset = 0) {
    const dates = getWeekDates(offset);
    const monday = dates[0];
    const sunday = dates[6];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    if (monday.getMonth() === sunday.getMonth()) {
        return `${months[monday.getMonth()]} ${monday.getDate()}-${sunday.getDate()}`;
    } else {
        return `${months[monday.getMonth()]} ${monday.getDate()} - ${months[sunday.getMonth()]} ${sunday.getDate()}`;
    }
}

/**
 * Get the week type label based on offset ("Current Week", "Last Week", "Next Week", etc.)
 */
function getWeekTypeLabel(offset = 0) {
    if (offset === 0) return 'Current Week';
    if (offset === -1) return 'Last Week';
    if (offset === 1) return 'Next Week';
    if (offset < -1) return `${Math.abs(offset)} Weeks Ago`;
    return `In ${offset} Weeks`;
}

// ==================== DOM REFERENCES ====================
const dom = {
    // Navigation
    navTabs: document.querySelectorAll('.nav-tab'),
    tabContents: document.querySelectorAll('.tab-content'),
    
    // Settings button (now a link to /settings page)
    settingsBtn: document.getElementById('settingsBtn'),
    
    // Global Business Selector
    globalBusinessSelector: document.getElementById('globalBusinessSelector'),
    businessSelectorBtn: document.getElementById('businessSelectorBtn'),
    businessDropdown: document.getElementById('businessDropdown'),
    currentBusinessName: document.getElementById('currentBusinessName'),
    
    // Schedule Tab
    businessSelect: document.getElementById('businessSelect'),
    generateBtn: document.getElementById('generateBtn'),
    alternativeBtn: document.getElementById('alternativeBtn'),
    resetBtn: document.getElementById('resetBtn'),
    exportBtn: document.getElementById('exportBtn'),
    scheduleStatus: document.getElementById('scheduleStatusFooter'), // Status badge now only in footer
    publishBtn: document.getElementById('publishBtn'),
    // Week Navigation Bar
    weekNavPrev: document.getElementById('weekNavPrev'),
    weekNavNext: document.getElementById('weekNavNext'),
    weekDateRange: document.getElementById('weekDateRange'),
    weekStatusBadge: document.getElementById('weekStatusBadge'),
    toolbarBadgeRow: document.getElementById('toolbarBadgeRow'),
    weekNavigationBar: document.getElementById('weekNavigationBar'),
    scheduleGrid: document.getElementById('scheduleGrid'),
    scheduleBody: document.getElementById('scheduleBody'),
    
    // Metrics
    coveragePercent: document.getElementById('coveragePercent'),
    slotsFilled: document.getElementById('slotsFilled'),
    hoursStillNeeded: document.getElementById('hoursStillNeeded'),
    laborCost: document.getElementById('laborCost'),
    solveTime: document.getElementById('solveTime'),
    overtimeHours: document.getElementById('overtimeHours'),
    gapsCard: document.getElementById('gapsCard'),
    roleGaps: document.getElementById('roleGaps'),
    dayGaps: document.getElementById('dayGaps'),
    employeeHoursList: document.getElementById('employeeHoursList'),
    
    // Employees Tab
    employeeSearch: document.getElementById('employeeSearch'),
    employeeFilterBtn: document.getElementById('employeeFilterBtn'),
    employeeFilterMenu: document.getElementById('employeeFilterMenu'),
    employeeFilterLabel: document.getElementById('filterLabel'),
    roleFilterOptions: document.getElementById('roleFilterOptions'),
    addEmployeeBtn: document.getElementById('addEmployeeBtn'),
    employeesGrid: document.getElementById('employeesGrid'),
    employeeCount: document.getElementById('employeeCount'),
    
    // Settings
    addRoleBtn: document.getElementById('addRoleBtn'),
    
    // Modals
    employeeModal: document.getElementById('employeeModal'),
    availabilityModal: document.getElementById('availabilityModal'),
    roleModal: document.getElementById('roleModal'),
    slotModal: document.getElementById('slotModal'),
    confirmModal: document.getElementById('confirmModal'),
    shiftModal: document.getElementById('shiftModal'),
    shiftEditModal: document.getElementById('shiftEditModal'),
    timelineAddShiftModal: document.getElementById('timelineAddShiftModal'),
    businessModal: document.getElementById('businessModal'),
    accountModal: document.getElementById('accountModal'),
    
    // Loading
    loadingOverlay: document.getElementById('loadingOverlay'),
    toastContainer: document.getElementById('toastContainer'),
    
    // Coverage Mode
    shiftsSection: document.getElementById('shiftsSection'),
    addShiftBtn: document.getElementById('addShiftBtn'),
    // Calendar elements are fetched dynamically in initCalendar
};

// ==================== INITIALIZATION ====================
function init() {
    // Apply saved theme
    applyTheme(state.theme);
    
    // Setup URL routing (popstate handler for back/forward buttons)
    setupUrlRouting();
    
    // Setup event listeners
    setupGlobalBusinessSelector();
    setupNavigation();
    setupScheduleTab();
    setupEmployeesTab();
    setupSettingsTab();
    setupCoverageMode();
    setupModals();
    setupAccountModal();
    setupKeyboardShortcuts();
    setupAdvancedTab();
    setupSettingsAutoSave();
    initTimelineAddShiftModal();
    initAvailabilityFilters();
    initPTONotifications();
    
    // Initial render
    renderEmployeesGrid(); if (state.currentTab === 'settings') renderAvailabilityPage();
    renderEmployeeHoursList(); // alphabetical, with role badges and the filter bar
    renderRolesList();
    renderCoverageUI();
    
    // User's business is now handled by the backend and included in get_all_businesses()
    // No need for updateBusinessDropdownWithUserBusiness() as it creates duplicates
    
    // Initialize to the correct tab from URL
    initializeFromUrl();
    
    // Re-render calendar on window resize to fix widths
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            renderShiftTemplates();
            checkLegendOverflow();
        }, 200);
    });
    
    // Global mouseup handler for availability drag selection
    document.addEventListener('mouseup', () => {
        availabilityDragState.isDragging = false;
    });
}

function setupUrlRouting() {
    // Handle browser back/forward navigation
    window.addEventListener('popstate', (event) => {
        if (event.state) {
            // Restore state from history
            const { tab, businessId } = event.state;
            
            if (businessId && businessId !== state.business.id) {
                // Need to switch business (without updating history)
                switchBusiness(businessId, false).then(() => {
                    if (tab && tab !== state.currentTab) {
                        switchTab(tab, false);
                    }
                });
            } else if (tab && tab !== state.currentTab) {
                switchTab(tab, false);
            }
        } else {
            // No state - parse from URL
            parseUrlAndNavigate(false);
        }
    });
}

function initializeFromUrl() {
    // Set initial tab from INITIAL_DATA (which comes from Flask)
    const initialTab = INITIAL_DATA.initialTab || 'schedule';
    
    // Activate the correct tab (without pushing history since we just loaded)
    if (initialTab !== state.currentTab) {
        switchTab(initialTab, false);
    } else {
        // Still need to update UI for the current tab
        dom.navTabs.forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === initialTab);
        });
        dom.tabContents.forEach(content => {
            content.classList.toggle('active', content.id === `tab-${initialTab}`);
        });
    }
    
    // Replace the current history entry with proper state
    updateUrl(false);
    
    // Load business settings from backend
    if (state.business?.id) {
        loadBusinessSettings(state.business.id);
    }
    
    // Load schedule from database first, then localStorage as fallback
    // This runs async but we proceed with rendering (schedule will update when loaded)
    loadScheduleForCurrentBusiness().then(() => {
        // Re-render schedule view after loading
        if (state.currentTab === 'schedule' && state.currentSchedule) {
            if (state.scheduleViewMode === 'timeline') {
                renderTimelineView(state.currentSchedule);
            } else if (state.scheduleViewMode === 'table') {
                renderSimpleTableView(state.currentSchedule);
            } else {
                renderSchedule(state.currentSchedule);
            }
        }
    });
    
    // Render tab-specific content
    // Use setTimeout to ensure DOM is fully ready and CSS is applied
    setTimeout(() => {
        if (initialTab === 'schedule') {
            // Render the schedule view based on current view mode
            if (state.scheduleViewMode === 'timeline') {
                renderTimelineView(state.currentSchedule || {});
            } else if (state.scheduleViewMode === 'table') {
                renderSimpleTableView(state.currentSchedule || { slot_assignments: {} });
            } else {
                rebuildScheduleGrid();
                if (state.currentSchedule) renderSchedule(state.currentSchedule);
            }
        } else if (initialTab === 'help') {
            renderShiftTemplates();
        } else if (initialTab === 'settings') {
            renderAvailabilityPage();
        }
    }, 0);
}

function parseUrlAndNavigate(updateHistory = true) {
    const pathParts = window.location.pathname.split('/').filter(p => p);
    
    if (pathParts.length >= 2) {
        const [locationSlug, pageSlug] = pathParts;
        
        // Find business by slug
        const business = state.businesses.find(b => b.slug === locationSlug);
        const tabId = PAGE_SLUGS[pageSlug];
        
        if (business && business.id !== state.business.id) {
            switchBusiness(business.id, updateHistory).then(() => {
                if (tabId && tabId !== state.currentTab) {
                    switchTab(tabId, updateHistory);
                }
            });
        } else if (tabId && tabId !== state.currentTab) {
            switchTab(tabId, updateHistory);
        }
    }
}

// ==================== ADVANCED TAB (Three-State Toggles) ====================
function setupAdvancedTab() {
    // Setup all three-state toggles
    document.querySelectorAll('.three-state-toggle').forEach(toggle => {
        toggle.querySelectorAll('.toggle-option').forEach(option => {
            option.addEventListener('click', () => {
                // Remove active from all options in this toggle
                toggle.querySelectorAll('.toggle-option').forEach(opt => opt.classList.remove('active'));
                // Set this option as active
                option.classList.add('active');
            });
        });
    });
}

function getThreeStateToggleValue(toggleId) {
    const toggle = document.getElementById(toggleId);
    if (!toggle) return 'off';
    const activeOption = toggle.querySelector('.toggle-option.active');
    return activeOption ? activeOption.dataset.value : 'off';
}

function getAllPolicies() {
    return {
        min_shift_length: parseInt(document.getElementById('minShiftLength')?.value || 2),
        max_hours_per_day: parseInt(document.getElementById('maxHoursPerDay')?.value || 8),
        max_splits: parseInt(document.getElementById('maxSplits')?.value || 2),
        max_split_shifts_per_week: parseInt(document.getElementById('maxSplitShiftsPerWeek')?.value || 2),
        // Scheduling strategy
        scheduling_strategy: getThreeStateToggleValue('schedulingStrategyToggle'),
        // Max days per week constraints
        max_days_ft: parseInt(document.getElementById('maxDaysFT')?.value || 5),
        max_days_ft_mode: getThreeStateToggleValue('maxDaysFTToggle'),
        max_days_pt: parseInt(document.getElementById('maxDaysPT')?.value || 3),
        max_days_pt_mode: getThreeStateToggleValue('maxDaysPTToggle'),
        // Other settings
        supervision_required: document.getElementById('supervisionRequired')?.checked ?? true,
        weekend_fairness: document.getElementById('weekendFairness')?.checked ?? true,
        avoid_overtime: document.getElementById('avoidOvertime')?.checked ?? true
    };
}


// ==================== BUSINESS SETTINGS PERSISTENCE ====================

// Debounce timer for auto-saving settings
let settingsSaveTimeout = null;

async function loadBusinessSettings(businessId) {
    // Load saved settings for a business from the backend
    try {
        const response = await fetch(`/api/business/${businessId}/settings`);
        const data = await response.json();
        
        if (data.success && data.settings && Object.keys(data.settings).length > 0) {
            applyBusinessSettings(data.settings);
        }
    } catch (error) {
        console.error('Failed to load business settings:', error);
    }
}

function applyBusinessSettings(settings) {
    // Apply saved settings to the form elements
    // Number inputs
    if (settings.min_shift_length !== undefined) {
        const el = document.getElementById('minShiftLength');
        if (el) el.value = settings.min_shift_length;
    }
    if (settings.max_hours_per_day !== undefined) {
        const el = document.getElementById('maxHoursPerDay');
        if (el) el.value = settings.max_hours_per_day;
    }
    if (settings.max_splits !== undefined) {
        const el = document.getElementById('maxSplits');
        if (el) el.value = settings.max_splits;
    }
    if (settings.max_split_shifts_per_week !== undefined) {
        const el = document.getElementById('maxSplitShiftsPerWeek');
        if (el) el.value = settings.max_split_shifts_per_week;
    }
    if (settings.max_days_ft !== undefined) {
        const el = document.getElementById('maxDaysFT');
        if (el) el.value = settings.max_days_ft;
    }
    if (settings.max_days_pt !== undefined) {
        const el = document.getElementById('maxDaysPT');
        if (el) el.value = settings.max_days_pt;
    }
    
    // Three-state toggles
    if (settings.scheduling_strategy !== undefined) {
        setThreeStateToggleValue('schedulingStrategyToggle', settings.scheduling_strategy);
    }
    if (settings.max_days_ft_mode !== undefined) {
        setThreeStateToggleValue('maxDaysFTToggle', settings.max_days_ft_mode);
    }
    if (settings.max_days_pt_mode !== undefined) {
        setThreeStateToggleValue('maxDaysPTToggle', settings.max_days_pt_mode);
    }
    
    // Checkboxes
    if (settings.supervision_required !== undefined) {
        const el = document.getElementById('supervisionRequired');
        if (el) el.checked = settings.supervision_required;
    }
    if (settings.weekend_fairness !== undefined) {
        const el = document.getElementById('weekendFairness');
        if (el) el.checked = settings.weekend_fairness;
    }
    if (settings.avoid_overtime !== undefined) {
        const el = document.getElementById('avoidOvertime');
        if (el) el.checked = settings.avoid_overtime;
    }
}

function setThreeStateToggleValue(toggleId, value) {
    // Set the value of a three-state toggle
    const toggle = document.getElementById(toggleId);
    if (!toggle) return;
    
    toggle.querySelectorAll('.toggle-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.value === value);
    });
}

async function saveBusinessSettings() {
    // Save current settings to the backend
    if (!state.business?.id) return;
    
    // Only save if user is logged in
    if (!state.currentUser) {
        console.log('User not logged in, settings not saved to server');
        return;
    }
    
    const settings = getAllPolicies();
    
    try {
        const response = await fetch(`/api/business/${state.business.id}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings })
        });
        
        const data = await response.json();
        
        if (data.success) {
            console.log(`Settings saved (${data.type}): ${data.message}`);
        } else {
            console.error('Failed to save settings:', data.error);
        }
    } catch (error) {
        console.error('Error saving settings:', error);
    }
}

function debouncedSaveSettings() {
    // Debounced save - waits 1 second after last change before saving
    if (settingsSaveTimeout) {
        clearTimeout(settingsSaveTimeout);
    }
    settingsSaveTimeout = setTimeout(() => {
        saveBusinessSettings();
    }, 1000);
}

function setupSettingsAutoSave() {
    // Set up auto-save listeners for all settings inputs
    // Number inputs
    const numberInputs = [
        'minShiftLength', 'maxHoursPerDay', 'maxSplits', 
        'maxSplitShiftsPerWeek', 'maxDaysFT', 'maxDaysPT'
    ];
    numberInputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', debouncedSaveSettings);
            el.addEventListener('input', debouncedSaveSettings);
        }
    });
    
    // Checkboxes
    const checkboxIds = ['supervisionRequired', 'weekendFairness', 'avoidOvertime'];
    checkboxIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', debouncedSaveSettings);
        }
    });
    
    // Three-state toggles - add click listeners to options
    document.querySelectorAll('.three-state-toggle .toggle-option').forEach(option => {
        option.addEventListener('click', debouncedSaveSettings);
    });
}


// ==================== THEME ====================
function applyTheme(theme) {
    if (theme === 'light') {
        document.body.setAttribute('data-theme', 'light');
    } else {
        document.body.removeAttribute('data-theme');
    }
    state.theme = theme;
    localStorage.setItem('theme', theme);
}

// ==================== NAVIGATION ====================
function setupNavigation() {
    dom.navTabs.forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });
    // Theme toggle is now on the Settings page (/settings)
}

function switchTab(tabId, updateHistory = true) {
    // Update nav tabs
    dom.navTabs.forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabId);
    });
    
    // Update tab contents
    dom.tabContents.forEach(content => {
        content.classList.toggle('active', content.id === `tab-${tabId}`);
    });
    
    state.currentTab = tabId;
    
    // Update URL to reflect tab change
    if (updateHistory) {
        updateUrl(true);
    }
    
    // Re-render schedule when switching to schedule tab
    if (tabId === 'schedule') {
        requestAnimationFrame(() => {
            if (state.scheduleViewMode === 'timeline') {
                renderTimelineView(state.currentSchedule || {});
            } else if (state.scheduleViewMode === 'table') {
                renderSimpleTableView(state.currentSchedule || { slot_assignments: {} });
            } else {
                rebuildScheduleGrid();
                if (state.currentSchedule) renderSchedule(state.currentSchedule);
            }
        });
    }
    
    // Re-render calendar shifts when switching to requirements tab
    // (needed because calendar dimensions are 0 when tab is hidden)
    if (tabId === 'help') {
        requestAnimationFrame(() => {
            renderShiftTemplates();
        });
    }
    
    // Render availability page when switching to settings (availability) tab
    if (tabId === 'settings') {
        renderAvailabilityPage();
    }
}

// ==================== TOAST NOTIFICATIONS ====================
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    const icons = {
        success: '✓',
        error: '✕',
        warning: '⚠',
        info: 'ℹ'
    };
    
    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || icons.info}</span>
        <span class="toast-message">${message}</span>
        <button class="toast-close">&times;</button>
    `;
    
    toast.querySelector('.toast-close').addEventListener('click', () => {
        toast.remove();
    });
    
    dom.toastContainer.appendChild(toast);
    
    // Auto remove after 4 seconds
    setTimeout(() => {
        if (toast.parentElement) {
            toast.style.animation = 'toastIn 0.3s ease reverse';
            setTimeout(() => toast.remove(), 300);
        }
    }, 4000);
}

// ==================== LOADING ====================
let loadingTimer = null;
let loadingStartedAt = 0;

function showLoading(message = 'Loading...', subtext = '') {
    const overlay = dom.loadingOverlay;
    overlay.querySelector('.loading-text').textContent = message;
    const sub = overlay.querySelector('#loadingSubtext');
    if (sub) sub.textContent = subtext;
    const steps = overlay.querySelector('#loadingSteps');
    if (steps) steps.innerHTML = '';
    const hint = overlay.querySelector('#loadingHint');
    if (hint) hint.hidden = true;
    const elapsed = overlay.querySelector('#loadingElapsed');
    if (elapsed) elapsed.textContent = '';
    overlay.classList.add('active');
}

/**
 * Show the progress of a background schedule job: a running clock, the
 * solver's latest status line, and (after a while) a reassurance that big
 * schedules can take up to a minute.
 */
function startLoadingProgress() {
    loadingStartedAt = Date.now();
    clearInterval(loadingTimer);
    loadingTimer = setInterval(() => {
        const secs = Math.floor((Date.now() - loadingStartedAt) / 1000);
        const elapsed = dom.loadingOverlay.querySelector('#loadingElapsed');
        if (elapsed) elapsed.textContent = `${secs}s`;
        const hint = dom.loadingOverlay.querySelector('#loadingHint');
        if (hint && secs >= 12) hint.hidden = false;
    }, 500);
}

function updateLoadingProgress(job) {
    const overlay = dom.loadingOverlay;
    const sub = overlay.querySelector('#loadingSubtext');
    if (sub && job.message) sub.textContent = job.message;
    const steps = overlay.querySelector('#loadingSteps');
    if (!steps) return;
    const p = job.progress || {};
    const items = [];
    items.push({ done: true, text: 'Loaded staff, roles, and coverage rules' });
    items.push({ done: (p.solutions || 0) > 0, text: (p.solutions || 0) > 0 ? `Found ${p.solutions} candidate schedule${p.solutions === 1 ? '' : 's'}` : 'Searching for a first schedule' });
    if ((p.solutions || 0) > 0) {
        const unfilled = p.unfilled_slots ?? null;
        items.push({ done: unfilled === 0, text: unfilled === 0 ? 'Every required hour is covered' : `${unfilled} required hour${unfilled === 1 ? '' : 's'} still open, still searching` });
        items.push({ done: false, text: 'Balancing hours, preferences, and rest between shifts' });
    }
    steps.innerHTML = items.map(i => `
        <div class="loading-step ${i.done ? 'done' : 'pending'}">
            <span class="loading-step-icon">${i.done ? '✓' : '<span class="loading-dot"></span>'}</span>
            <span>${i.text}</span>
        </div>`).join('');
}

function hideLoading() {
    clearInterval(loadingTimer);
    loadingTimer = null;
    dom.loadingOverlay.classList.remove('active');
}

// ==================== MODALS ====================
function setupModals() {
    // Close on backdrop click
    document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
        backdrop.addEventListener('click', () => closeAllModals());
    });
    
    // Close buttons
    document.querySelectorAll('[data-close]').forEach(btn => {
        btn.addEventListener('click', () => closeAllModals());
    });
    
    // Employee form
    document.getElementById('employeeForm').addEventListener('submit', handleEmployeeSubmit);
    
    // Role form
    document.getElementById('roleForm').addEventListener('submit', handleRoleSubmit);
    
    // Availability save (modal)
    document.getElementById('saveAvailabilityBtn').addEventListener('click', saveAvailability);
    
    // Availability save (settings page)
    const settingsSaveBtn = document.getElementById('settingsSaveAvailBtn');
    if (settingsSaveBtn) {
        settingsSaveBtn.addEventListener('click', saveSettingsAvailability);
    }
    
    // Slot save
    document.getElementById('saveSlotBtn').addEventListener('click', saveSlotAssignment);
    
    // Shift edit (save and delete)
    const saveShiftEditBtn = document.getElementById('saveShiftEditBtn');
    const deleteShiftBtn = document.getElementById('deleteShiftBtn');
    if (saveShiftEditBtn) {
        saveShiftEditBtn.addEventListener('click', saveShiftEdit);
    }
    if (deleteShiftBtn) {
        deleteShiftBtn.addEventListener('click', deleteScheduleShift);
    }
    
    // Confirm
    document.getElementById('confirmBtn').addEventListener('click', handleConfirm);
}

function openModal(modalId) {
    document.getElementById(modalId).classList.add('active');
}

function closeAllModals() {
    document.querySelectorAll('.modal').forEach(modal => {
        modal.classList.remove('active');
    });
    state.editingEmployee = null;
    state.editingAvailability = null;
}

// ==================== GLOBAL BUSINESS SELECTOR ====================
function setupGlobalBusinessSelector() {
    if (!dom.businessSelectorBtn || !dom.globalBusinessSelector) return;
    
    // Toggle dropdown on button click
    dom.businessSelectorBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dom.globalBusinessSelector.classList.toggle('open');
    });
    
    // Handle business option clicks
    dom.businessDropdown.querySelectorAll('.business-option').forEach(option => {
        option.addEventListener('click', async (e) => {
            e.stopPropagation();
            const businessId = option.dataset.businessId;
            
            // Close dropdown
            dom.globalBusinessSelector.classList.remove('open');
            
            // Switch business
            await switchBusiness(businessId);
            
            // Update active state in dropdown
            updateBusinessDropdownSelection(businessId);
        });
        
        // Right-click to edit
        option.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const businessId = option.dataset.businessId;
            openBusinessEditor(businessId);
        });
    });
    
    // Add business button
    const addBusinessBtn = document.getElementById('addBusinessBtn');
    if (addBusinessBtn) {
        addBusinessBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            dom.globalBusinessSelector.classList.remove('open');
            openBusinessEditor(null); // null = new business
        });
    }
    
    // Setup business modal
    setupBusinessModal();
    
    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!dom.globalBusinessSelector.contains(e.target)) {
            dom.globalBusinessSelector.classList.remove('open');
        }
    });
    
    // Close on escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            dom.globalBusinessSelector.classList.remove('open');
        }
    });
}

function updateBusinessDropdownSelection(businessId) {
    dom.businessDropdown.querySelectorAll('.business-option').forEach(opt => {
        opt.classList.remove('active');
        const checkIcon = opt.querySelector('.check-icon');
        if (checkIcon) checkIcon.remove();
    });
    
    const selectedOption = dom.businessDropdown.querySelector(`[data-business-id="${businessId}"]`);
    if (selectedOption) {
        selectedOption.classList.add('active');
        
        // Add check icon
        const checkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        checkSvg.setAttribute('class', 'check-icon');
        checkSvg.setAttribute('viewBox', '0 0 24 24');
        checkSvg.setAttribute('fill', 'none');
        checkSvg.setAttribute('stroke', 'currentColor');
        checkSvg.setAttribute('stroke-width', '2');
        checkSvg.innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>';
        selectedOption.appendChild(checkSvg);
    }
}

function setupBusinessModal() {
    const modal = dom.businessModal;
    if (!modal) return;
    
    const emojiBtn = document.getElementById('businessEmojiBtn');
    const emojiPicker = document.getElementById('emojiPicker');
    const colorInput = document.getElementById('businessEditColor');
    const colorPresets = modal.querySelectorAll('.color-preset');
    const saveBtn = document.getElementById('saveBusinessBtn');
    const deleteBtn = document.getElementById('deleteBusinessBtn');
    
    // Emoji picker toggle
    const emojiBackdrop = document.getElementById('emojiPickerBackdrop');
    const emojiClose = document.getElementById('emojiPickerClose');
    const emojiSearch = document.getElementById('emojiSearch');
    const emojiCategoryDropdown = document.getElementById('emojiCategoryDropdown');
    const emojiCategorySelect = document.getElementById('emojiCategorySelect');
    const emojiCategoryOptions = document.getElementById('emojiCategoryOptions');
    const emojiGrid = document.getElementById('emojiGrid');
    const emojiNoResults = document.getElementById('emojiNoResults');
    
    let currentCategory = 'favorites';
    
    const closeEmojiPicker = () => {
        emojiPicker?.classList.remove('open');
        emojiBackdrop?.classList.remove('open');
        emojiCategoryDropdown?.classList.remove('open');
        // Reset search when closing but keep category
        if (emojiSearch) emojiSearch.value = '';
        // Reset to favorites
        currentCategory = 'favorites';
        filterEmojis('', 'favorites');
        updateCategorySelectDisplay('favorites');
    };
    
    const updateCategorySelectDisplay = (category) => {
        const option = emojiCategoryOptions?.querySelector(`[data-category="${category}"]`);
        if (option && emojiCategorySelect) {
            const icon = option.querySelector('.option-icon')?.textContent || '⭐';
            const name = option.textContent.trim().replace(icon, '').trim();
            emojiCategorySelect.querySelector('.category-icon').textContent = icon;
            emojiCategorySelect.querySelector('.category-name').textContent = name;
        }
        // Update active state in options
        emojiCategoryOptions?.querySelectorAll('.emoji-category-option').forEach(opt => {
            opt.classList.toggle('active', opt.dataset.category === category);
        });
    };
    
    const filterEmojis = (searchTerm, category) => {
        const allEmojis = emojiGrid?.querySelectorAll('.emoji-option');
        if (!allEmojis) return;
        
        const search = searchTerm.toLowerCase().trim();
        let visibleCount = 0;
        const seenEmojis = new Set();
        
        allEmojis.forEach(emoji => {
            const emojiChar = emoji.dataset.emoji;
            const emojiCategories = emoji.dataset.category || '';
            const emojiName = emoji.dataset.name?.toLowerCase() || '';
            
            // Check if emoji belongs to category (categories can be space-separated)
            const matchesCategory = category === 'all' || emojiCategories.split(' ').includes(category);
            const matchesSearch = !search || emojiName.includes(search) || emojiChar.includes(search);
            
            // Only show if it matches both AND we haven't shown this exact emoji yet in this view
            if (matchesCategory && matchesSearch && !seenEmojis.has(emojiChar)) {
                emoji.style.display = '';
                seenEmojis.add(emojiChar);
                visibleCount++;
            } else {
                emoji.style.display = 'none';
            }
        });
        
        // Show/hide no results message
        if (emojiNoResults) {
            emojiNoResults.style.display = visibleCount === 0 ? 'block' : 'none';
        }
        if (emojiGrid) {
            emojiGrid.style.display = visibleCount === 0 ? 'none' : 'grid';
        }
    };
    
    // Initialize with favorites
    filterEmojis('', 'favorites');
    
    // Add tooltips to emoji options based on data-name
    emojiGrid?.querySelectorAll('.emoji-option').forEach(option => {
        const name = option.dataset.name;
        if (name) {
            // Capitalize first letter and format nicely
            const tooltip = name.split(' ').slice(0, 3).map(word => 
                word.charAt(0).toUpperCase() + word.slice(1)
            ).join(' ');
            option.title = tooltip;
        }
    });
    
    if (emojiBtn && emojiPicker) {
        emojiBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            emojiPicker.classList.toggle('open');
            emojiBackdrop?.classList.toggle('open');
            // Focus search input when opening
            if (emojiPicker.classList.contains('open')) {
                setTimeout(() => emojiSearch?.focus(), 100);
            }
        });
        
        // Search functionality
        emojiSearch?.addEventListener('input', (e) => {
            filterEmojis(e.target.value, currentCategory);
        });
        
        // Category dropdown toggle
        emojiCategorySelect?.addEventListener('click', (e) => {
            e.stopPropagation();
            emojiCategoryDropdown?.classList.toggle('open');
        });
        
        // Category selection
        emojiCategoryOptions?.querySelectorAll('.emoji-category-option').forEach(option => {
            option.addEventListener('click', (e) => {
                e.stopPropagation();
                currentCategory = option.dataset.category;
                updateCategorySelectDisplay(currentCategory);
                filterEmojis(emojiSearch?.value || '', currentCategory);
                emojiCategoryDropdown?.classList.remove('open');
            });
        });
        
        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!emojiCategoryDropdown?.contains(e.target)) {
                emojiCategoryDropdown?.classList.remove('open');
            }
        });
        
        // Emoji selection (including clear button)
        emojiPicker.querySelectorAll('.emoji-option, .emoji-clear-btn').forEach(option => {
            option.addEventListener('click', (e) => {
                e.stopPropagation();
                const emoji = option.dataset.emoji;
                const emojiEl = document.getElementById('businessEditEmoji');
                const emojiBtnEl = document.getElementById('businessEmojiBtn');
                
                if (emoji) {
                    emojiEl.textContent = emoji;
                    emojiBtnEl.classList.remove('empty');
                } else {
                    emojiEl.textContent = '';
                    emojiBtnEl.classList.add('empty');
                }
                closeEmojiPicker();
            });
        });
        
        // Close on backdrop click
        emojiBackdrop?.addEventListener('click', closeEmojiPicker);
        
        // Close button
        emojiClose?.addEventListener('click', (e) => {
            e.stopPropagation();
            closeEmojiPicker();
        });
        
        // Close on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && emojiPicker.classList.contains('open')) {
                closeEmojiPicker();
            }
        });
    }
    
    // Color presets
    colorPresets.forEach(preset => {
        preset.addEventListener('click', () => {
            const color = preset.dataset.color;
            colorInput.value = color;
            colorPresets.forEach(p => p.classList.remove('selected'));
            preset.classList.add('selected');
        });
    });
    
    // Save button
    if (saveBtn) {
        saveBtn.addEventListener('click', saveBusiness);
    }
    
    // Delete button
    if (deleteBtn) {
        deleteBtn.addEventListener('click', deleteBusiness);
    }
    
    // Close button
    modal.querySelectorAll('[data-close]').forEach(btn => {
        btn.addEventListener('click', () => {
            modal.classList.remove('active');
        });
    });
    
    // Close on backdrop click
    modal.querySelector('.modal-backdrop')?.addEventListener('click', () => {
        modal.classList.remove('active');
    });
}

// ==================== ACCOUNT/LOGIN MODAL ====================
function setupAccountModal() {
    const modal = dom.accountModal;
    const settingsBtn = dom.settingsBtn;
    
    // Settings button click - ALWAYS set this up, even if modal doesn't exist
    if (settingsBtn) {
        settingsBtn.addEventListener('click', (e) => {
            e.preventDefault();
            if (state.currentUser && !state.isDemo) {
                // User is logged in and not in demo mode - go to full settings page
                window.location.href = '/settings';
            } else {
                // User is not logged in or in demo mode - show login modal
                openAccountModal();
            }
        });
    }
    
    // Demo banner sign-in link
    const demoBannerSignIn = document.getElementById('demoBannerSignIn');
    if (demoBannerSignIn) {
        demoBannerSignIn.addEventListener('click', (e) => {
            e.preventDefault();
            openAccountModal();
        });
    }
    
    // Return early if modal doesn't exist (for authenticated pages)
    if (!modal) return;
    
    const authTabs = modal.querySelectorAll('.auth-tab');
    const loginForm = document.getElementById('accountLoginForm');
    const signupForm = document.getElementById('accountSignupForm');
    
    // Auth tab switching
    authTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            authTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            
            const tabName = tab.dataset.tab;
            if (tabName === 'login') {
                loginForm.classList.add('active');
                signupForm.classList.remove('active');
            } else {
                loginForm.classList.remove('active');
                signupForm.classList.add('active');
            }
        });
    });
    
    // Login form submission
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('accountLoginEmail').value.trim();
            const password = document.getElementById('accountLoginPassword').value;
            
            const btn = loginForm.querySelector('button[type="submit"]');
            btn.disabled = true;
            btn.classList.add('loading');
            
            try {
                const response = await fetch('/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });
                const data = await response.json();
                
                if (data.success) {
                    state.currentUser = data.user;
                    showToast(`Welcome back, ${data.user.username}!`, 'success');
                    modal.classList.remove('active');
                    loginForm.reset();
                    
                    // Redirect to refresh with updated user context
                    setTimeout(() => {
                        if (state.isDemo) {
                            window.location.href = '/app';
                        } else {
                            // Reload to get updated business list from backend
                            window.location.reload();
                        }
                    }, 1000);
                } else {
                    showToast(data.error || 'Invalid email or password', 'error');
                }
            } catch (error) {
                console.error('Login error:', error);
                showToast('Connection error. Please try again.', 'error');
            } finally {
                btn.disabled = false;
                btn.classList.remove('loading');
            }
        });
    }
    
    // Signup form submission
    if (signupForm) {
        signupForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('accountSignupEmail').value.trim();
            const username = document.getElementById('accountSignupUsername').value.trim();
            const company = document.getElementById('accountSignupCompany').value.trim();
            const password = document.getElementById('accountSignupPassword').value;
            const confirmPassword = document.getElementById('accountSignupConfirm').value;
            
            if (password !== confirmPassword) {
                showToast('Passwords do not match', 'error');
                return;
            }
            
            if (password.length < 8) {
                showToast('Password must be at least 8 characters', 'error');
                return;
            }
            
            const btn = signupForm.querySelector('button[type="submit"]');
            btn.disabled = true;
            btn.classList.add('loading');
            
            try {
                const response = await fetch('/auth/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        email,
                        username,
                        password,
                        confirm_password: confirmPassword,
                        company_name: company
                    })
                });
                const data = await response.json();
                
                if (data.success) {
                    state.currentUser = data.user;
                    showToast('Account created successfully!', 'success');
                    modal.classList.remove('active');
                    signupForm.reset();
                    
                    // Redirect to the user's new business or reload
                    setTimeout(() => {
                        if (state.isDemo) {
                            window.location.href = '/app';
                        } else if (data.redirect) {
                            // Redirect to user's new business page
                            window.location.href = data.redirect;
                        } else {
                            // Reload to get updated business list from backend
                            window.location.reload();
                        }
                    }, 1000);
                } else {
                    const errorMsg = data.errors ? data.errors.join(' ') : (data.error || 'Registration failed');
                    showToast(errorMsg, 'error');
                }
            } catch (error) {
                console.error('Registration error:', error);
                showToast('Connection error. Please try again.', 'error');
            } finally {
                btn.disabled = false;
                btn.classList.remove('loading');
            }
        });
    }
    
    // Close on backdrop click
    modal.querySelector('.modal-backdrop')?.addEventListener('click', () => {
        modal.classList.remove('active');
    });
    
    // Close button
    modal.querySelectorAll('[data-close]').forEach(btn => {
        btn.addEventListener('click', () => {
            modal.classList.remove('active');
        });
    });
}

function openAccountModal() {
    const modal = dom.accountModal;
    if (!modal) return;
    
    modal.classList.add('active');
}

// updateBusinessDropdownWithUserBusiness function removed - user businesses are now
// created by the backend and included in get_all_businesses() which is rendered
// by the server-side template. No need for duplicate JavaScript injection.

// List of sample/built-in business IDs that cannot be deleted
const SAMPLE_BUSINESS_IDS = ['coffee_shop', 'retail_store', 'restaurant', 'call_center', 'warehouse'];

function openBusinessEditor(businessId) {
    const modal = dom.businessModal;
    if (!modal) return;
    
    const titleEl = document.getElementById('businessModalTitle');
    const idInput = document.getElementById('businessEditId');
    const nameInput = document.getElementById('businessEditName');
    const emojiEl = document.getElementById('businessEditEmoji');
    const colorInput = document.getElementById('businessEditColor');
    const deleteBtn = document.getElementById('deleteBusinessBtn');
    const deleteWrapper = document.getElementById('deleteBusinessWrapper');
    
    // Reset color preset selection
    modal.querySelectorAll('.color-preset').forEach(p => p.classList.remove('selected'));
    
    // Close emoji picker if open
    const emojiPicker = document.getElementById('emojiPicker');
    if (emojiPicker) emojiPicker.classList.remove('open');
    
    const emojiBtn = document.getElementById('businessEmojiBtn');
    
    if (businessId) {
        // Editing existing business
        titleEl.textContent = 'Edit Location';
        idInput.value = businessId;
        
        // Find business data
        const business = state.businesses.find(b => b.id === businessId);
        if (business) {
            nameInput.value = business.name;
            
            // Handle emoji - could be empty
            if (business.emoji) {
                emojiEl.textContent = business.emoji;
                emojiBtn.classList.remove('empty');
            } else {
                emojiEl.textContent = '';
                emojiBtn.classList.add('empty');
            }
            
            colorInput.value = business.color || '#6366f1';
            
            // Select matching color preset if any
            const matchingPreset = modal.querySelector(`.color-preset[data-color="${business.color}"]`);
            if (matchingPreset) matchingPreset.classList.add('selected');
        }
        
        // Check if this is a sample business
        const isSampleBusiness = SAMPLE_BUSINESS_IDS.includes(businessId);
        const isCurrentBusiness = businessId === state.business.id;
        
        // Show delete wrapper but disable for sample businesses or current business
        deleteWrapper.style.display = 'flex';
        
        if (isSampleBusiness) {
            deleteBtn.disabled = true;
            deleteWrapper.classList.add('sample');
        } else if (isCurrentBusiness) {
            deleteBtn.disabled = true;
            deleteWrapper.classList.add('sample');
            document.getElementById('deleteHint').textContent = 'Cannot delete the active location';
        } else {
            deleteBtn.disabled = false;
            deleteWrapper.classList.remove('sample');
        }
    } else {
        // Creating new business - default to no emoji
        titleEl.textContent = 'Add New Location';
        idInput.value = '';
        nameInput.value = '';
        emojiEl.textContent = '';
        emojiBtn.classList.add('empty');
        colorInput.value = '#6366f1';
        deleteWrapper.style.display = 'none';
        
        // Reset hint text
        document.getElementById('deleteHint').textContent = 'Sample locations cannot be deleted';
    }
    
    modal.classList.add('active');
    nameInput.focus();
}

async function saveBusiness() {
    const idInput = document.getElementById('businessEditId');
    const nameInput = document.getElementById('businessEditName');
    const emojiEl = document.getElementById('businessEditEmoji');
    const colorInput = document.getElementById('businessEditColor');
    
    const name = nameInput.value.trim();
    if (!name) {
        showToast('Please enter a location name', 'error');
        return;
    }
    
    const businessData = {
        id: idInput.value || null,
        name: name,
        emoji: emojiEl.textContent,
        color: colorInput.value
    };
    
    try {
        const response = await fetch('/api/business/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(businessData)
        });
        
        const result = await response.json();
        
        if (result.success) {
            showToast(idInput.value ? 'Location updated' : 'Location created', 'success');
            dom.businessModal.classList.remove('active');
            // A full page load keeps the server-rendered location list, URL,
            // and session in sync (renames change the URL slug).
            const pageSlug = TAB_TO_SLUG[state.currentTab] || 'schedule';
            window.location.href = `/${result.slug}/${pageSlug}`;
        } else {
            showToast(result.error || result.message || 'Failed to save location', 'error');
        }
    } catch (error) {
        console.error('Error saving business:', error);
        showToast('Failed to save location', 'error');
    }
}

async function deleteBusiness() {
    const businessId = document.getElementById('businessEditId').value;
    if (!businessId) return;
    
    if (!confirm('Are you sure you want to delete this location? This cannot be undone.')) {
        return;
    }
    
    try {
        const response = await fetch(`/api/business/${businessId}`, {
            method: 'DELETE'
        });
        
        const result = await response.json();
        
        if (result.success) {
            showToast('Location deleted', 'success');
            dom.businessModal.classList.remove('active');
            window.location.href = result.redirect || '/app';
        } else {
            showToast(result.error || result.message || 'Failed to delete location', 'error');
        }
    } catch (error) {
        console.error('Error deleting business:', error);
        showToast('Failed to delete location', 'error');
    }
}

async function refreshBusinessList() {
    try {
        const response = await fetch('/api/businesses');
        const data = await response.json();
        
        if (data.businesses) {
            state.businesses = data.businesses;
            
            // Rebuild dropdown
            rebuildBusinessDropdown();
        }
    } catch (error) {
        console.error('Error refreshing business list:', error);
    }
}

function rebuildBusinessDropdown() {
    const dropdown = dom.businessDropdown;
    if (!dropdown) return;
    
    // Clear existing options (keep header and add button)
    const header = dropdown.querySelector('.dropdown-header');
    const divider = dropdown.querySelector('.dropdown-divider');
    const addBtn = dropdown.querySelector('.add-business-btn');
    
    dropdown.innerHTML = '';
    if (header) dropdown.appendChild(header);
    
    // Recreate header if missing
    if (!header) {
        const newHeader = document.createElement('div');
        newHeader.className = 'dropdown-header';
        newHeader.textContent = 'Switch Location';
        dropdown.appendChild(newHeader);
    }
    
    // Add business options
    state.businesses.forEach(b => {
        const option = document.createElement('button');
        option.className = `business-option ${b.id === state.business.id ? 'active' : ''}`;
        option.dataset.businessId = b.id;
        option.dataset.businessSlug = b.slug || slugify(b.name);
        
        // Show first letter of business name if no emoji
        const iconContent = b.emoji || b.name.charAt(0).toUpperCase();
        const iconClass = b.emoji ? '' : 'text-icon';
        
        option.innerHTML = `
            <div class="option-icon ${iconClass}" style="background: ${b.color || '#6366f1'}">
                ${iconContent}
            </div>
            <div class="option-details">
                <span class="option-name">${b.name}</span>
                <span class="option-meta">${b.total_employees || 0} staff · ${b.total_roles || 0} roles</span>
            </div>
            ${b.id === state.business.id ? '<svg class="check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>' : ''}
        `;
        
        // Click to switch
        option.addEventListener('click', async (e) => {
            e.stopPropagation();
            dom.globalBusinessSelector.classList.remove('open');
            await switchBusiness(b.id);
            updateBusinessDropdownSelection(b.id);
        });
        
        // Right-click to edit
        option.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openBusinessEditor(b.id);
        });
        
        dropdown.appendChild(option);
    });
    
    // Add divider and add button
    const newDivider = document.createElement('div');
    newDivider.className = 'dropdown-divider';
    dropdown.appendChild(newDivider);
    
    const newAddBtn = document.createElement('button');
    newAddBtn.className = 'add-business-btn';
    newAddBtn.id = 'addBusinessBtn';
    newAddBtn.innerHTML = `
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="16"></line>
            <line x1="8" y1="12" x2="16" y2="12"></line>
        </svg>
        Add New Location
    `;
    newAddBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dom.globalBusinessSelector.classList.remove('open');
        openBusinessEditor(null);
    });
    dropdown.appendChild(newAddBtn);
    
    // Update header button text
    const currentNameEl = document.getElementById('currentBusinessName');
    if (currentNameEl) {
        currentNameEl.textContent = state.business.name;
    }
}

// ==================== SCHEDULE TAB ====================
function setupScheduleTab() {
    if (dom.businessSelect) {
        dom.businessSelect.addEventListener('change', (e) => switchBusiness(e.target.value));
    }
    dom.generateBtn.addEventListener('click', generateSchedule);
    dom.alternativeBtn.addEventListener('click', findAlternative);
    dom.resetBtn.addEventListener('click', resetSchedule);
    
    // Publish button
    if (dom.publishBtn) {
        dom.publishBtn.addEventListener('click', publishSchedule);
    }
    
    // Week Navigation Bar
    if (dom.weekNavPrev) {
        dom.weekNavPrev.addEventListener('click', () => navigateWeek(-1));
    }
    if (dom.weekNavNext) {
        dom.weekNavNext.addEventListener('click', () => navigateWeek(1));
    }
    // Double-click date range to return to current week
    if (dom.weekDateRange) {
        dom.weekDateRange.addEventListener('dblclick', (e) => {
            e.preventDefault();
            window.getSelection().removeAllRanges(); // Clear any text selection
            if (state.weekOffset !== 0) {
                // Reset to current week by calculating how many weeks to go back
                const direction = -state.weekOffset;
                navigateWeek(direction);
            }
        });
    }
    // Initialize week navigation bar display
    updateWeekNavigationBar();
    
    // Click on slots
    dom.scheduleBody.addEventListener('click', (e) => {
        const slot = e.target.closest('.slot');
        if (slot && state.currentSchedule) {
            openSlotEditor(parseInt(slot.dataset.day), parseInt(slot.dataset.hour));
        }
    });
    
    // View toggle (grid vs table vs timeline)
    document.querySelectorAll('.view-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const view = btn.dataset.view;
            state.scheduleViewMode = view;
            
            // Update button states
            document.querySelectorAll('.view-toggle-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            // Toggle views
            document.getElementById('scheduleViewGrid').classList.toggle('active', view === 'grid');
            document.getElementById('scheduleViewTimeline').classList.toggle('active', view === 'timeline');
            document.getElementById('scheduleViewTable').classList.toggle('active', view === 'table');
            
            // Re-render current schedule (or empty view)
            if (view === 'table') {
                renderSimpleTableView(state.currentSchedule || { slot_assignments: {} });
            } else if (view === 'timeline') {
                renderTimelineView(state.currentSchedule || {});
            } else {
                // Grid view - rebuild grid structure with dates first
                rebuildScheduleGrid();
                if (state.currentSchedule) renderSchedule(state.currentSchedule);
            }
        });
    });
    
    // Color mode toggle (role vs employee)
    document.querySelectorAll('.color-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            state.scheduleColorMode = mode;
            
            // Update button states
            document.querySelectorAll('.color-mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            // Re-render schedule and legend
            if (state.currentSchedule) {
                if (state.scheduleViewMode === 'table') {
                    renderSimpleTableView(state.currentSchedule);
                } else if (state.scheduleViewMode === 'timeline') {
                    renderTimelineView(state.currentSchedule);
                } else {
                    renderSchedule(state.currentSchedule);
                }
            }
            renderScheduleLegend();
        });
    });
    
    // Initialize legend
    renderScheduleLegend();
    
    // Setup collapsible cards
    setupCollapsibleCards();
}

function setupCollapsibleCards() {
    document.querySelectorAll('.collapsible-header').forEach(header => {
        header.addEventListener('click', () => {
            const card = header.closest('.collapsible-card');
            if (card) {
                card.classList.toggle('collapsed');
            }
        });
    });
}

async function switchBusiness(businessId, updateHistory = true) {
    showLoading('Loading business...');
    
    try {
        const response = await fetch(`/api/business/${businessId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        const data = await response.json();
        
        if (data.success) {
            state.business = data.business;
            state.employees = data.business.employees;
            state.roles = data.business.roles;
            state.daysOpen = data.business.days_open;
            state.startHour = data.business.start_hour;
            state.endHour = data.business.end_hour;
            state.peakPeriods = data.business.peak_periods || [];
            state.roleCoverageConfigs = data.business.role_coverage_configs || [];
            state.coverageMode = data.business.coverage_mode || 'shifts';
            state.shiftTemplates = data.business.shift_templates || [];
            state.hasCompletedSetup = data.business.has_completed_setup !== false;
            state.hours = [];
            for (let h = state.startHour; h < state.endHour; h++) {
                state.hours.push(h);
            }
            
            // Update slug in businesses array if returned from API
            if (data.slug) {
                const businessIdx = state.businesses.findIndex(b => b.id === businessId);
                if (businessIdx !== -1) {
                    state.businesses[businessIdx].slug = data.slug;
                }
                state.business.slug = data.slug;
            }
            
            buildLookups();
            rebuildScheduleGrid();
            renderEmployeeHoursList();
            renderRoleLegend();
            renderEmployeesGrid(); if (state.currentTab === 'settings') renderAvailabilityPage();
            renderRolesList();
            renderCoverageUI();
            
            // Load business settings from backend
            await loadBusinessSettings(businessId);
            
            // Try to load schedule from database first, then fall back to localStorage
            await loadScheduleForCurrentBusiness();
            
            // Update global business selector display
            if (dom.currentBusinessName) {
                dom.currentBusinessName.textContent = data.business.name;
            }
            
            // Sync schedule page dropdown if it exists
            if (dom.businessSelect) {
                dom.businessSelect.value = businessId;
            }
            
            // Update URL to reflect business change
            if (updateHistory) {
                updateUrl(true);
            }
            
            // Update business dropdown checkmarks
            updateBusinessDropdownState(businessId);
            
            showToast(`Switched to ${data.business.name}`, 'success');
        } else {
            showToast(data.message || 'Failed to switch business', 'error');
        }
    } catch (error) {
        console.error('Error switching business:', error);
        showToast('Error switching business: ' + error.message, 'error');
    } finally {
        hideLoading();
    }
}

function updateBusinessDropdownState(activeBusinessId) {
    // Update checkmarks in dropdown
    document.querySelectorAll('.business-option').forEach(option => {
        const isActive = option.dataset.businessId === activeBusinessId;
        option.classList.toggle('active', isActive);
        
        // Add/remove check icon
        const existingCheck = option.querySelector('.check-icon');
        if (isActive && !existingCheck) {
            const checkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            checkSvg.classList.add('check-icon');
            checkSvg.setAttribute('viewBox', '0 0 24 24');
            checkSvg.setAttribute('fill', 'none');
            checkSvg.setAttribute('stroke', 'currentColor');
            checkSvg.setAttribute('stroke-width', '2');
            checkSvg.innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>';
            option.appendChild(checkSvg);
        } else if (!isActive && existingCheck) {
            existingCheck.remove();
        }
    });
}

function rebuildScheduleGrid() {
    // Rebuild header with alternating colors (TUE, THU, SAT get alternate color)
    if (!dom.scheduleGrid) {
        console.warn('scheduleGrid not found');
        return;
    }
    const thead = dom.scheduleGrid.querySelector('thead tr');
    if (!thead) {
        console.warn('thead tr not found in scheduleGrid');
        return;
    }
    
    // Get week dates for the current week offset
    const weekDates = getWeekDates(state.weekOffset);
    
    // First column: Time label (week nav is now in the bar above)
    thead.innerHTML = '<th class="time-col">Time</th>';
    
    state.daysOpen.forEach((dayIdx, colIndex) => {
        const th = document.createElement('th');
        // Use actual day index: TUE(1), THU(3), SAT(5) are odd days
        th.className = 'day-col ' + (dayIdx % 2 === 0 ? 'day-even' : 'day-odd');
        const dayDate = weekDates[dayIdx];
        th.innerHTML = `
            <span class="day-name">${state.days[dayIdx].substring(0, 3)}</span>
            <span class="day-date">${formatShortDate(dayDate)}</span>
        `;
        thead.appendChild(th);
    });
    
    // Rebuild body with alternating colors
    if (!dom.scheduleBody) return;
    dom.scheduleBody.innerHTML = '';
    state.hours.forEach(hour => {
        const tr = document.createElement('tr');
        
        const timeCell = document.createElement('td');
        timeCell.className = 'time-cell';
        timeCell.textContent = formatHour(hour);
        tr.appendChild(timeCell);
        
        state.daysOpen.forEach((dayIdx, colIndex) => {
            const td = document.createElement('td');
            // Use actual day index: TUE(1), THU(3), SAT(5) are odd days
            td.className = 'slot ' + (dayIdx % 2 === 0 ? 'day-even' : 'day-odd');
            td.dataset.day = dayIdx;
            td.dataset.hour = hour;
            td.innerHTML = '<div class="slot-content"><span class="slot-empty"></span></div>';
            tr.appendChild(td);
        });
        
        dom.scheduleBody.appendChild(tr);
    });
}

/** Turn a list of {day, hour} slots into per-day ranges: { day: [[start, end], ...] }. */
function slotsToRangesByDay(slots) {
    const byDay = {};
    (slots || []).forEach(s => (byDay[s.day] = byDay[s.day] || []).push(parseInt(s.hour)));
    const out = {};
    Object.entries(byDay).forEach(([day, hours]) => {
        hours.sort((a, b) => a - b);
        const ranges = [];
        hours.forEach(h => {
            const last = ranges[ranges.length - 1];
            if (last && h === last[1]) last[1] = h + 1;
            else ranges.push([h, h + 1]);
        });
        out[day] = ranges;
    });
    return out;
}

/** Availability ranges per day for an employee, from ranges when present or hourly slots otherwise. */
function employeeAvailabilityByDay(emp) {
    const ranges = emp.availability_ranges;
    if (ranges && Object.keys(ranges).length) {
        const out = {};
        Object.entries(ranges).forEach(([d, list]) => { out[parseInt(d)] = (list || []).map(([s, e]) => [s, e]); });
        return out;
    }
    return slotsToRangesByDay(emp.availability);
}

function formatRangeList(ranges) {
    if (!ranges || !ranges.length) return '';
    return ranges.map(([s, e]) => `${formatHourMinute(s)}–${formatHourMinute(e)}`).join(', ');
}

/**
 * Full, unabbreviated details for one team member. Used by the schedule
 * table (row expansion), the Employee Hours panel and the Staff Availability page.
 * opts.availability adds a 7-day availability strip, opts.rules the rules/info list.
 */
function buildEmployeeDetailHtml(emp, opts = { availability: true, rules: true }) {
    const dayShort = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    let html = '<div class="emp-detail">';

    if (opts.availability) {
        const avail = employeeAvailabilityByDay(emp);
        const prefs = slotsToRangesByDay(emp.preferences);
        html += '<div class="emp-detail-section"><div class="emp-detail-heading">Available this week</div><div class="emp-detail-days">';
        for (let d = 0; d < 7; d++) {
            const isOpen = (state.daysOpen || []).includes(d);
            const ranges = avail[d] || [];
            const cls = ranges.length ? 'has-avail' : 'no-avail';
            const text = ranges.length ? formatRangeList(ranges) : (isOpen ? 'Not available' : 'Closed');
            const pref = prefs[d] && prefs[d].length ? `<span class="emp-detail-pref" title="Preferred hours">prefers ${escHtml(formatRangeList(prefs[d]))}</span>` : '';
            html += `<div class="emp-detail-day ${cls}"><span class="emp-detail-dayname">${dayShort[d]}</span><span class="emp-detail-dayval">${escHtml(text)}</span>${pref}</div>`;
        }
        html += '</div></div>';
    }

    if (opts.rules) {
        const roles = (emp.roles || []).map(r => roleMap[r]?.name || r);
        const items = [
            ['Status', emp.classification === 'full_time' ? 'Full-time' : 'Part-time'],
            ['Weekly hours', `${emp.min_hours ?? 0} to ${emp.max_hours ?? 40} hours`],
            ['Roles', roles.length ? roles.join(', ') : 'No roles yet'],
            ['Overtime', emp.overtime_allowed ? 'Allowed (over 40 hours is fine)' : 'Not allowed (capped at 40 hours)'],
            ['Supervision', emp.can_supervise ? 'Can supervise others' : (emp.needs_supervision ? 'Needs a supervisor on shift' : 'Works unsupervised')],
            ['Hourly rate', `$${Number(emp.hourly_rate || 0).toFixed(2)}`],
        ];
        if (emp.email || emp.phone) items.push(['Contact', [emp.email, emp.phone].filter(Boolean).join(' · ')]);
        html += '<div class="emp-detail-section"><div class="emp-detail-heading">Rules and info</div><dl class="emp-detail-list">';
        items.forEach(([k, v]) => { html += `<div class="emp-detail-item"><dt>${escHtml(k)}</dt><dd>${escHtml(v)}</dd></div>`; });
        html += '</dl></div>';
    }
    html += '</div>';
    return html;
}

let employeeHoursListWired = false;
let hoursFilterWired = false;

/** Coloured pill per role the person holds (uses each role's colour). */
function roleBadgesHtml(emp) {
    const roles = (emp.roles || []).map(r => roleMap[r]).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    if (!roles.length) return '';
    return `<span class="emp-role-badges">${roles.map(r => `<span class="role-badge" style="--role-color:${escHtml(r.color)}">${escHtml(r.name)}</span>`).join('')}</span>`;
}

/** Search box + role chips above the Employee Hours list. */
function renderHoursFilterChips() {
    const bar = document.getElementById('hoursFilterBar');
    if (!bar) return;
    const filter = state.hoursFilter;
    const chips = bar.querySelector('#hoursRoleChips');
    const input = bar.querySelector('#hoursSearchInput');
    const clearBtn = bar.querySelector('#hoursFilterClear');

    chips.innerHTML = '';
    [...state.roles].sort((a, b) => a.name.localeCompare(b.name)).forEach(role => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'role-chip' + (filter.roles.has(role.id) ? ' active' : '');
        chip.style.setProperty('--chip-color', role.color);
        chip.innerHTML = `<span class="role-chip-dot"></span>${escHtml(role.name)}`;
        chip.title = filter.roles.has(role.id) ? `Hide ${role.name}` : `Show ${role.name}`;
        chip.addEventListener('click', () => {
            if (filter.roles.has(role.id)) filter.roles.delete(role.id); else filter.roles.add(role.id);
            renderEmployeeHoursList();
        });
        chips.appendChild(chip);
    });
    const active = !!(filter.search || filter.roles.size);
    clearBtn.hidden = !active;

    if (!hoursFilterWired) {
        hoursFilterWired = true;
        input.addEventListener('input', () => {
            filter.search = input.value;
            renderEmployeeHoursList();
        });
        clearBtn.addEventListener('click', () => {
            filter.search = '';
            filter.roles.clear();
            input.value = '';
            renderEmployeeHoursList();
        });
    }
}

/** Employee Hours rows: alphabetical, filtered by the search/role chips, with role badges. */
function renderEmployeeHoursList() {
    if (!dom.employeeHoursList) return;
    if (!state.hoursFilter) state.hoursFilter = { search: '', roles: new Set() };
    renderHoursFilterChips();
    dom.employeeHoursList.innerHTML = '';

    const filter = state.hoursFilter;
    const search = (filter.search || '').trim().toLowerCase();
    const people = [...state.employees]
        .filter(emp => !search || (emp.name || '').toLowerCase().includes(search))
        .filter(emp => !filter.roles.size || (emp.roles || []).some(r => filter.roles.has(r)))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    people.forEach(emp => {
        const row = document.createElement('div');
        row.className = 'emp-hours-row';
        row.dataset.id = emp.id;
        row.title = 'Click for full details';

        row.innerHTML = `
            <div class="emp-hours-info">
                <span class="emp-color-dot" style="background: ${escHtml(emp.color)}"></span>
                <span class="emp-name">${escHtml(emp.name)}</span>
                ${roleBadgesHtml(emp)}
                <div class="emp-badges">${getBadgesHTML(emp)}</div>
            </div>
            <div class="emp-hours-stats">
                <span class="emp-hours" data-tooltip="Hours scheduled this week">—h</span>
                <span class="emp-range" data-tooltip="Weekly hours range (min-max)">(${emp.min_hours}-${emp.max_hours})</span>
                <span class="emp-status" data-tooltip="Schedule status">—</span>
            </div>
        `;
        dom.employeeHoursList.appendChild(row);
    });

    if (!people.length) {
        dom.employeeHoursList.innerHTML = '<div class="emp-hours-empty">No team members match your search or filter.</div>';
    }

    // Fill in this week's hours for the rows we just drew
    if (state.currentSchedule?.employee_hours) {
        try { updateEmployeeHours(state.currentSchedule); } catch (err) { /* nothing scheduled yet */ }
    }
    wireEmployeeHoursList();
}

/** Click a row in Employee Hours to expand that person's full details. Safe to call repeatedly. */
function wireEmployeeHoursList() {
    if (!dom.employeeHoursList) return;
    // One delegated listener handles rows rendered by the server and by JS
    if (!employeeHoursListWired) {
        employeeHoursListWired = true;
        dom.employeeHoursList.addEventListener('click', (e) => {
            const row = e.target.closest('.emp-hours-row');
            if (!row || !dom.employeeHoursList.contains(row)) return;
            const emp = employeeMap[row.dataset.id];
            if (!emp) return;
            const existing = row.nextElementSibling;
            if (existing && existing.classList.contains('emp-hours-details')) {
                existing.remove();
                row.classList.remove('expanded');
                return;
            }
            dom.employeeHoursList.querySelectorAll('.emp-hours-details').forEach(d => d.remove());
            dom.employeeHoursList.querySelectorAll('.emp-hours-row.expanded').forEach(r => r.classList.remove('expanded'));
            const details = document.createElement('div');
            details.className = 'emp-hours-details';
            details.innerHTML = buildEmployeeDetailHtml(emp, { availability: true, rules: true });
            row.classList.add('expanded');
            row.after(details);
        });
    }
}

// Badge HTML. Full words on desktop, short codes only on small screens (CSS decides which shows).
function getBadgesHTML(emp) {
    const badge = (cls, short, full, tip) =>
        `<span class="badge ${cls}" data-tooltip="${tip}"><span class="badge-short">${short}</span><span class="badge-full">${full}</span></span>`;
    let badges = '';
    if (emp.classification === 'full_time') {
        badges += badge('badge-ft', 'FT', 'Full-time', 'Full-time employee');
    } else {
        badges += badge('badge-pt', 'PT', 'Part-time', 'Part-time employee');
    }
    if (emp.needs_supervision) badges += badge('badge-new', 'NEW', 'New hire', 'Needs a supervisor on shift');
    if (emp.can_supervise) badges += badge('badge-sup', 'SUP', 'Supervisor', 'Can supervise others');
    if (emp.overtime_allowed) badges += badge('badge-ot', 'OT', 'Overtime', 'Overtime allowed');
    return badges;
}

function renderRoleLegend() {
    const legend = document.getElementById('roleLegend');
    if (!legend) return;
    legend.innerHTML = '';
    
    state.roles.forEach(role => {
        const tag = document.createElement('div');
        tag.className = 'role-tag';
        tag.style.setProperty('--role-color', role.color);
        tag.setAttribute('data-tooltip', `${role.name} - Job position/role`);
        tag.innerHTML = `
            <span class="role-dot"></span>
            <span>${role.name}</span>
        `;
        legend.appendChild(tag);
    });
}

/**
 * Re-render the schedule in whichever view is active.
 */
function renderCurrentScheduleView(schedule) {
    if (state.scheduleViewMode === 'table') {
        renderSimpleTableView(schedule || { slot_assignments: {} });
    } else if (state.scheduleViewMode === 'timeline') {
        renderTimelineView(schedule || {});
    } else {
        rebuildScheduleGrid();
        if (schedule) renderSchedule(schedule);
    }
}

/**
 * Poll a background schedule job until it finishes.
 * Resolves with the job record ({status, message, progress, result}).
 */
async function pollScheduleJob(jobId, onProgress) {
    const started = Date.now();
    let delay = 500;
    while (Date.now() - started < 180000) {
        await new Promise(r => setTimeout(r, delay));
        let job;
        try {
            const response = await fetch(`/api/schedule/job/${jobId}`);
            job = await response.json();
        } catch (err) {
            // transient network hiccup: keep polling
            continue;
        }
        if (onProgress) onProgress(job);
        if (job.status === 'done' || job.status === 'failed') return job;
        delay = Math.min(1500, delay + 100);
    }
    return { status: 'failed', message: 'Timed out waiting for the schedule.' };
}

/**
 * Start a generation ("generate") or alternative ("alternative") job and
 * show its live progress until the result arrives.
 */
async function runScheduleJob(kind) {
    const isAlternative = kind === 'alternative';
    dom.generateBtn.disabled = true;
    dom.alternativeBtn.disabled = true;
    showLoading(isAlternative ? 'Finding a different schedule...' : 'Building your schedule...',
                'Sending your staff, roles, and rules to the scheduler...');
    startLoadingProgress();
    updateScheduleStatus(isAlternative ? 'Searching...' : 'Generating...', 'loading');

    try {
        const response = await fetch(isAlternative ? '/api/alternative' : '/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                policies: getAllPolicies(),
                businessId: state.business.id,
                weekOffset: state.weekOffset,
                weekStart: getWeekStartIso()
            })
        });
        const started = await response.json();
        if (!started.success || !started.job_id) {
            throw new Error(started.message || 'Could not start the scheduler.');
        }

        const job = await pollScheduleJob(started.job_id, updateLoadingProgress);
        if (job.status !== 'done' || !job.result) {
            throw new Error(job.error || job.message || 'Schedule generation failed.');
        }

        const data = job.result;
        if (data.success) {
            state.currentSchedule = data.schedule;
            if (data.employees) {
                state.employees = data.employees;
                buildLookups();
            }
            saveScheduleToStorage();
            markWeekAsGenerated(state.weekOffset, 1);
            renderCurrentScheduleView(data.schedule);
            updateMetrics(data.schedule);
            updateEmployeeHours(data.schedule);

            const coverage = data.schedule.coverage_percentage;
            const label = `Solution #${data.schedule.solution_index}`;
            if (coverage >= 100) {
                updateScheduleStatus(`100% coverage - ${label}`, 'success');
            } else {
                updateScheduleStatus(`${coverage}% coverage - ${data.schedule.metrics.total_hours_still_needed}h still open - ${label}`, 'warning');
            }
            dom.alternativeBtn.disabled = false;
            dom.exportBtn.disabled = false;
            showToast(data.message, coverage >= 100 ? 'success' : 'warning');
        } else {
            updateScheduleStatus(isAlternative ? 'No different schedule found' : 'No schedule possible with these rules', 'error');
            showToast(data.message || 'No schedule could be generated', 'error');
            if (data.schedule && data.schedule.metrics) updateMetrics(data.schedule);
            if (!isAlternative) clearScheduleGrid();
            dom.alternativeBtn.disabled = !state.currentSchedule;
        }
    } catch (error) {
        console.error(`[${kind}]`, error);
        updateScheduleStatus(isAlternative ? 'Error finding alternative' : 'Error generating schedule', 'error');
        showToast(error.message || 'Something went wrong. Please try again.', 'error');
        dom.alternativeBtn.disabled = !state.currentSchedule;
    } finally {
        dom.generateBtn.disabled = false;
        hideLoading();
    }
}

async function generateSchedule() {
    return runScheduleJob('generate');
}

async function findAlternative() {
    return runScheduleJob('alternative');
}

async function resetSchedule() {
    try {
        await fetch('/api/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ businessId: state.business.id, weekOffset: state.weekOffset, weekStart: getWeekStartIso() })
        });
        
        clearScheduleGrid();
        clearMetrics();
        state.currentSchedule = { slot_assignments: {} };
        dom.alternativeBtn.disabled = true;
        dom.exportBtn.disabled = true;
        
        // Clear from localStorage
        clearScheduleFromStorage();
        
        // Reset the publish state for this week
        resetWeekPublishState(state.weekOffset);
        
        updateScheduleStatus('Ready to generate', '');
        // Clear timeline/grid views
        renderTimelineView(state.currentSchedule);
        showToast('Schedule reset', 'info');
    } catch (error) {
        showToast('Error resetting schedule', 'error');
    }
}

/**
 * Reset the publish state for a week (when schedule is cleared/reset)
 */
function resetWeekPublishState(offset = 0) {
    const weekKey = getWeekKey(offset);
    state.publishedWeeks[weekKey] = {
        hasSchedule: false,
        published: false,
        editCount: 0
    };
    updateWeekNavigationBar();
}

// Demo business IDs that don't support server-side publishing
const DEMO_BUSINESS_IDS = ['coffee_shop', 'retail_store', 'restaurant', 'call_center', 'warehouse'];

function isDemoBusiness() {
    return DEMO_BUSINESS_IDS.includes(state.business?.id);
}

function showDemoPublishModal(weekRange) {
    // Create modal if it doesn't exist
    let modal = document.getElementById('demoPublishModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'demoPublishModal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-backdrop"></div>
            <div class="modal-content demo-publish-modal">
                <div class="modal-header">
                    <h2>
                        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24">
                            <circle cx="12" cy="12" r="10"></circle>
                            <line x1="12" y1="8" x2="12" y2="12"></line>
                            <line x1="12" y1="16" x2="12.01" y2="16"></line>
                        </svg>
                        Demo Mode
                    </h2>
                    <button class="modal-close" id="demoPublishClose">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                </div>
                <div class="modal-body">
                    <div class="demo-info-card">
                        <div class="demo-info-icon">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48">
                                <path d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m9 9a9 9 0 0 1-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 0 1 9-9"></path>
                            </svg>
                        </div>
                        <h3>Local Save Only</h3>
                        <p>You're using a <strong>demo business</strong>. Your schedule will be saved to this device only and won't sync across other devices or browsers.</p>
                        <p class="demo-tip">To save schedules to the cloud and share with your team, <a href="/login" class="demo-link">create an account</a> and add your own business.</p>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" id="demoPublishCancel">Cancel</button>
                    <button class="btn btn-primary" id="demoPublishConfirm">
                        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                            <polyline points="17 21 17 13 7 13 7 21"></polyline>
                            <polyline points="7 3 7 8 15 8"></polyline>
                        </svg>
                        Save Locally
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        
        // Setup event handlers
        modal.querySelector('.modal-backdrop').addEventListener('click', () => {
            modal.classList.remove('active');
        });
        modal.querySelector('#demoPublishClose').addEventListener('click', () => {
            modal.classList.remove('active');
        });
        modal.querySelector('#demoPublishCancel').addEventListener('click', () => {
            modal.classList.remove('active');
        });
    }
    
    // Setup confirm handler (recreate each time to get fresh weekRange)
    const confirmBtn = modal.querySelector('#demoPublishConfirm');
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
    newConfirmBtn.addEventListener('click', () => {
        modal.classList.remove('active');
        publishScheduleLocally(weekRange);
    });
    
    // Show modal
    modal.classList.add('active');
}

function publishScheduleLocally(weekRange) {
    // Save to localStorage
    saveScheduleToStorage();
    
    // Mark the week as published locally
    markWeekAsPublished(state.weekOffset);
    
    // Show success toast
    showToast(`Schedule saved locally for ${weekRange}`, 'success');
    
    // Visual feedback
    if (dom.publishBtn) {
        dom.publishBtn.classList.add('published');
        setTimeout(() => {
            dom.publishBtn.classList.remove('published');
        }, 1500);
    }
}

async function publishSchedule() {
    if (!state.currentSchedule || !state.currentSchedule.slot_assignments) {
        showToast('No schedule to publish', 'warning');
        return;
    }
    
    // Get the week range for the confirmation message
    const weekRange = getWeekRangeString(state.weekOffset);
    
    // Check if this is a demo business
    if (isDemoBusiness()) {
        showDemoPublishModal(weekRange);
        return;
    }
    
    // Show loading state
    if (dom.publishBtn) {
        dom.publishBtn.disabled = true;
        dom.publishBtn.textContent = 'Publishing...';
    }
    
    try {
        // Actually call the backend API to publish
        const response = await fetch('/api/schedule/publish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                businessId: state.business.id,
                weekOffset: state.weekOffset,
                weekStart: getWeekStartIso()
            })
        });

        const data = await response.json();

        if (data.success) {
            // Mark the week as published locally
            markWeekAsPublished(state.weekOffset);

            // Show success toast with week info
            const notified = data.notified ? ` and ${data.notified} staff notified` : '';
            showToast(`Schedule published for ${weekRange}${notified}`, 'success');
            
            // Visual feedback - briefly highlight the publish button
            if (dom.publishBtn) {
                dom.publishBtn.classList.add('published');
                setTimeout(() => {
                    dom.publishBtn.classList.remove('published');
                }, 1500);
            }
        } else {
            showToast(data.message || 'Failed to publish schedule', 'error');
        }
    } catch (error) {
        console.error('Publish error:', error);
        showToast('Failed to publish schedule. Please try again.', 'error');
    } finally {
        // Restore button state
        if (dom.publishBtn) {
            dom.publishBtn.disabled = false;
            dom.publishBtn.innerHTML = `
                <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path>
                    <polyline points="16 6 12 2 8 6"></polyline>
                    <line x1="12" y1="2" x2="12" y2="15"></line>
                </svg>
                Publish
            `;
        }
    }
}

function updateScheduleStatus(text, type) {
    // Update status badge (now only in footer)
    if (dom.scheduleStatus) {
        dom.scheduleStatus.textContent = text;
        dom.scheduleStatus.className = 'status-badge footer-status';
        if (type) dom.scheduleStatus.classList.add(type);
    }
    
    // Enable/disable publish button based on schedule state
    if (dom.publishBtn) {
        // Enable publish only when there's a generated schedule (not "Ready to generate")
        const hasSchedule = state.currentSchedule && 
                           state.currentSchedule.slot_assignments && 
                           Object.keys(state.currentSchedule.slot_assignments).length > 0;
        dom.publishBtn.disabled = !hasSchedule;
    }
}

function clearScheduleGrid() {
    const slots = dom.scheduleGrid.querySelectorAll('.slot');
    slots.forEach(slot => {
        slot.className = 'slot';
        const content = slot.querySelector('.slot-content');
        if (content) content.innerHTML = '';
    });
    
    // Clear events overlay
    const eventsContainer = document.getElementById('scheduleEvents');
    if (eventsContainer) eventsContainer.innerHTML = '';
}

function renderSchedule(schedule) {
    clearScheduleGrid();
    
    const slotAssignments = schedule.slot_assignments || {};
    const eventsContainer = document.getElementById('scheduleEvents');
    if (!eventsContainer) return;
    eventsContainer.innerHTML = '';
    
    // Get grid dimensions
    const wrapper = document.getElementById('scheduleGridWrapper');
    const grid = dom.scheduleGrid;
    const firstSlot = grid.querySelector('.slot');
    const headerRow = grid.querySelector('thead tr');
    const timeCell = grid.querySelector('.time-cell');
    
    if (!firstSlot || !wrapper) return;
    
    const hSpacing = 8; // Horizontal border-spacing between columns
    const vSpacing = 3; // Vertical border-spacing between rows
    const slotWidth = firstSlot.offsetWidth + hSpacing;
    const slotHeight = firstSlot.offsetHeight + vSpacing;
    const headerHeight = headerRow?.offsetHeight || 35;
    const timeCellWidth = (timeCell?.offsetWidth || 50) + hSpacing;
    
    // Build employee shift segments - group consecutive hours for same employee (regardless of role)
    const shiftSegments = []; // { employeeId, roles: Set, day, startHour, endHour }
    
    // Process each day separately
    state.daysOpen.forEach((day, dayIdx) => {
        // Group assignments by employee for this day (track roles per hour)
        const empHours = {}; // { empId: { hours: Map<hour, Set<roleId>> } }
        
        state.hours.forEach(hour => {
            const key = `${day},${hour}`;
            const assignments = slotAssignments[key] || [];
            
            assignments.forEach(assignment => {
                const empId = assignment.employee_id;
                if (!empHours[empId]) {
                    empHours[empId] = { hours: new Map() };
                }
                if (!empHours[empId].hours.has(hour)) {
                    empHours[empId].hours.set(hour, new Set());
                }
                empHours[empId].hours.get(hour).add(assignment.role_id);
            });
        });
        
        // Convert hour lists to segments (consecutive hours become single segment)
        Object.entries(empHours).forEach(([employeeId, data]) => {
            const hoursList = Array.from(data.hours.keys()).sort((a, b) => a - b);
            if (hoursList.length === 0) return;
            
            let segmentStart = hoursList[0];
            let prevHour = hoursList[0];
            let segmentRoles = new Set(data.hours.get(hoursList[0]));
            
            for (let i = 1; i <= hoursList.length; i++) {
                const currentHour = hoursList[i];
                
                // If not consecutive or at end, close segment
                if (currentHour !== prevHour + 1 || i === hoursList.length) {
                    shiftSegments.push({
                        employeeId,
                        roles: segmentRoles, // All roles worked during this segment
                        day,
                        dayIdx,
                        startHour: segmentStart,
                        endHour: prevHour + 1, // endHour is exclusive
                        isGap: false
                    });
                    
                    if (i < hoursList.length) {
                        segmentStart = currentHour;
                        segmentRoles = new Set(data.hours.get(currentHour));
                    }
                } else {
                    // Add roles from this hour to the segment
                    data.hours.get(currentHour).forEach(r => segmentRoles.add(r));
                }
                prevHour = currentHour;
            }
        });
    });
    
    // Build gap segments
    const gapSegments = buildGapSegments(slotAssignments, schedule);
    
    // Combine all blocks and assign columns together
    const allBlocks = [...shiftSegments, ...gapSegments];
    
    // Group all blocks by day
    const blocksByDay = {};
    state.daysOpen.forEach((day, idx) => {
        blocksByDay[idx] = allBlocks.filter(s => s.dayIdx === idx);
    });
    
    // Assign columns to all blocks using greedy algorithm
    Object.entries(blocksByDay).forEach(([dayIdx, blocks]) => {
        dayIdx = parseInt(dayIdx);
        
        // Sort: shifts first (to give them priority), then by start time
        blocks.sort((a, b) => {
            if (a.isGap !== b.isGap) return a.isGap ? 1 : -1; // Shifts first
            return a.startHour - b.startHour;
        });
        
        const columns = [];
        blocks.forEach(block => {
            let placed = false;
            for (let colIdx = 0; colIdx < columns.length; colIdx++) {
                const hasOverlap = columns[colIdx].some(s => 
                    block.startHour < s.endHour && block.endHour > s.startHour
                );
                if (!hasOverlap) {
                    block.column = colIdx;
                    columns[colIdx].push(block);
                    placed = true;
                    break;
                }
            }
            if (!placed) {
                block.column = columns.length;
                columns.push([block]);
            }
        });
        
        const numColumns = columns.length || 1;
        blocks.forEach(b => b.totalColumns = numColumns);
    });
    
    // Render shift blocks
    shiftSegments.forEach(segment => {
        const emp = employeeMap[segment.employeeId];
        if (!emp) return;
        
        // Get role names for tooltip
        const roleNames = Array.from(segment.roles)
            .map(roleId => roleMap[roleId]?.name || roleId)
            .join(', ');
        
        // Use color based on current mode
        // For role mode, use the first role's color; for employee mode, use employee color
        let color = emp.color || '#666';
        if (state.scheduleColorMode === 'role' && segment.roles.size > 0) {
            const firstRoleId = Array.from(segment.roles)[0];
            color = roleMap[firstRoleId]?.color || emp.color || '#666';
        }
        
        const hourOffset = segment.startHour - state.hours[0];
        const duration = segment.endHour - segment.startHour;
        
        const widthPadding = 6;
        const availableWidth = slotWidth - widthPadding;
        const blockWidth = segment.totalColumns > 1 
            ? (availableWidth / segment.totalColumns) - 1 
            : availableWidth;
        
        const el = document.createElement('div');
        el.className = 'schedule-shift-block';
        el.style.backgroundColor = color;
        
        const leftPos = timeCellWidth + (segment.dayIdx * slotWidth) + (widthPadding / 2) + 
            (segment.column * (blockWidth + 1));
        el.style.left = `${leftPos}px`;
        el.style.top = `${headerHeight + hourOffset * slotHeight + 2}px`;
        el.style.width = `${blockWidth}px`;
        el.style.height = `${duration * slotHeight - 4}px`;
        el.style.zIndex = 10 + segment.column;
        
        // Short name for display
        const shortName = emp.name.length > 5 ? emp.name.substring(0, 4) : emp.name;
        el.innerHTML = `<span class="shift-name">${shortName}</span>`;
        el.title = `${emp.name}\nRoles: ${roleNames}\n${formatHour(segment.startHour)} - ${formatHour(segment.endHour)}`;
        
        // Make clickable to edit
        el.addEventListener('click', () => {
            openSlotEditor(segment.day, segment.startHour);
        });
        
        eventsContainer.appendChild(el);
    });
    
    // Render gap blocks
    gapSegments.forEach(gap => {
        const role = roleMap[gap.roleId];
        const hourOffset = gap.startHour - state.hours[0];
        const duration = gap.endHour - gap.startHour;
        
        const widthPadding = 6;
        const availableWidth = slotWidth - widthPadding;
        const blockWidth = gap.totalColumns > 1 
            ? (availableWidth / gap.totalColumns) - 1 
            : availableWidth;
        
        const el = document.createElement('div');
        el.className = 'schedule-gap-block';
        
        const leftPos = timeCellWidth + (gap.dayIdx * slotWidth) + (widthPadding / 2) + 
            ((gap.column || 0) * (blockWidth + 1));
        el.style.left = `${leftPos}px`;
        el.style.top = `${headerHeight + hourOffset * slotHeight + 2}px`;
        el.style.width = `${blockWidth}px`;
        el.style.height = `${duration * slotHeight - 4}px`;
        el.style.zIndex = 50 + (gap.column || 0); // Higher z-index than shifts
        
        // Show the role name whenever the block is tall enough to fit it
        const roleLabel = duration >= 2 && role?.name ? ` ${escHtml(role.name)}` : '';
        el.innerHTML = `<span class="gap-label">+${gap.needed}${roleLabel}</span>`;
        el.title = `Still need ${gap.needed} ${role?.name || 'staff'} ${formatHour(gap.startHour)} - ${formatHour(gap.endHour)}\nClick to see who is available`;
        
        // Add click handler to show available employees
        el.addEventListener('click', () => {
            openGapModal(gap);
        });
        
        eventsContainer.appendChild(el);
    });
    
    // Update legend
    renderScheduleLegend();
}

function buildGapSegments(slotAssignments, schedule) {
    const gapSegments = [];
    
    // Only show gaps if there's actual schedule data (a schedule has been generated)
    // Don't show red gaps before generating or after resetting
    const hasScheduleData = Object.keys(slotAssignments).length > 0 && 
        Object.values(slotAssignments).some(arr => arr && arr.length > 0);
    
    if (!hasScheduleData) {
        return gapSegments; // Return empty - no gaps to show
    }
    
    // Use unfilled_slots from schedule metrics if available (works for all coverage modes)
    const unfilledSlots = schedule?.metrics?.unfilled_slots || [];
    
    if (unfilledSlots.length > 0) {
        // Group unfilled slots by day
        const gapsByDay = {};
        unfilledSlots.forEach(slot => {
            const day = parseInt(slot.day);
            if (!gapsByDay[day]) gapsByDay[day] = [];
            gapsByDay[day].push(slot);
        });
        
        // Convert to segments for each day
        state.daysOpen.forEach((day, dayIdx) => {
            const dayGaps = gapsByDay[day] || [];
            if (dayGaps.length === 0) return;
            
            // Group by hour and sum needed
            const hourGaps = {};
            dayGaps.forEach(slot => {
                const hour = parseInt(slot.hour);
                if (!hourGaps[hour]) {
                    hourGaps[hour] = { needed: 0, roleId: slot.role_id };
                }
                hourGaps[hour].needed += slot.needed || 1;
                hourGaps[hour].roleId = slot.role_id;
            });
            
            // Convert to array and sort
            const gapHours = Object.entries(hourGaps)
                .map(([hour, data]) => ({ hour: parseInt(hour), ...data }))
                .sort((a, b) => a.hour - b.hour);
            
            if (gapHours.length === 0) return;
            
            // Build consecutive segments
            let segStart = gapHours[0].hour;
            let prevHour = gapHours[0].hour;
            let maxGap = gapHours[0].needed;
            let roleId = gapHours[0].roleId;
            
            for (let i = 1; i <= gapHours.length; i++) {
                const current = gapHours[i];
                
                if (!current || current.hour !== prevHour + 1) {
                    gapSegments.push({
                        roleId,
                        day,
                        dayIdx,
                        startHour: segStart,
                        endHour: prevHour + 1,
                        needed: maxGap,
                        isGap: true
                    });
                    
                    if (current) {
                        segStart = current.hour;
                        maxGap = current.needed;
                        roleId = current.roleId;
                    }
                } else {
                    maxGap = Math.max(maxGap, current.needed);
                }
                if (current) prevHour = current.hour;
            }
        });
        
        return gapSegments;
    }
    
    // Fallback to shift templates if no unfilled_slots data
    const shiftTemplates = state.shiftTemplates || [];
    if (shiftTemplates.length === 0) return [];
    
    state.daysOpen.forEach((day, dayIdx) => {
        // Group consecutive gap hours
        const gapHours = []; // [{hour, needed}...]
        
        state.hours.forEach(hour => {
            const key = `${day},${hour}`;
            const assignments = slotAssignments[key] || [];
            
            // Count assigned by role for this slot
            const assignedByRole = {};
            assignments.forEach(a => {
                assignedByRole[a.role_id] = (assignedByRole[a.role_id] || 0) + 1;
            });
            
            // Find requirements from shift templates for this hour and day
            let totalGap = 0;
            let gapRoleId = null;
            
            shiftTemplates.forEach(shift => {
                if (!shift.days || !shift.days.includes(day)) return;
                if (hour < shift.start_hour || hour >= shift.end_hour) return;
                
                (shift.roles || []).forEach(roleReq => {
                    const needed = roleReq.count || 0;
                    if (needed <= 0) return;
                    
                    const assigned = assignedByRole[roleReq.role_id] || 0;
                    const gap = needed - assigned;
                    
                    if (gap > 0) {
                        totalGap += gap;
                        gapRoleId = roleReq.role_id;
                    }
                });
            });
            
            if (totalGap > 0) {
                gapHours.push({ hour, needed: totalGap, roleId: gapRoleId });
            }
        });
        
        // Convert to segments (consecutive gaps become single segment)
        if (gapHours.length === 0) return;
        
        gapHours.sort((a, b) => a.hour - b.hour);
        
        let segStart = gapHours[0].hour;
        let prevHour = gapHours[0].hour;
        let maxGap = gapHours[0].needed;
        let roleId = gapHours[0].roleId;
        
        for (let i = 1; i <= gapHours.length; i++) {
            const current = gapHours[i];
            
            if (!current || current.hour !== prevHour + 1) {
                gapSegments.push({
                    roleId,
                    day,
                    dayIdx,
                    startHour: segStart,
                    endHour: prevHour + 1,
                    needed: maxGap,
                    isGap: true
                });
                
                if (current) {
                    segStart = current.hour;
                    maxGap = current.needed;
                    roleId = current.roleId;
                }
            } else {
                maxGap = Math.max(maxGap, current.needed);
            }
            if (current) prevHour = current.hour;
        }
    });
    
    return gapSegments;
}

// ==================== SCHEDULE LEGEND ====================
function renderScheduleLegend() {
    const legendContainer = document.getElementById('scheduleLegend');
    const legendTitle = document.getElementById('legendTitle');
    if (!legendContainer) return;
    
    legendContainer.innerHTML = '';
    
    if (state.scheduleColorMode === 'employee') {
        legendTitle.textContent = 'Employees';
        
        // Show all employees with their colors
        state.employees.forEach(emp => {
            const item = document.createElement('div');
            item.className = 'legend-item';
            item.innerHTML = `
                <span class="legend-color" style="background: ${emp.color || '#666'}"></span>
                <span>${emp.name}</span>
            `;
            legendContainer.appendChild(item);
        });
    } else {
        legendTitle.textContent = 'Roles';
        
        // Show all roles with their colors
        state.roles.forEach(role => {
            const item = document.createElement('div');
            item.className = 'legend-item';
            item.innerHTML = `
                <span class="legend-color" style="background: ${role.color || '#666'}"></span>
                <span>${role.name}</span>
            `;
            legendContainer.appendChild(item);
        });
    }
    
    // Add gap indicator to legend
    const gapItem = document.createElement('div');
    gapItem.className = 'legend-item gap-indicator';
    gapItem.innerHTML = `
        <span class="legend-color"></span>
        <span>Still Needed</span>
    `;
    legendContainer.appendChild(gapItem);
}

// ==================== SIMPLE TABLE VIEW ====================
let tableFilterWired = false;

/** Search box + role chips above the table view. Chips rebuild on each render; listeners attach once. */
function renderTableFilterChips() {
    const bar = document.getElementById('tableFilterBar');
    if (!bar) return;
    const chips = bar.querySelector('#tableRoleChips');
    const input = bar.querySelector('#tableSearchInput');
    const clearBtn = bar.querySelector('#tableFilterClear');
    const filter = state.tableFilter;

    chips.innerHTML = '';
    [...state.roles].sort((a, b) => a.name.localeCompare(b.name)).forEach(role => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'role-chip' + (filter.roles.has(role.id) ? ' active' : '');
        chip.dataset.roleId = role.id;
        chip.style.setProperty('--chip-color', role.color);
        chip.innerHTML = `<span class="role-chip-dot"></span>${escHtml(role.name)}`;
        chip.title = filter.roles.has(role.id) ? `Hide ${role.name}` : `Show only ${role.name}${filter.roles.size ? ' (adds to current filter)' : ''}`;
        chip.addEventListener('click', () => {
            if (filter.roles.has(role.id)) filter.roles.delete(role.id); else filter.roles.add(role.id);
            renderSimpleTableView(state.currentSchedule || { slot_assignments: {} });
        });
        chips.appendChild(chip);
    });
    const active = !!(filter.search || filter.roles.size);
    clearBtn.hidden = !active;
    bar.classList.toggle('filter-active', active);

    if (!tableFilterWired) {
        tableFilterWired = true;
        input.addEventListener('input', () => {
            filter.search = input.value;
            renderSimpleTableView(state.currentSchedule || { slot_assignments: {} });
        });
        clearBtn.addEventListener('click', () => {
            filter.search = '';
            filter.roles.clear();
            input.value = '';
            renderSimpleTableView(state.currentSchedule || { slot_assignments: {} });
        });
    }
}

function renderSimpleTableView(schedule) {
    const tbody = document.getElementById('simpleScheduleBody');
    const table = document.getElementById('simpleScheduleTable');
    if (!tbody || !table) return;
    
    // Rebuild header with dates and week navigation
    const thead = table.querySelector('thead tr');
    if (thead) {
        const weekDates = getWeekDates(state.weekOffset);
        const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        
        // First column: Name label (week nav is now in the bar above)
        thead.innerHTML = '<th class="name-col">Name</th>';
        
        // Add day columns with dates
        for (let i = 0; i < 7; i++) {
            const th = document.createElement('th');
            th.className = i % 2 === 0 ? 'day-even' : 'day-odd';
            th.innerHTML = `
                <span class="day-name">${dayNames[i]}</span>
                <span class="day-date">${formatShortDate(weekDates[i])}</span>
            `;
            thead.appendChild(th);
        }
        
        // Add hours column
        const hoursCol = document.createElement('th');
        hoursCol.className = 'hours-col';
        hoursCol.textContent = 'Hours';
        thead.appendChild(hoursCol);
    }
    
    tbody.innerHTML = '';
    const slotAssignments = schedule.slot_assignments || {};
    
    // Build employee schedule data
    const employeeSchedules = {}; // { empId: { days: { 0: [{start, end}], ... }, totalHours: 0 } }
    
    // Initialize for all employees
    state.employees.forEach(emp => {
        employeeSchedules[emp.id] = {
            employee: emp,
            days: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] },
            totalHours: 0,
            rolesWorked: new Set()
        };
    });

    // Process slot assignments to build shift segments
    for (let day = 0; day < 7; day++) {
        const empHoursToday = {}; // { empId: [hours...] }

        state.hours.forEach(hour => {
            const key = `${day},${hour}`;
            const assignments = slotAssignments[key] || [];

            assignments.forEach(assignment => {
                if (!empHoursToday[assignment.employee_id]) {
                    empHoursToday[assignment.employee_id] = [];
                }
                empHoursToday[assignment.employee_id].push(hour);
                employeeSchedules[assignment.employee_id]?.rolesWorked.add(assignment.role_id);
            });
        });
        
        // Convert hours to shift segments
        Object.entries(empHoursToday).forEach(([empId, hours]) => {
            if (!employeeSchedules[empId]) return;
            hours.sort((a, b) => a - b);
            
            let segStart = hours[0];
            let prevHour = hours[0];
            
            for (let i = 1; i <= hours.length; i++) {
                const currentHour = hours[i];
                
                if (currentHour !== prevHour + 1 || i === hours.length) {
                    employeeSchedules[empId].days[day].push({
                        start: segStart,
                        end: prevHour + 1
                    });
                    employeeSchedules[empId].totalHours += (prevHour + 1 - segStart);
                    
                    if (i < hours.length) {
                        segStart = currentHour;
                    }
                }
                prevHour = currentHour;
            }
        });
    }
    
    // Build gaps row - use unfilled_slots from schedule metrics if available
    const gaps = { days: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }, totalHours: 0 };
    const unfilledSlots = schedule?.metrics?.unfilled_slots || [];
    
    if (unfilledSlots.length > 0) {
        // Use unfilled_slots from schedule
        for (let day = 0; day < 7; day++) {
            const dayUnfilled = unfilledSlots.filter(s => parseInt(s.day) === day);
            if (dayUnfilled.length === 0) continue;
            
            const gapHours = [...new Set(dayUnfilled.map(s => parseInt(s.hour)))].sort((a, b) => a - b);
            
            if (gapHours.length > 0) {
                let segStart = gapHours[0];
                let prevHour = gapHours[0];
                
                for (let i = 1; i <= gapHours.length; i++) {
                    const currentHour = gapHours[i];
                    
                    if (currentHour !== prevHour + 1 || i === gapHours.length) {
                        gaps.days[day].push({ start: segStart, end: prevHour + 1 });
                        gaps.totalHours += (prevHour + 1 - segStart);
                        
                        if (i < gapHours.length) segStart = currentHour;
                    }
                    prevHour = currentHour;
                }
            }
        }
    } else {
        // Fallback to shift templates
        const shiftTemplates = state.shiftTemplates || [];
        
        for (let day = 0; day < 7; day++) {
            const gapHours = [];
            
            state.hours.forEach(hour => {
                const key = `${day},${hour}`;
                const assignments = slotAssignments[key] || [];
                
                // Count what's assigned
                const assignedByRole = {};
                assignments.forEach(a => {
                    assignedByRole[a.role_id] = (assignedByRole[a.role_id] || 0) + 1;
                });
                
                // Check against requirements
                let hasGap = false;
                shiftTemplates.forEach(shift => {
                    if (!shift.days || !shift.days.includes(day)) return;
                    if (hour < shift.start_hour || hour >= shift.end_hour) return;
                    
                    (shift.roles || []).forEach(roleReq => {
                        const needed = roleReq.count || 0;
                        const assigned = assignedByRole[roleReq.role_id] || 0;
                        if (needed > assigned) hasGap = true;
                    });
                });
                
                if (hasGap) gapHours.push(hour);
            });
            
            // Convert gap hours to segments
            if (gapHours.length > 0) {
                gapHours.sort((a, b) => a - b);
                let segStart = gapHours[0];
                let prevHour = gapHours[0];
                
                for (let i = 1; i <= gapHours.length; i++) {
                    const currentHour = gapHours[i];
                    
                    if (currentHour !== prevHour + 1 || i === gapHours.length) {
                        gaps.days[day].push({ start: segStart, end: prevHour + 1 });
                        gaps.totalHours += (prevHour + 1 - segStart);
                        
                        if (i < gapHours.length) segStart = currentHour;
                    }
                    prevHour = currentHour;
                }
            }
        }
    }
    
    // Check if we have any schedule data (slot assignments with actual entries)
    const hasScheduleData = Object.keys(slotAssignments).length > 0 && 
        Object.values(slotAssignments).some(arr => arr && arr.length > 0);
    
    if (!hasScheduleData) {
        // No schedule generated yet - show a single blank row
        const row = document.createElement('tr');
        row.className = 'placeholder-row';
        
        let html = `<td class="name-col"></td>`;
        
        for (let day = 0; day < 7; day++) {
            const dayClass = day % 2 === 0 ? 'day-even' : 'day-odd';
            html += `<td class="shift-times ${dayClass}"></td>`;
        }
        
        html += `<td class="total-hours"></td>`;
        row.innerHTML = html;
        tbody.appendChild(row);
        return; // Don't render anything else
    }
    
    // "Still needed" row: one badge per open shift, naming the role, wrapping onto new lines
    renderTableFilterChips();
    const openRanges = (schedule?.metrics?.unfilled_ranges?.length
        ? schedule.metrics.unfilled_ranges
        : groupUnfilledRanges(schedule?.metrics?.unfilled_slots || []));
    if (openRanges.length > 0 || gaps.totalHours > 0) {
        const row = document.createElement('tr');
        row.className = 'gap-row';
        const totalOpen = openRanges.length
            ? openRanges.reduce((sum, r) => sum + (r.end_hour - r.start_hour) * r.needed, 0)
            : gaps.totalHours;

        let html = `<td class="name-col"><div class="emp-name"><span>⚠ Still needed</span></div></td>`;
        for (let day = 0; day < 7; day++) {
            const dayClass = day % 2 === 0 ? 'day-even' : 'day-odd';
            const ranges = openRanges.length
                ? openRanges.filter(r => r.day === day)
                : gaps.days[day].map(s => ({ start_hour: s.start, end_hour: s.end, needed: 1, role_name: '' }));
            if (ranges.length === 0) {
                html += `<td class="shift-times ${dayClass}"><span class="no-shift">—</span></td>`;
            } else {
                const badges = ranges.map(r => {
                    const who = r.role_name ? `${r.needed > 1 ? r.needed + ' ' : ''}${escHtml(r.role_name)}` : `+${r.needed}`;
                    return `<span class="gap-badge" title="Still need ${r.needed} ${escHtml(r.role_name || 'staff')} ${formatHour(r.start_hour)}-${formatHour(r.end_hour)}"><span class="gap-badge-role">${who}</span><span class="gap-badge-time">${formatHour(r.start_hour)}–${formatHour(r.end_hour)}</span></span>`;
                }).join('');
                html += `<td class="shift-times ${dayClass}">${badges}</td>`;
            }
        }
        html += `<td class="total-hours">${totalOpen}h</td>`;
        row.innerHTML = html;
        tbody.appendChild(row);
    }
    
    // Build PTO data by employee for this week
    const weekDates = getWeekDates(state.weekOffset);
    const ptoByEmployee = {};
    
    (state.approvedPTO || []).forEach(pto => {
        const empKey = pto.employee_id;
        if (!ptoByEmployee[empKey]) {
            ptoByEmployee[empKey] = {
                employee_name: pto.employee_name,
                employee_color: pto.employee_color,
                pto_type: pto.pto_type,
                days: {}
            };
        }
        
        // Mark which days have PTO
        for (let day = 0; day < 7; day++) {
            const dayDate = weekDates[day];
            const ptoStart = new Date(pto.start_date + 'T00:00:00');
            const ptoEnd = new Date(pto.end_date + 'T00:00:00');
            
            if (dayDate >= ptoStart && dayDate <= ptoEnd) {
                ptoByEmployee[empKey].days[day] = pto.pto_type;
            }
        }
    });
    
    // Merge employees: those with shifts OR those with PTO this week
    const allEmployeeIds = new Set([
        ...Object.keys(employeeSchedules),
        ...Object.keys(ptoByEmployee)
    ]);
    
    // Build combined employee data for rendering
    const combinedEmployeeData = [];
    
    allEmployeeIds.forEach(empId => {
        const schedule = employeeSchedules[empId];
        const pto = ptoByEmployee[empId];
        
        // Get employee info from schedule or PTO data
        let emp, totalHours, days;
        if (schedule) {
            emp = schedule.employee;
            totalHours = schedule.totalHours;
            days = schedule.days;
            } else {
            // Employee only has PTO, no scheduled shifts
            emp = {
                id: empId,
                name: pto.employee_name,
                color: pto.employee_color
            };
            totalHours = 0;
            days = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
        }
        
        // Count PTO days
        const ptoDays = pto ? Object.keys(pto.days).length : 0;
        
        // Only include if has hours OR has PTO this week
        if (totalHours > 0 || ptoDays > 0) {
            combinedEmployeeData.push({
                emp,
                totalHours,
                days,
                pto: pto || null,
                ptoDays
            });
        }
    });
    
    // Sort: employees with shifts first (by hours desc), then PTO-only employees
    combinedEmployeeData.sort((a, b) => {
        // Both have hours - sort by hours
        if (a.totalHours > 0 && b.totalHours > 0) {
            return b.totalHours - a.totalHours;
        }
        // One has hours, one doesn't - hours first
        if (a.totalHours > 0) return -1;
        if (b.totalHours > 0) return 1;
        // Both have only PTO - sort by name
        return a.emp.name.localeCompare(b.emp.name);
    });
    
    // Search + role filter (table view only)
    const filter = state.tableFilter || { search: '', roles: new Set() };
    const search = (filter.search || '').trim().toLowerCase();
    const visibleData = combinedEmployeeData.filter(({ emp }) => {
        if (search && !(emp.name || '').toLowerCase().includes(search)) return false;
        if (filter.roles.size) {
            const worked = employeeSchedules[emp.id]?.rolesWorked || new Set();
            const held = new Set(employeeMap[emp.id]?.roles || []);
            const match = [...filter.roles].some(r => worked.has(r) || (worked.size === 0 && held.has(r)));
            if (!match) return false;
        }
        return true;
    });

    // Render employee rows (including PTO in same row)
    visibleData.forEach(({ emp, totalHours, days, pto }) => {
            const row = document.createElement('tr');
            row.className = 'emp-row';
            row.dataset.empId = emp.id;
            row.title = 'Click to see availability, rules and preferences';
            const rolesWorked = [...(employeeSchedules[emp.id]?.rolesWorked || [])].map(r => roleMap[r]?.name || r);

            let html = `<td class="name-col"><div class="emp-name">
                <span class="emp-color" style="background: ${escHtml(emp.color || '#666')}"></span>
                <span class="emp-name-text">${escHtml(emp.name)}</span>
                ${rolesWorked.length ? `<span class="emp-name-role">${escHtml(rolesWorked.join(', '))}</span>` : ''}
                <svg class="emp-row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </div></td>`;
            
            for (let day = 0; day < 7; day++) {
                const dayClass = day % 2 === 0 ? 'day-even' : 'day-odd';
            const hasPTO = pto && pto.days[day];
            const shifts = days[day] || [];
            
            if (hasPTO) {
                // Show PTO badge for this day
                const emoji = getPTOTypeEmoji(pto.days[day]);
                html += `<td class="shift-times ${dayClass}">
                    <span class="pto-shift">${emoji} ${capitalizeFirst(pto.days[day])}</span>
                </td>`;
            } else if (shifts.length === 0) {
                    html += `<td class="shift-times ${dayClass}"><span class="no-shift">—</span></td>`;
                } else {
                    const shiftStrs = shifts.map(s => `<span class="shift-block">${formatHour(s.start)}-${formatHour(s.end)}</span>`).join('');
                    html += `<td class="shift-times ${dayClass}">${shiftStrs}</td>`;
                }
            }
            
        // Show hours or "Off" for PTO-only employees
        const hoursDisplay = totalHours > 0 ? `${totalHours}h` : 'Off';
        html += `<td class="total-hours">${hoursDisplay}</td>`;
            row.innerHTML = html;
            tbody.appendChild(row);

            // Expandable details: availability for the week, then rules/preferences
            const fullEmp = employeeMap[emp.id];
            if (fullEmp) {
                const detailRow = document.createElement('tr');
                detailRow.className = 'emp-detail-row';
                detailRow.hidden = true;
                detailRow.innerHTML = `<td colspan="9">${buildEmployeeDetailHtml(fullEmp, { availability: true, rules: true })}</td>`;
                tbody.appendChild(detailRow);
                row.addEventListener('click', () => {
                    const open = !detailRow.hidden;
                    tbody.querySelectorAll('.emp-detail-row').forEach(r => { r.hidden = true; });
                    tbody.querySelectorAll('.emp-row.expanded').forEach(r => r.classList.remove('expanded'));
                    if (!open) {
                        detailRow.hidden = false;
                        row.classList.add('expanded');
                    }
                });
            }
        });

    // Nothing matched the filter / nothing scheduled yet
    if (visibleData.length === 0) {
        const row = document.createElement('tr');
        const filtered = search || filter.roles.size;
        row.innerHTML = `<td colspan="9" style="text-align: center; color: var(--text-muted); padding: 2rem;">
            ${filtered ? 'No team members match your search or filter.' : 'No schedule generated yet. Click "Generate Schedule" to create one.'}
        </td>`;
        tbody.appendChild(row);
    }
    
    // Update legend for table view too
    renderScheduleLegend();
}

// ==================== TIMELINE VIEW ====================

// Helper function to calculate hour from mouse position in timeline (snaps to full hours)
function getTimelineHourFromPosition(x, slotsContainer) {
    if (!slotsContainer) return null;
    const rect = slotsContainer.getBoundingClientRect();
    const relativeX = x - rect.left;
    const totalWidth = rect.width;
    const totalHours = state.endHour - state.startHour;
    
    // Calculate which hour the mouse is over
    const hourFloat = (relativeX / totalWidth) * totalHours;
    
    // Snap to nearest hour
    const snappedHour = Math.round(hourFloat);
    
    // Clamp to valid range and return the actual hour value
    const clampedHour = Math.max(0, Math.min(snappedHour, totalHours - 1));
    return state.startHour + clampedHour;
}

// Helper function to get day index from a timeline row element
function getDayIdxFromRow(rowElement) {
    if (!rowElement) return null;
    return parseInt(rowElement.dataset.dayIdx);
}

// Helper function to show drop zones on all days
function showTimelineDropZones() {
    document.querySelectorAll('.timeline-drop-zone').forEach(zone => {
        zone.classList.add('visible');
    });
}

// Helper function to hide drop zones
function hideTimelineDropZones() {
    document.querySelectorAll('.timeline-drop-zone').forEach(zone => {
        zone.classList.remove('visible');
        zone.classList.remove('drag-over');
    });
    // Remove any ghost previews
    document.querySelectorAll('.timeline-ghost-preview').forEach(g => g.remove());
}

// Helper function to create ghost preview element
function createGhostPreview(shift, targetHour, slotsContainer) {
    // Remove existing ghost
    document.querySelectorAll('.timeline-ghost-preview').forEach(g => g.remove());
    
    if (!slotsContainer || targetHour === null) return null;
    
    const totalHours = state.endHour - state.startHour;
    const duration = shift.endHour - shift.startHour;
    const startIdx = targetHour - state.startHour;
    
    // Validate position is within bounds
    if (startIdx < 0 || startIdx >= totalHours) return null;
    
    const ghost = document.createElement('div');
    ghost.className = 'timeline-ghost-preview';
    
    // Align with hour columns
    const leftPercent = (startIdx / totalHours) * 100;
    const widthPercent = (duration / totalHours) * 100;
    ghost.style.left = `${leftPercent}%`;
    ghost.style.width = `${Math.max(widthPercent, (1 / totalHours) * 100)}%`; // Min 1 hour width
    
    const emp = employeeMap[shift.empId];
    const endHour = targetHour + duration;
    ghost.style.background = emp?.color || '#6366f1';
    ghost.innerHTML = `<span class="shift-name">${emp?.name || 'Staff'}</span>`;
    ghost.title = `${formatHour(targetHour)} - ${formatHour(endHour)}`;
    
    return ghost;
}

// Move shift to new position
function moveShift(empId, roleId, fromDayIdx, fromStart, fromEnd, toDayIdx, toStart, toRoleId = null) {
    if (!state.currentSchedule) return false;

    const slotAssignments = state.currentSchedule.slot_assignments;
    const duration = fromEnd - fromStart;
    const newRoleId = toRoleId || roleId;
    
    // Round to nearest hour for storage
    const toStartHour = Math.floor(toStart);
    const toEndHour = Math.ceil(toStartHour + duration);
    
    // Validate new position is within business hours
    if (toStartHour < state.startHour || toEndHour > state.endHour) {
        showToast('Shift would extend outside business hours', 'error');
        return false;
    }
    
    // Find and remove ALL existing assignments for this employee on the source day
    for (let hour = state.startHour; hour < state.endHour; hour++) {
        const key = `${fromDayIdx},${hour}`;
        if (slotAssignments[key]) {
            slotAssignments[key] = slotAssignments[key].filter(a => a.employee_id !== empId);
            if (slotAssignments[key].length === 0) {
                delete slotAssignments[key];
            }
        }
    }
    
    // Add new assignments at target location (hourly slots)
    for (let hour = toStartHour; hour < toEndHour; hour++) {
        const key = `${toDayIdx},${hour}`;
        if (!slotAssignments[key]) {
            slotAssignments[key] = [];
        }
        // Check to avoid duplicates
        if (!slotAssignments[key].some(a => a.employee_id === empId)) {
            slotAssignments[key].push({
                employee_id: empId,
                role_id: newRoleId
            });
        }
    }
    // A moved shift loses any 15-minute precision it had
    if (state.currentSchedule.shift_times) delete state.currentSchedule.shift_times[`${empId}_${fromDayIdx}`];

    afterManualScheduleEdit();

    const emp = employeeMap[empId];
    const dayName = state.days[toDayIdx];
    const roleNote = newRoleId !== roleId ? ` as ${roleMap[newRoleId]?.name || 'a new role'}` : '';
    showToast(`${emp?.name}'s shift moved to ${dayName} ${formatHour(toStartHour)}-${formatHour(toEndHour)}${roleNote}`, 'success');

    return true;
}

// Resize shift (change start or end time) - supports 15-minute precision
function resizeShift(empId, roleId, dayIdx, oldStart, oldEnd, newStart, newEnd) {
    if (!state.currentSchedule) return false;
    
    const slotAssignments = state.currentSchedule.slot_assignments;
    
    // Initialize shift_times if needed (stores precise start/end for display)
    if (!state.currentSchedule.shift_times) {
        state.currentSchedule.shift_times = {};
    }
    
    // Round to nearest 15 minutes (0.25 hour increments)
    const roundTo15Min = (time) => Math.round(time * 4) / 4;
    const preciseStart = roundTo15Min(newStart);
    const preciseEnd = roundTo15Min(newEnd);
    
    // Calculate which hours need slot coverage (floor start, ceil end)
    const newStartHour = Math.floor(preciseStart);
    const newEndHour = Math.ceil(preciseEnd);
    
    // Validate new times
    if (preciseStart >= preciseEnd) {
        showToast('Shift must be at least 15 minutes', 'error');
        return false;
    }
    if (preciseStart < state.startHour || preciseEnd > state.endHour) {
        showToast('Shift would extend outside business hours', 'error');
        return false;
    }
    
    // First, find all hours where this employee is currently assigned on this day
    const currentHours = [];
    for (let hour = state.startHour; hour < state.endHour; hour++) {
        const key = `${dayIdx},${hour}`;
        if (slotAssignments[key]?.some(a => a.employee_id === empId)) {
            currentHours.push(hour);
        }
    }
    
    // Remove ALL existing assignments for this employee on this day
    currentHours.forEach(hour => {
        const key = `${dayIdx},${hour}`;
        if (slotAssignments[key]) {
            slotAssignments[key] = slotAssignments[key].filter(a => a.employee_id !== empId);
            if (slotAssignments[key].length === 0) {
                delete slotAssignments[key];
            }
        }
    });
    
    // Add new assignments for the new range (hourly slots for coverage)
    for (let hour = newStartHour; hour < newEndHour; hour++) {
        const key = `${dayIdx},${hour}`;
        if (!slotAssignments[key]) {
            slotAssignments[key] = [];
        }
        // Check if this employee is already assigned (shouldn't happen but be safe)
        if (!slotAssignments[key].some(a => a.employee_id === empId)) {
            slotAssignments[key].push({
                employee_id: empId,
                role_id: roleId
            });
        }
    }
    
    // Store precise times for this shift (for display purposes)
    const shiftKey = `${empId}_${dayIdx}`;
    state.currentSchedule.shift_times[shiftKey] = {
        start: preciseStart,
        end: preciseEnd,
        roleId: roleId
    };

    afterManualScheduleEdit();

    const emp = employeeMap[empId];
    showToast(`${emp?.name}'s shift adjusted to ${formatHourMinute(preciseStart)}-${formatHourMinute(preciseEnd)}`, 'success');
    
    return true;
}

// Format hour with minutes (e.g., 9.25 -> "9:15am")
function formatHourMinute(time) {
    const hour = Math.floor(time);
    const minutes = Math.round((time - hour) * 60);
    const period = hour >= 12 ? 'pm' : 'am';
    const displayHour = hour === 0 ? 12 : (hour > 12 ? hour - 12 : hour);
    if (minutes === 0) {
        return `${displayHour}${period}`;
    }
    return `${displayHour}:${minutes.toString().padStart(2, '0')}${period}`;
}

// Delete shift from schedule
function deleteShiftFromTimeline(empId, dayIdx, startHour, endHour) {
    if (!state.currentSchedule) return false;
    
    const slotAssignments = state.currentSchedule.slot_assignments;
    
    // Remove assignments
    for (let hour = startHour; hour < endHour; hour++) {
        const key = `${dayIdx},${hour}`;
        if (slotAssignments[key]) {
            slotAssignments[key] = slotAssignments[key].filter(a => a.employee_id !== empId);
            if (slotAssignments[key].length === 0) {
                delete slotAssignments[key];
            }
        }
    }
    
    afterManualScheduleEdit();

    const emp = employeeMap[empId];
    showToast(`${emp?.name}'s shift deleted`, 'success');

    return true;
}

// Start resize operation
function startResize(e, block, edge, dayIdx, shift) {
    timelineDragState.isResizing = true;
    timelineDragState.resizeEdge = edge;
    timelineDragState.activeShift = shift;
    timelineDragState.originalDayIdx = dayIdx;
    timelineDragState.originalStartHour = shift.startHour;
    timelineDragState.originalEndHour = shift.endHour;
    
    block.classList.add('resizing');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    
    // Get the slots container for this day
    // The lanes container spans exactly the hour columns (the role label sits outside it)
    const slotsContainer = block.closest('.timeline-role-lanes') || block.closest('.timeline-slots');
    
    // Store initial mouse position and block dimensions
    const blockRect = block.getBoundingClientRect();
    const containerRect = slotsContainer.getBoundingClientRect();
    const totalHours = state.hours.length;
    const hourWidth = containerRect.width / totalHours;
    
    let currentStart = shift.startHour;
    let currentEnd = shift.endHour;
    
    // Create resize preview overlay
    const preview = document.createElement('div');
    preview.className = 'resize-preview-overlay';
    preview.style.position = 'fixed';
    preview.style.top = `${blockRect.top}px`;
    preview.style.height = `${blockRect.height}px`;
    preview.style.background = 'rgba(99, 102, 241, 0.3)';
    preview.style.border = '2px solid var(--accent)';
    preview.style.borderRadius = '4px';
    preview.style.pointerEvents = 'none';
    preview.style.zIndex = '10000';
    document.body.appendChild(preview);
    
    function updatePreview() {
        const startIdx = currentStart - state.startHour;
        const endIdx = currentEnd - state.startHour;
        const duration = currentEnd - currentStart;
        
        const left = containerRect.left + (startIdx / totalHours) * containerRect.width;
        const width = (duration / totalHours) * containerRect.width;
        
        preview.style.left = `${left}px`;
        preview.style.width = `${width}px`;
        preview.textContent = `${formatHour(currentStart)} - ${formatHour(currentEnd)}`;
        preview.style.display = 'flex';
        preview.style.alignItems = 'center';
        preview.style.justifyContent = 'center';
        preview.style.color = 'white';
        preview.style.fontSize = '0.75rem';
        preview.style.fontWeight = '600';
    }
    
    updatePreview();
    
    function onMouseMove(e) {
        const mouseX = e.clientX;
        const relativeX = mouseX - containerRect.left;
        
        // Calculate which hour boundary the mouse is closest to
        const hourFloat = (relativeX / containerRect.width) * totalHours;
        
        if (edge === 'left') {
            // Snap to nearest 15 minutes (0.25 hours) - changes at 7.5 min midpoints
            const snappedHourFloat = Math.round(hourFloat * 4) / 4;
            const targetHour = state.startHour + Math.max(0, Math.min(snappedHourFloat, totalHours - 0.25));
            
            // Adjusting start time - ensure at least 15 min shift
            if (targetHour >= state.startHour && targetHour < currentEnd - 0.25) {
                currentStart = targetHour;
            }
        } else {
            // Snap to nearest 15 minutes (0.25 hours) - changes at 7.5 min midpoints
            const snappedHourFloat = Math.round(hourFloat * 4) / 4;
            const targetHour = state.startHour + Math.max(0.25, Math.min(snappedHourFloat, totalHours));
            
            // Adjusting end time - ensure at least 15 min shift
            if (targetHour <= state.endHour && targetHour > currentStart + 0.25) {
                currentEnd = targetHour;
            }
        }
        
        updatePreview();
    }
    
    function onMouseUp(e) {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        
        block.classList.remove('resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        preview.remove();
        
        timelineDragState.isResizing = false;
        timelineDragState.resizeEdge = null;
        timelineDragState.activeShift = null;
        
        // Apply the resize if changed
        if (currentStart !== shift.startHour || currentEnd !== shift.endHour) {
            resizeShift(
                shift.empId,
                shift.roleId,
                dayIdx,
                shift.startHour,
                shift.endHour,
                currentStart,
                currentEnd
            );
        }
    }
    
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
}

// ==================== TIMELINE VIEW (days as rows, one lane group per role) ====================

/** Escape text before dropping it into innerHTML. */
function escHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/**
 * Break one day's slot assignments into shift segments per employee AND role.
 * Someone who switches roles mid-day gets one bar per role, so every bar can
 * live in the row of the role it belongs to.
 */
function buildTimelineSegmentsForDay(slotAssignments, dayIdx) {
    const byEmp = {};
    state.hours.forEach(hour => {
        (slotAssignments[`${dayIdx},${hour}`] || []).forEach(a => {
            (byEmp[a.employee_id] = byEmp[a.employee_id] || []).push({ hour, roleId: a.role_id });
        });
    });
    const segments = [];
    Object.entries(byEmp).forEach(([empId, entries]) => {
        const emp = employeeMap[empId];
        if (!emp) return;
        entries.sort((a, b) => a.hour - b.hour);
        let cur = null;
        entries.forEach(({ hour, roleId }) => {
            if (cur && hour === cur.endHour && roleId === cur.roleId) {
                cur.endHour = hour + 1;
                return;
            }
            cur = { empId, emp, roleId, startHour: hour, endHour: hour + 1, day: state.days[dayIdx], dayIdx };
            segments.push(cur);
        });
    });
    return segments;
}

/** Open (unfilled) hours for one day, merged into ranges per role. */
function buildTimelineGapsForDay(schedule, dayIdx) {
    const unfilled = (schedule?.metrics?.unfilled_slots || []).filter(s => parseInt(s.day) === parseInt(dayIdx));
    const byRole = {};
    unfilled.forEach(s => {
        const role = s.role_id || '';
        const hour = parseInt(s.hour);
        byRole[role] = byRole[role] || {};
        byRole[role][hour] = (byRole[role][hour] || 0) + (s.needed || 1);
    });
    const gaps = [];
    Object.entries(byRole).forEach(([roleId, hours]) => {
        const sorted = Object.keys(hours).map(Number).sort((a, b) => a - b);
        let cur = null;
        sorted.forEach(h => {
            if (cur && h === cur.endHour) {
                cur.endHour = h + 1;
                cur.needed = Math.max(cur.needed, hours[h]);
                return;
            }
            cur = { isGap: true, day: dayIdx, dayIdx: state.daysOpen.indexOf(dayIdx), roleId, startHour: h, endHour: h + 1, needed: hours[h] };
            gaps.push(cur);
        });
    });
    return gaps;
}

// Remembers which lane a shift was drawn on, so a dragged shift lands on the
// lane you dropped it on and everything else stays where it was.
const timelineLaneMemory = {};
const laneKey = (dayIdx, roleId, empId) => `${dayIdx}|${roleId}|${empId}`;

/** Lane packing: keep each bar on its remembered lane when possible, otherwise the first free one. */
function packIntoLanes(items, dayIdx, roleId) {
    const lanes = [];
    const fits = (lane, item) => !lane.some(s => item.startHour < s.endHour && item.endHour > s.startHour);
    items.sort((a, b) => a.startHour - b.startHour || a.endHour - b.endHour);
    items.forEach(item => {
        const key = laneKey(dayIdx, roleId, item.empId);
        let idx = timelineLaneMemory[key];
        if (idx !== undefined && idx < 6) {
            while (lanes.length <= idx) lanes.push([]);
            if (!fits(lanes[idx], item)) idx = undefined;
        } else {
            idx = undefined;
        }
        if (idx === undefined) {
            idx = lanes.findIndex(l => fits(l, item));
            if (idx === -1) {
                lanes.push([]);
                idx = lanes.length - 1;
            }
        }
        lanes[idx].push(item);
        timelineLaneMemory[key] = idx;
    });
    // Drop trailing empty lanes (a remembered lane that is no longer used)
    while (lanes.length > 1 && lanes[lanes.length - 1].length === 0) lanes.pop();
    return lanes;
}

/** Hours (as a Set) this employee is available on a given day. */
function employeeAvailableHours(emp, dayIdx) {
    const set = new Set();
    (emp?.availability || []).forEach(s => { if (parseInt(s.day) === dayIdx) set.add(parseInt(s.hour)); });
    return set;
}

/** True when the employee has approved time off on the given day of the current week. */
function employeeHasTimeOff(empId, dayIdx) {
    const dayDate = getWeekDates(state.weekOffset)[dayIdx];
    return (state.approvedPTO || []).some(pto => {
        if (pto.employee_id !== empId) return false;
        const start = new Date(pto.start_date + 'T00:00:00');
        const end = new Date(pto.end_date + 'T00:00:00');
        return dayDate >= start && dayDate <= end;
    });
}

/**
 * While a bar is being dragged, shade the hours the person is not available
 * and dim the rows of roles they do not hold, so the valid drop targets are obvious.
 */
function showAvailabilityOverlays(emp) {
    const totalHours = state.hours.length;
    document.querySelectorAll('.timeline-role-lanes').forEach(lanes => {
        const dayIdx = parseInt(lanes.dataset.dayIdx);
        const roleId = lanes.dataset.roleId;
        if (roleId !== '__other' && !(emp.roles || []).includes(roleId)) {
            lanes.classList.add('lane-locked');
            lanes.title = `${emp.name} is not set up as a ${roleMap[roleId]?.name || 'that role'}`;
        }
        const avail = employeeAvailableHours(emp, dayIdx);
        const dayOff = employeeHasTimeOff(emp.id, dayIdx);
        const overlay = document.createElement('div');
        overlay.className = 'timeline-unavail-overlay';
        let segStart = null;
        const flush = (endHour) => {
            if (segStart === null) return;
            const seg = document.createElement('div');
            seg.className = 'timeline-unavail-seg';
            seg.style.left = `${(state.hours.indexOf(segStart) / totalHours) * 100}%`;
            seg.style.width = `${((endHour - segStart) / totalHours) * 100}%`;
            seg.title = dayOff ? `${emp.name} has approved time off` : `${emp.name} is not available ${formatHour(segStart)}-${formatHour(endHour)}`;
            overlay.appendChild(seg);
            segStart = null;
        };
        state.hours.forEach(h => {
            const blocked = dayOff || !avail.has(h);
            if (blocked && segStart === null) segStart = h;
            if (!blocked) flush(h);
        });
        flush(state.endHour);
        if (overlay.children.length) lanes.appendChild(overlay);
    });
}

function hideAvailabilityOverlays() {
    document.querySelectorAll('.timeline-unavail-overlay').forEach(o => o.remove());
    document.querySelectorAll('.timeline-role-lanes.lane-locked').forEach(l => {
        l.classList.remove('lane-locked');
        l.removeAttribute('title');
    });
}

/**
 * Check a proposed shift move against the business rules. Returns a list of
 * {level: 'warn'|'info', text} items; an empty list means the move is clean.
 */
function evaluateShiftChange(p) {
    const emp = employeeMap[p.empId];
    const issues = [];
    if (!emp || !state.currentSchedule) return issues;
    const warn = (text) => issues.push({ level: 'warn', text });
    const info = (text) => issues.push({ level: 'info', text });
    const dayName = state.days[p.toDay];
    const range = `${formatHour(p.toStart)}-${formatHour(p.toEnd)}`;
    const policies = getAllPolicies();
    const slots = state.currentSchedule.slot_assignments || {};
    const newHours = [];
    for (let h = p.toStart; h < p.toEnd; h++) newHours.push(h);

    // The person's own hours after the move (old shift removed, new one added)
    const hoursByDay = {};
    Object.entries(slots).forEach(([key, list]) => {
        const [d, h] = key.split(',').map(Number);
        (list || []).forEach(a => {
            if (a.employee_id !== p.empId) return;
            if (d === p.fromDay && h >= p.fromStart && h < p.fromEnd) return; // being moved
            (hoursByDay[d] = hoursByDay[d] || new Set()).add(h);
        });
    });

    // Role
    if (p.toRole !== '__other' && !(emp.roles || []).includes(p.toRole)) {
        warn(`${emp.name} is not set up as a ${roleMap[p.toRole]?.name || 'that role'}. You can add the role on the Staff Availability page.`);
    }

    // Time off / availability
    if (employeeHasTimeOff(p.empId, p.toDay)) {
        warn(`${emp.name} has approved time off on ${dayName}.`);
    } else {
        const avail = employeeAvailableHours(emp, p.toDay);
        const missing = newHours.filter(h => !avail.has(h));
        if (missing.length) {
            const ranges = slotsToRangesByDay(missing.map(h => ({ day: p.toDay, hour: h })))[p.toDay] || [];
            warn(`${emp.name} is not marked available on ${dayName} ${formatRangeList(ranges)}.`);
        }
    }

    // Overlap with their other shifts that day
    const sameDay = hoursByDay[p.toDay] || new Set();
    const overlap = newHours.filter(h => sameDay.has(h));
    if (overlap.length) {
        const ranges = slotsToRangesByDay(overlap.map(h => ({ day: p.toDay, hour: h })))[p.toDay] || [];
        warn(`${emp.name} is already working ${dayName} ${formatRangeList(ranges)}; those hours would overlap.`);
    }

    // Daily and weekly hours
    const dayTotal = new Set([...sameDay, ...newHours]).size;
    if (dayTotal > policies.max_hours_per_day) {
        warn(`This makes a ${dayTotal}-hour day for ${emp.name}; your limit is ${policies.max_hours_per_day} hours per day.`);
    }
    let weekTotal = dayTotal;
    Object.entries(hoursByDay).forEach(([d, set]) => { if (Number(d) !== p.toDay) weekTotal += set.size; });
    const cap = emp.overtime_allowed ? emp.max_hours : Math.min(40, emp.max_hours || 40);
    if (weekTotal > cap) {
        warn(`${emp.name} would be at ${weekTotal} hours this week; their maximum is ${cap}${emp.overtime_allowed ? '' : ' (overtime not allowed)'}.`);
    } else if (weekTotal > 40 && emp.overtime_allowed) {
        info(`${emp.name} would be at ${weekTotal} hours, which includes ${weekTotal - 40}h of overtime (allowed for them).`);
    }

    // Days per week
    const daysWorked = new Set(Object.keys(hoursByDay).map(Number));
    if (!daysWorked.has(p.toDay)) {
        const isFT = emp.classification === 'full_time';
        const maxDays = isFT ? policies.max_days_ft : policies.max_days_pt;
        const mode = isFT ? policies.max_days_ft_mode : policies.max_days_pt_mode;
        if (mode !== 'off' && daysWorked.size + 1 > maxDays) {
            const text = `This would be ${emp.name}'s ${daysWorked.size + 1}th day this week; the ${isFT ? 'full-time' : 'part-time'} limit is ${maxDays} days${mode === 'preferred' ? ' (preferred, not required)' : ''}.`;
            (mode === 'required' ? warn : info)(text.replace('1th', '1st').replace('2th', '2nd').replace('3th', '3rd'));
        }
        if (daysWorked.size + 1 >= 7) warn(`${emp.name} would have no day off this week.`);
    }

    // Rest between shifts (clopening)
    const minRest = policies.min_rest_hours ?? 10;
    const prev = hoursByDay[p.toDay - 1];
    if (prev && prev.size) {
        const prevEnd = Math.max(...prev) + 1;
        const rest = (24 - prevEnd) + p.toStart;
        if (rest < minRest) warn(`Only ${rest} hours of rest after ${emp.name}'s ${state.days[p.toDay - 1]} shift (ends ${formatHour(prevEnd)}); you ask for ${minRest}.`);
    }
    const next = hoursByDay[p.toDay + 1];
    if (next && next.size) {
        const nextStart = Math.min(...next);
        const rest = (24 - p.toEnd) + nextStart;
        if (rest < minRest) warn(`Only ${rest} hours of rest before ${emp.name}'s ${state.days[p.toDay + 1]} shift (starts ${formatHour(nextStart)}); you ask for ${minRest}.`);
    }

    // Supervision
    if (emp.needs_supervision && policies.supervision_required !== false) {
        const uncovered = newHours.filter(h => !(slots[`${p.toDay},${h}`] || []).some(a => a.employee_id !== p.empId && employeeMap[a.employee_id]?.can_supervise));
        if (uncovered.length) {
            const ranges = slotsToRangesByDay(uncovered.map(h => ({ day: p.toDay, hour: h })))[p.toDay] || [];
            warn(`${emp.name} needs a supervisor on shift, and nobody who can supervise is scheduled ${dayName} ${formatRangeList(ranges)}.`);
        }
    }

    // Coverage: overstaffing at the target, and the gap left behind
    const req = getWeekCoverageRequirements();
    const over = newHours.filter(h => {
        const r = req[`${p.toDay},${h},${p.toRole}`];
        const have = (slots[`${p.toDay},${h}`] || []).filter(a => a.role_id === p.toRole && !(a.employee_id === p.empId && p.fromDay === p.toDay && h >= p.fromStart && h < p.fromEnd)).length;
        return !r ? true : have >= r.max;
    });
    if (over.length) {
        const ranges = slotsToRangesByDay(over.map(h => ({ day: p.toDay, hour: h })))[p.toDay] || [];
        info(`No extra ${roleMap[p.toRole]?.name || 'staff'} is needed ${dayName} ${formatRangeList(ranges)}, so this adds hours beyond what coverage calls for.`);
    }
    const opened = [];
    for (let h = p.fromStart; h < p.fromEnd; h++) {
        if (p.fromDay === p.toDay && h >= p.toStart && h < p.toEnd && p.fromRole === p.toRole) continue;
        const r = req[`${p.fromDay},${h},${p.fromRole}`];
        if (!r || r.min <= 0) continue;
        const have = (slots[`${p.fromDay},${h}`] || []).filter(a => a.role_id === p.fromRole && a.employee_id !== p.empId).length;
        if (have < r.min) opened.push(h);
    }
    if (opened.length) {
        const ranges = slotsToRangesByDay(opened.map(h => ({ day: p.fromDay, hour: h })))[p.fromDay] || [];
        info(`Leaving ${state.days[p.fromDay]} ${formatRangeList(ranges)} opens a ${roleMap[p.fromRole]?.name || 'staff'} gap you will need to fill.`);
    }
    return issues;
}

/**
 * Show the confirmation popup for a proposed move. Green when the move
 * follows every rule, amber (with the reasons) when it does not. Calls
 * onConfirm() if the manager goes ahead.
 */
function confirmShiftChange(p, onConfirm) {
    const emp = employeeMap[p.empId];
    const issues = evaluateShiftChange(p);
    const warnings = issues.filter(i => i.level === 'warn');
    const notes = issues.filter(i => i.level === 'info');
    const clean = warnings.length === 0;

    // Managers can opt out of the popup for changes that break no rules
    let skipClean = false;
    try { skipClean = localStorage.getItem('skipCleanShiftConfirm') === '1'; } catch (err) { /* ignore */ }
    if (clean && notes.length === 0 && skipClean) {
        onConfirm();
        return;
    }

    let modal = document.getElementById('shiftChangeModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'shiftChangeModal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-backdrop"></div>
            <div class="modal-content modal-sm shift-change-content">
                <div class="modal-header shift-change-header">
                    <h2 id="shiftChangeTitle">Confirm change</h2>
                    <button class="modal-close" data-close>&times;</button>
                </div>
                <div class="modal-body">
                    <p class="shift-change-summary" id="shiftChangeSummary"></p>
                    <ul class="shift-change-issues" id="shiftChangeIssues"></ul>
                    <label class="shift-change-skip" id="shiftChangeSkipWrap">
                        <input type="checkbox" id="shiftChangeSkip"> Don't ask again for changes that follow all the rules
                    </label>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-ghost" data-close>Cancel</button>
                    <button type="button" class="btn" id="shiftChangeConfirmBtn">Confirm</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => modal.classList.remove('active')));
    }

    const roleName = roleMap[p.toRole]?.name || 'that role';
    const roleChanged = p.toRole !== p.fromRole;
    const summary = `Move ${emp?.name || 'this shift'} to ${state.days[p.toDay]} ${formatHour(p.toStart)}-${formatHour(p.toEnd)}${roleChanged ? ` as ${roleName}` : ''}?`;
    modal.classList.toggle('is-clean', clean);
    modal.classList.toggle('is-warning', !clean);
    document.getElementById('shiftChangeTitle').textContent = clean ? 'This change follows all your rules' : 'Are you sure? This change breaks a rule';
    document.getElementById('shiftChangeSummary').textContent = summary;
    const list = document.getElementById('shiftChangeIssues');
    list.innerHTML = issues.map(i => `<li class="issue-${i.level}"><span class="issue-icon">${i.level === 'warn' ? '!' : 'i'}</span><span>${escHtml(i.text)}</span></li>`).join('');
    list.hidden = issues.length === 0;
    const skipWrap = document.getElementById('shiftChangeSkipWrap');
    skipWrap.style.display = clean ? 'flex' : 'none';
    const skipBox = document.getElementById('shiftChangeSkip');
    skipBox.checked = false;

    const btn = document.getElementById('shiftChangeConfirmBtn');
    btn.className = clean ? 'btn btn-confirm-clean' : 'btn btn-confirm-warning';
    btn.textContent = clean ? 'Yes, make the change' : 'Move it anyway';
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener('click', () => {
        if (clean && skipBox.checked) {
            try { localStorage.setItem('skipCleanShiftConfirm', '1'); } catch (err) { /* ignore */ }
        }
        modal.classList.remove('active');
        onConfirm();
    });
    modal.classList.add('active');
}

/** One draggable, resizable shift bar labelled "Name - Role". */
function buildTimelineShiftBlock(shift, schedule, weeklyStats, totalHours, role) {
    const dayIdx = shift.dayIdx;
    const preciseTimes = schedule?.shift_times?.[`${shift.empId}_${dayIdx}`];
    const displayStart = preciseTimes ? preciseTimes.start : shift.startHour;
    const displayEnd = preciseTimes ? preciseTimes.end : shift.endHour;
    const duration = displayEnd - displayStart;

    const block = document.createElement('div');
    block.className = 'timeline-shift-block';
    block.draggable = true;
    block.dataset.empId = shift.empId;
    block.dataset.roleId = shift.roleId;
    block.dataset.dayIdx = dayIdx;
    block.dataset.startHour = displayStart;
    block.dataset.endHour = displayEnd;
    block.style.left = `${((displayStart - state.startHour) / totalHours) * 100}%`;
    block.style.width = `${(duration / totalHours) * 100}%`;

    const roleName = role?.name || roleMap[shift.roleId]?.name || 'Staff';
    const blockColor = state.scheduleColorMode === 'employee'
        ? (shift.emp.color || '#666')
        : (role?.color || roleMap[shift.roleId]?.color || '#666');
    block.style.background = blockColor;

    const stats = weeklyStats[shift.empId] || { hours: 0, days: new Set() };
    const empType = shift.emp.classification === 'full_time' ? 'Full-time' : 'Part-time';
    const timeDisplay = preciseTimes
        ? `${formatHourMinute(displayStart)} - ${formatHourMinute(displayEnd)}`
        : `${formatHour(shift.startHour)} - ${formatHour(shift.endHour)}`;

    block.innerHTML = `
        <div class="shift-resize-handle left" data-edge="left"></div>
        <span class="shift-name"><span class="shift-person">${escHtml(shift.emp.name)}</span><span class="shift-role"> - ${escHtml(roleName)}</span></span>
        <div class="shift-resize-handle right" data-edge="right"></div>
    `;
    block.title = `${shift.emp.name} - ${roleName} (${empType})\n${timeDisplay}\n\nThis week: ${stats.hours}h of ${shift.emp.min_hours || 0}-${shift.emp.max_hours || 40}h, ${stats.days.size} day${stats.days.size === 1 ? '' : 's'}\n\nDrag to move (within this row or to another day/role) · Drag the edges to resize · Click to edit`;

    block._shiftData = { ...shift, startHour: displayStart, endHour: displayEnd };

    block.addEventListener('click', (e) => {
        if (e.target.classList.contains('shift-resize-handle') || timelineDragState.isDragging || timelineDragState.isResizing) return;
        openShiftEditor(shift);
    });

    block.addEventListener('dragstart', (e) => {
        if (e.target.classList.contains('shift-resize-handle')) {
            e.preventDefault();
            return;
        }
        timelineDragState.isDragging = true;
        timelineDragState.activeShift = block._shiftData;
        timelineDragState.originalDayIdx = dayIdx;
        timelineDragState.originalStartHour = shift.startHour;
        timelineDragState.originalEndHour = shift.endHour;
        timelineDragState.originalRoleId = shift.roleId;
        // Where on the bar the user grabbed it (in hours), so the preview
        // follows the cursor instead of jumping to be centred on it
        const rect = block.getBoundingClientRect();
        const frac = rect.width ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) : 0;
        timelineDragState.grabOffsetHours = frac * (shift.endHour - shift.startHour);
        block.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', JSON.stringify(block._shiftData));
        // Use a transparent drag image: the ghost preview shows where it will land
        const img = document.createElement('canvas');
        img.width = img.height = 1;
        e.dataTransfer.setDragImage(img, 0, 0);
        document.querySelectorAll('.timeline-role-lanes').forEach(l => l.classList.add('drop-ready'));
        showAvailabilityOverlays(shift.emp);
    });

    block.addEventListener('dragend', () => {
        block.classList.remove('dragging');
        timelineDragState.isDragging = false;
        timelineDragState.activeShift = null;
        hideTimelineDropZones();
        hideAvailabilityOverlays();
    });

    block.querySelector('.shift-resize-handle.left').addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        startResize(e, block, 'left', dayIdx, shift);
    });
    block.querySelector('.shift-resize-handle.right').addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        startResize(e, block, 'right', dayIdx, shift);
    });
    return block;
}

/**
 * Every role's lane group is a drop target, so a shift can be dropped right
 * where it is (same row), on another day, or onto another role the person
 * holds. The ghost preview follows the mouse inside the target row.
 */
function attachTimelineDropHandlers(lanes, dayIdx, roleId) {
    // Start hour for the dragged bar: the cursor's hour minus where it was grabbed
    const targetStartFor = (e) => {
        const shift = timelineDragState.activeShift;
        const duration = shift.endHour - shift.startHour;
        const rect = lanes.getBoundingClientRect();
        const hourFloat = state.startHour + ((e.clientX - rect.left) / rect.width) * state.hours.length;
        const start = Math.round(hourFloat - (timelineDragState.grabOffsetHours || 0));
        return Math.max(state.startHour, Math.min(start, state.endHour - duration));
    };

    // The lane (row) under the cursor, ignoring the open-shift lane
    const laneUnderCursor = (e) => {
        const rows = [...lanes.querySelectorAll('.timeline-slots-row:not(.timeline-gap-row)')];
        return rows.find(r => {
            const rr = r.getBoundingClientRect();
            return e.clientY >= rr.top && e.clientY <= rr.bottom;
        }) || rows[rows.length - 1] || null;
    };

    const drawGhost = (e, start) => {
        const shift = timelineDragState.activeShift;
        const duration = shift.endHour - shift.startHour;
        document.querySelectorAll('.timeline-ghost-preview').forEach(g => g.remove());
        const lane = laneUnderCursor(e);
        const ghost = document.createElement('div');
        ghost.className = 'timeline-ghost-preview';
        ghost.style.left = `${((start - state.startHour) / state.hours.length) * 100}%`;
        ghost.style.width = `${(duration / state.hours.length) * 100}%`;
        ghost.style.top = `${lane ? lane.offsetTop + 3 : 3}px`;
        ghost.style.height = `${lane ? lane.offsetHeight - 6 : 26}px`;
        const emp = employeeMap[shift.empId];
        ghost.style.background = roleMap[roleId]?.color || emp?.color || '#6366f1';
        ghost.innerHTML = `<span class="shift-name">${escHtml(emp?.name || 'Staff')}</span><span class="ghost-time">${formatHour(start)}-${formatHour(start + duration)}</span>`;
        lanes.appendChild(ghost);
        timelineDragState.targetLaneIndex = lane ? parseInt(lane.dataset.laneIndex || '0') : 0;
    };

    lanes.addEventListener('dragover', (e) => {
        if (!timelineDragState.activeShift) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        lanes.classList.add('drag-over');
        const start = targetStartFor(e);
        timelineDragState.currentTargetDay = dayIdx;
        timelineDragState.currentTargetHour = start;
        drawGhost(e, start);
    });

    lanes.addEventListener('dragleave', (e) => {
        if (!lanes.contains(e.relatedTarget)) {
            lanes.classList.remove('drag-over');
            lanes.querySelectorAll('.timeline-ghost-preview').forEach(g => g.remove());
        }
    });

    lanes.addEventListener('drop', (e) => {
        e.preventDefault();
        lanes.classList.remove('drag-over');
        const shift = timelineDragState.activeShift;
        if (!shift) return;

        const start = targetStartFor(e);
        const duration = shift.endHour - shift.startHour;
        const targetRole = roleId === '__other' ? shift.roleId : roleId;
        const targetLane = timelineDragState.targetLaneIndex || 0;
        const proposal = {
            empId: shift.empId,
            fromDay: timelineDragState.originalDayIdx,
            fromStart: timelineDragState.originalStartHour,
            fromEnd: timelineDragState.originalEndHour,
            fromRole: timelineDragState.originalRoleId || shift.roleId,
            toDay: dayIdx, toStart: start, toEnd: start + duration, toRole: targetRole,
        };
        timelineDragState.isDragging = false;
        timelineDragState.activeShift = null;
        hideTimelineDropZones();
        hideAvailabilityOverlays();

        const unchanged = proposal.toDay === proposal.fromDay && proposal.toStart === proposal.fromStart && proposal.toRole === proposal.fromRole;
        if (unchanged) return;

        confirmShiftChange(proposal, () => {
            // Land on the lane it was dropped on
            timelineLaneMemory[laneKey(dayIdx, targetRole, shift.empId)] = targetLane;
            moveShift(shift.empId, proposal.fromRole, proposal.fromDay, proposal.fromStart, proposal.fromEnd,
                dayIdx, start, targetRole);
        });
    });
}

function buildTimelinePtoRow(dayPTO) {
    const roleRow = document.createElement('div');
    roleRow.className = 'timeline-role-row timeline-pto-role-row';
    const label = document.createElement('div');
    label.className = 'timeline-role-label';
    label.innerHTML = `<span class="role-dot" style="background:#8b5cf6"></span><span class="role-label-text">Time off</span>`;
    const lanes = document.createElement('div');
    lanes.className = 'timeline-role-lanes';
    lanes.style.setProperty('--hours', state.hours.length);
    roleRow.style.setProperty('--role-color', '#8b5cf6');
    const lane = document.createElement('div');
    lane.className = 'timeline-slots-row timeline-pto-row';
    dayPTO.forEach(pto => {
        const ptoBlock = document.createElement('div');
        ptoBlock.className = 'timeline-pto-block';
        ptoBlock.style.left = '0';
        ptoBlock.style.width = '100%';
        const empName = pto.employee_name || 'Employee';
        ptoBlock.innerHTML = `<span class="pto-icon">${getPTOTypeEmoji(pto.pto_type)}</span><span class="pto-label">${escHtml(empName)} - ${escHtml(capitalizeFirst(pto.pto_type))}</span>`;
        ptoBlock.title = `${empName}: ${capitalizeFirst(pto.pto_type)} (${pto.start_date} - ${pto.end_date})`;
        lane.appendChild(ptoBlock);
    });
    lanes.appendChild(lane);
    roleRow.append(label, lanes);
    return roleRow;
}

function renderTimelineView(schedule) {
    const container = document.getElementById('timelineGrid');
    if (!container) return;
    container.innerHTML = '';

    if (!state.hours?.length || !state.daysOpen?.length) {
        container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 2rem;">Loading schedule data...</div>`;
        return;
    }

    const slotAssignments = schedule?.slot_assignments || {};
    const totalHours = state.hours.length;
    const hasSchedule = Object.values(slotAssignments).some(arr => arr && arr.length > 0);

    // Weekly hours/days per person (for tooltips)
    const weeklyStats = {};
    Object.entries(slotAssignments).forEach(([key, list]) => {
        const day = parseInt(key.split(',')[0]);
        (list || []).forEach(a => {
            const s = weeklyStats[a.employee_id] = weeklyStats[a.employee_id] || { hours: 0, days: new Set() };
            s.hours += 1;
            s.days.add(day);
        });
    });

    const weekDates = getWeekDates(state.weekOffset);
    const rolesSorted = [...state.roles].sort((a, b) => a.name.localeCompare(b.name));
    const knownRoles = new Set(state.roles.map(r => r.id));

    // Header: Day | Role | hour columns
    const headerDiv = document.createElement('div');
    headerDiv.className = 'timeline-header';
    const dayHead = document.createElement('div');
    dayHead.className = 'timeline-header-day';
    dayHead.textContent = 'Day';
    const roleHead = document.createElement('div');
    roleHead.className = 'timeline-header-role';
    roleHead.textContent = 'Role';
    const hoursHead = document.createElement('div');
    hoursHead.className = 'timeline-header-hours';
    hoursHead.style.setProperty('--hours', totalHours);
    state.hours.forEach(hour => {
        const label = document.createElement('div');
        label.className = 'timeline-hour-label';
        label.textContent = formatHour(hour);
        hoursHead.appendChild(label);
    });
    const closingLabel = document.createElement('div');
    closingLabel.className = 'timeline-hour-label timeline-closing-hour';
    closingLabel.textContent = formatHour(state.endHour);
    hoursHead.appendChild(closingLabel);
    headerDiv.append(dayHead, roleHead, hoursHead);
    container.appendChild(headerDiv);

    state.daysOpen.forEach(dayIdx => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'timeline-row ' + (dayIdx % 2 === 0 ? 'day-even' : 'day-odd');
        rowDiv.dataset.dayIdx = dayIdx;

        const dayDate = weekDates[dayIdx];
        const dayLabel = document.createElement('div');
        dayLabel.className = 'timeline-day-label';
        dayLabel.innerHTML = `<span class="day-name">${state.days[dayIdx].substring(0, 3)}</span><span class="day-date">${formatShortDate(dayDate)}</span>`;
        rowDiv.appendChild(dayLabel);

        const slotsDiv = document.createElement('div');
        slotsDiv.className = 'timeline-slots';
        slotsDiv.dataset.dayIdx = dayIdx;

        // Approved time off shows first
        const dayPTO = (state.approvedPTO || []).filter(pto => {
            const ptoStart = new Date(pto.start_date + 'T00:00:00');
            const ptoEnd = new Date(pto.end_date + 'T00:00:00');
            return dayDate >= ptoStart && dayDate <= ptoEnd;
        });
        if (dayPTO.length > 0) slotsDiv.appendChild(buildTimelinePtoRow(dayPTO));

        // Shifts and open hours for the day, grouped by role
        const segments = buildTimelineSegmentsForDay(slotAssignments, dayIdx);
        const gaps = hasSchedule ? buildTimelineGapsForDay(schedule, dayIdx) : [];
        const segByRole = {};
        const gapByRole = {};
        segments.forEach(s => {
            const k = knownRoles.has(s.roleId) ? s.roleId : '__other';
            (segByRole[k] = segByRole[k] || []).push(s);
        });
        gaps.forEach(g => {
            const k = knownRoles.has(g.roleId) ? g.roleId : '__other';
            (gapByRole[k] = gapByRole[k] || []).push(g);
        });

        const roleRows = rolesSorted.map(r => ({ id: r.id, name: r.name, color: r.color }));
        if (segByRole.__other || gapByRole.__other) roleRows.push({ id: '__other', name: 'Other', color: '#64748b' });

        roleRows.forEach(role => {
            const roleRow = document.createElement('div');
            roleRow.className = 'timeline-role-row';
            roleRow.dataset.dayIdx = dayIdx;
            roleRow.dataset.roleId = role.id;
            roleRow.style.setProperty('--role-color', role.color || '#64748b');

            const shiftsHere = segByRole[role.id] || [];
            const gapsHere = gapByRole[role.id] || [];
            const label = document.createElement('div');
            label.className = 'timeline-role-label';
            label.innerHTML = `<span class="role-dot" style="background:${escHtml(role.color)}"></span><span class="role-label-text">${escHtml(role.name)}</span>`;
            label.title = `${role.name} on ${state.days[dayIdx]}: ${shiftsHere.length} shift${shiftsHere.length === 1 ? '' : 's'}${gapsHere.length ? `, ${gapsHere.length} still open` : ''}`;

            const lanes = document.createElement('div');
            lanes.className = 'timeline-role-lanes';
            lanes.dataset.dayIdx = dayIdx;
            lanes.dataset.roleId = role.id;
            lanes.style.setProperty('--hours', totalHours); // drives the hour grid lines

            // Open hours for this role sit in their own lane at the top of the row
            if (gapsHere.length) {
                const gapLane = document.createElement('div');
                gapLane.className = 'timeline-slots-row timeline-gap-row';
                gapsHere.forEach(gap => {
                    const gapBlock = document.createElement('div');
                    gapBlock.className = 'timeline-gap-block';
                    gapBlock.style.left = `${(state.hours.indexOf(gap.startHour) / totalHours) * 100}%`;
                    gapBlock.style.width = `${((gap.endHour - gap.startHour) / totalHours) * 100}%`;
                    gapBlock.innerHTML = `<span class="gap-label">+${gap.needed} ${escHtml(role.name)}</span>`;
                    gapBlock.title = `Still need ${gap.needed} ${role.name} ${formatHour(gap.startHour)} - ${formatHour(gap.endHour)}\nClick to see who is available`;
                    gapBlock.addEventListener('click', (e) => {
                        e.stopPropagation();
                        openGapModal(gap);
                    });
                    gapLane.appendChild(gapBlock);
                });
                lanes.appendChild(gapLane);
            }

            const packed = packIntoLanes(shiftsHere, dayIdx, role.id);
            if (packed.length === 0) packed.push([]);
            packed.forEach((laneShifts, laneIndex) => {
                const lane = document.createElement('div');
                lane.className = 'timeline-slots-row' + (laneShifts.length ? '' : ' timeline-empty-row');
                lane.dataset.dayIdx = dayIdx;
                lane.dataset.roleId = role.id;
                lane.dataset.laneIndex = laneIndex;
                lane.title = laneShifts.length ? '' : 'Click or drag here to add a shift';
                const preselect = role.id === '__other' ? null : role.id;
                lane.addEventListener('click', (e) => {
                    timelineCreateState.preselectRoleId = preselect;
                    handleTimelineRowClick(e, dayIdx, lanes);
                });
                lane.addEventListener('mousedown', (e) => {
                    timelineCreateState.preselectRoleId = preselect;
                    handleTimelineRowMouseDown(e, dayIdx, lanes);
                });
                laneShifts.forEach(shift => lane.appendChild(buildTimelineShiftBlock(shift, schedule, weeklyStats, totalHours, role)));
                lanes.appendChild(lane);
            });

            attachTimelineDropHandlers(lanes, dayIdx, role.id);
            roleRow.append(label, lanes);
            slotsDiv.appendChild(roleRow);
        });

        rowDiv.appendChild(slotsDiv);
        container.appendChild(rowDiv);
    });

    renderScheduleLegend();
}

// ==================== COVERAGE RECOMPUTE (after manual edits) ====================

/**
 * Coverage requirements for this business as a map "day,hour,role" -> {min, max, is_peak}.
 * Uses the shift templates in shifts mode, otherwise the stored requirements.
 */
function getWeekCoverageRequirements() {
    const req = {};
    const add = (d, h, r, min, max, peak) => {
        const key = `${d},${h},${r}`;
        const cur = req[key] || { min: 0, max: 0, is_peak: false };
        cur.min += min;
        cur.max += max;
        cur.is_peak = cur.is_peak || !!peak;
        req[key] = cur;
    };
    const templates = state.shiftTemplates || [];
    if (state.coverageMode !== 'detailed' && templates.length) {
        templates.forEach(t => (t.days || []).forEach(d => {
            if (!state.daysOpen.includes(d)) return;
            for (let h = t.start_hour; h < t.end_hour; h++) {
                if (!state.hours.includes(h)) continue;
                (t.roles || []).forEach(rr => add(d, h, rr.role_id, rr.count || 0, rr.max_count || rr.count || 0, false));
            }
        }));
    } else {
        (state.business?.coverage_requirements || []).forEach(c => {
            if (state.daysOpen.includes(c.day) && state.hours.includes(c.hour)) {
                add(c.day, c.hour, c.role_id, c.min_staff || 0, c.max_staff || 0, c.is_peak);
            }
        });
    }
    return req;
}

/** Merge hour-by-hour open slots into shift-sized ranges (same grouping the server uses). */
function groupUnfilledRanges(unfilled) {
    const byKey = {};
    (unfilled || []).forEach(s => {
        const key = `${s.day}|${s.role_id}|${s.reason || ''}`;
        (byKey[key] = byKey[key] || []).push(s);
    });
    const ranges = [];
    Object.values(byKey).forEach(slots => {
        slots.sort((a, b) => a.hour - b.hour);
        let cur = null;
        slots.forEach(s => {
            if (cur && parseInt(s.hour) === cur.end_hour) {
                cur.end_hour = parseInt(s.hour) + 1;
                cur.needed = Math.max(cur.needed, s.needed || 1);
                return;
            }
            cur = {
                day: parseInt(s.day), role_id: s.role_id, role_name: s.role_name || roleMap[s.role_id]?.name || s.role_id,
                start_hour: parseInt(s.hour), end_hour: parseInt(s.hour) + 1, needed: s.needed || 1,
                is_peak: !!s.is_peak, reason: s.reason || '',
            };
            ranges.push(cur);
        });
    });
    ranges.sort((a, b) => a.day - b.day || a.start_hour - b.start_hour || a.role_name.localeCompare(b.role_name));
    return ranges;
}

/**
 * Recalculate open hours, coverage %, and per-person hours from the current
 * slot assignments. Called after every manual edit (drag, resize, add, delete)
 * so the "still needed" markers and the notes always match what is on screen.
 */
function recomputeCoverageGaps() {
    const sched = state.currentSchedule;
    if (!sched) return;
    const req = getWeekCoverageRequirements();
    const slots = sched.slot_assignments || {};

    const staffed = {};
    Object.entries(slots).forEach(([k, list]) => (list || []).forEach(a => {
        const key = `${k},${a.role_id}`;
        staffed[key] = (staffed[key] || 0) + 1;
    }));

    // Keep the solver's explanation for gaps it already reported
    const oldReasons = {};
    (sched.metrics?.unfilled_slots || []).forEach(s => { if (s.reason) oldReasons[`${s.day},${s.hour},${s.role_id}`] = s.reason; });

    const unfilled = [];
    const byRole = {}, byDay = {};
    let required = 0, filled = 0, stillNeeded = 0;
    Object.entries(req).forEach(([key, { min, is_peak }]) => {
        if (min <= 0) return;
        const [d, h, r] = key.split(',');
        const have = staffed[key] || 0;
        required += min;
        filled += Math.min(have, min);
        if (have < min) {
            const needed = min - have;
            unfilled.push({
                day: +d, hour: +h, role_id: r, role_name: roleMap[r]?.name || r, needed, filled: have,
                required: min, is_peak, reason: oldReasons[key] || 'Left open by a manual edit.',
            });
            byRole[r] = (byRole[r] || 0) + needed;
            byDay[d] = (byDay[d] || 0) + needed;
            stillNeeded += needed;
        }
    });
    unfilled.sort((a, b) => a.day - b.day || a.hour - b.hour);

    const m = sched.metrics = sched.metrics || {};
    m.unfilled_slots = unfilled;
    m.unfilled_ranges = groupUnfilledRanges(unfilled);
    m.unfilled_by_role = byRole;
    m.unfilled_by_day = byDay;
    m.total_hours_still_needed = stillNeeded;
    m.total_slots_required = required;
    m.total_slots_filled = filled;
    m.coverage_percentage = required ? Math.round((filled / required) * 1000) / 10 : 100;
    sched.coverage_percentage = m.coverage_percentage;
    sched.total_hours_needed = required;
    sched.total_hours_filled = filled;

    const hours = {};
    Object.values(slots).forEach(list => (list || []).forEach(a => { hours[a.employee_id] = (hours[a.employee_id] || 0) + 1; }));
    sched.employee_hours = hours;
    sched.employee_overtime = Object.fromEntries(Object.entries(hours).map(([e, h]) => [e, Math.max(0, h - 40)]));
    let cost = 0;
    Object.entries(hours).forEach(([e, h]) => {
        const rate = employeeMap[e]?.hourly_rate || 0;
        const ot = Math.max(0, h - 40);
        cost += (h - ot) * rate + ot * rate * 1.5;
    });
    m.estimated_labor_cost = Math.round(cost * 100) / 100;
    m.total_overtime_hours = Object.values(sched.employee_overtime).reduce((a, b) => a + b, 0);
}

/** Everything that should happen after a manual change to the schedule. */
function afterManualScheduleEdit(rerender = true) {
    if (!state.currentSchedule) return;
    recomputeCoverageGaps();
    saveScheduleToStorage();
    incrementWeekEditCount(state.weekOffset);
    try { updateMetrics(state.currentSchedule); } catch (err) { console.warn('metrics refresh failed', err); }
    try { updateEmployeeHours(state.currentSchedule); } catch (err) { /* panel may be collapsed */ }
    if (rerender) renderCurrentScheduleView(state.currentSchedule);
}

function updateMetrics(schedule) {
    const metrics = schedule.metrics;
    
    dom.coveragePercent.textContent = `${schedule.coverage_percentage}%`;
    dom.slotsFilled.textContent = `${metrics.total_slots_filled}/${metrics.total_slots_required}`;
    dom.solveTime.textContent = `${(schedule.solve_time_ms / 1000).toFixed(2)}s`;
    dom.laborCost.textContent = `$${metrics.estimated_labor_cost?.toLocaleString() || '—'}`;
    dom.overtimeHours.textContent = metrics.total_overtime_hours ?? '—';
    
    const needed = metrics.total_hours_still_needed || 0;
    dom.hoursStillNeeded.textContent = needed > 0 ? `${needed}h` : '0';
    
    // Update highlight states
    const highlightMetric = dom.hoursStillNeeded.closest('.metric');
    if (needed === 0) {
        highlightMetric.classList.add('covered');
    } else {
        highlightMetric.classList.remove('covered');
    }
    
    // Coverage gaps
    if (needed > 0) {
        dom.gapsCard.style.display = 'block';
        
        dom.roleGaps.innerHTML = '';
        const unfilledByRole = metrics.unfilled_by_role || {};
        for (const [roleId, count] of Object.entries(unfilledByRole)) {
            if (count > 0) {
                const role = roleMap[roleId] || { name: roleId };
                const item = document.createElement('div');
                item.className = 'gap-item';
                item.innerHTML = `
                    <span>${role.name}</span>
                    <span class="gap-count">${count}h</span>
                `;
                dom.roleGaps.appendChild(item);
            }
        }
        
        dom.dayGaps.innerHTML = '';
        const unfilledByDay = metrics.unfilled_by_day || {};
        for (const [day, count] of Object.entries(unfilledByDay)) {
            if (count > 0) {
                const item = document.createElement('div');
                item.className = 'gap-item';
                item.innerHTML = `
                    <span>${state.days[parseInt(day)].substring(0, 3)}</span>
                    <span class="gap-count">${count}h</span>
                `;
                dom.dayGaps.appendChild(item);
            }
        }
    } else {
        dom.gapsCard.style.display = 'none';
    }

    renderScheduleInsights(schedule);
}

/**
 * Plain-English notes from the solver: why hours stayed open, who is under
 * their minimum hours, clopenings it could not avoid, and what to change.
 */
function renderScheduleInsights(schedule) {
    const container = document.getElementById('scheduleInsights');
    if (!container) return;
    const metrics = schedule?.metrics || {};
    const suggestions = metrics.suggestions || [];
    const underMin = metrics.employees_under_min || [];
    const clopenings = metrics.clopenings || [];
    const unfilled = metrics.unfilled_slots || [];

    if (!suggestions.length && !underMin.length && !clopenings.length && !unfilled.length) {
        container.innerHTML = '';
        container.style.display = 'none';
        return;
    }

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const fmtHour = (h) => { h = ((h % 24) + 24) % 24; return h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`; };
    const dayName = (d) => (state.days[d] || '').substring(0, 3);

    let html = '<div class="insights-title">Scheduler notes</div>';

    if (unfilled.length) {
        // One line per open shift ("Tue 10am-2pm, Manager"), grouped by reason
        const ranges = metrics.unfilled_ranges?.length ? metrics.unfilled_ranges : groupUnfilledRanges(unfilled);
        const byReason = {};
        ranges.forEach(r => {
            const key = r.reason || 'Could not be filled.';
            if (!byReason[key]) byReason[key] = [];
            const who = r.needed > 1 ? `${r.needed} ${r.role_name || r.role_id}s` : (r.role_name || r.role_id);
            byReason[key].push(`${dayName(r.day)} ${fmtHour(r.start_hour)}-${fmtHour(r.end_hour)} · ${who}`);
        });
        html += '<div class="insight-group"><div class="insight-heading">Open shifts</div><ul>';
        Object.entries(byReason).slice(0, 5).forEach(([reason, shifts]) => {
            const shown = shifts.slice(0, 3).map(s => `<span class="insight-shift">${esc(s)}</span>`).join('')
                + (shifts.length > 3 ? `<span class="insight-more">+${shifts.length - 3} more</span>` : '');
            html += `<li><strong>${esc(reason)}</strong><span class="insight-slots">${shown}</span></li>`;
        });
        html += '</ul></div>';
    }
    if (suggestions.length) {
        html += '<div class="insight-group"><div class="insight-heading">Suggestions</div><ul>';
        suggestions.forEach(s => { html += `<li>${esc(s)}</li>`; });
        html += '</ul></div>';
    }
    if (underMin.length) {
        html += '<div class="insight-group"><div class="insight-heading">Under minimum hours</div><ul>';
        underMin.forEach(e => { html += `<li>${esc(e.employee_name)}: ${e.hours}h of ${e.min_hours}h minimum</li>`; });
        html += '</ul></div>';
    }
    if (clopenings.length) {
        html += '<div class="insight-group"><div class="insight-heading">Short rest between shifts</div><ul>';
        clopenings.forEach(c => {
            html += `<li>${esc(c.employee_name)} closes ${dayName(c.close_day)} ${fmtHour(c.close_hour)} and opens ${dayName(c.open_day)} ${fmtHour(c.open_hour)} (${c.rest_hours}h rest)</li>`;
        });
        html += '</ul></div>';
    }
    container.innerHTML = html;
    container.style.display = 'block';
}

function clearMetrics() {
    dom.coveragePercent.textContent = '—%';
    dom.slotsFilled.textContent = '—/—';
    dom.hoursStillNeeded.textContent = '—';
    dom.laborCost.textContent = '$—';
    dom.solveTime.textContent = '—s';
    dom.overtimeHours.textContent = '—';
    if (dom.gapsCard) dom.gapsCard.style.display = 'none';
    const insights = document.getElementById('scheduleInsights');
    if (insights) { insights.innerHTML = ''; insights.style.display = 'none'; }
    
    const highlightMetric = dom.hoursStillNeeded?.closest('.metric');
    if (highlightMetric) highlightMetric.classList.remove('covered');
}

function updateEmployeeHours(schedule) {
    const employeeHours = schedule.employee_hours;
    const consecutiveDays = schedule.consecutive_days;
    const employeeOvertime = schedule.employee_overtime || {};
    
    state.employees.forEach(emp => {
        const row = dom.employeeHoursList.querySelector(`[data-id="${emp.id}"]`);
        if (row) {
            const hours = employeeHours[emp.id] || 0;
            const ot = employeeOvertime[emp.id] || 0;
            
            const hoursEl = row.querySelector('.emp-hours');
            const statusEl = row.querySelector('.emp-status');
            
            hoursEl.textContent = `${hours}h${ot > 0 ? '+' + ot : ''}`;
            
            const hoursValid = hours >= emp.min_hours && hours <= emp.max_hours;
            
            if (hoursValid) {
                statusEl.textContent = '✓';
                statusEl.className = 'emp-status valid';
            } else {
                statusEl.textContent = '!';
                statusEl.className = 'emp-status invalid';
            }
        }
    });
}

// ==================== GAP MODAL (Coverage Gaps) ====================
function openGapModal(gap) {
    const role = roleMap[gap.roleId];
    const dayName = state.days[gap.day];
    
    // Populate gap info
    const infoEl = document.getElementById('gapModalInfo');
    infoEl.innerHTML = `
        <div class="gap-icon">+${gap.needed}</div>
        <div class="gap-modal-details">
            <h4>${gap.needed} ${role?.name || 'Staff'} Needed</h4>
            <p>${dayName}, ${formatHour(gap.startHour)} - ${formatHour(gap.endHour)}</p>
        </div>
    `;
    
    // Update title
    document.getElementById('gapModalTitle').textContent = `Coverage Gap - ${dayName}`;
    
    // Find available employees
    const availableEmployees = findAvailableEmployeesForGap(gap);
    
    // Populate available employees list
    const listEl = document.getElementById('availableEmployeesList');
    listEl.innerHTML = '';
    
    if (availableEmployees.length === 0) {
        listEl.innerHTML = `
            <div class="no-available-employees">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="8" x2="12" y2="12"></line>
                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
                </svg>
                <p>No employees available for this time slot</p>
            </div>
        `;
    } else {
        availableEmployees.forEach(empData => {
            const card = createAvailableEmployeeCard(empData, gap);
            listEl.appendChild(card);
        });
    }
    
    openModal('gapModal');
}

function findAvailableEmployeesForGap(gap) {
    const schedule = state.currentSchedule;
    if (!schedule) return [];
    
    const slotAssignments = schedule.slot_assignments || {};
    const availableEmps = [];
    
    state.employees.forEach(emp => {
        // Calculate current weekly hours
        let currentHours = 0;
        const weeklySchedule = {}; // { dayIdx: [{start, end}] }
        
        for (let day = 0; day < 7; day++) {
            weeklySchedule[day] = [];
            const dayHours = [];
            
            state.hours.forEach(hour => {
                const key = `${day},${hour}`;
                const assignments = slotAssignments[key] || [];
                if (assignments.some(a => a.employee_id === emp.id)) {
                    dayHours.push(hour);
                    currentHours++;
                }
            });
            
            // Convert to segments
            if (dayHours.length > 0) {
                dayHours.sort((a, b) => a - b);
                let segStart = dayHours[0];
                let prevHour = dayHours[0];
                
                for (let i = 1; i <= dayHours.length; i++) {
                    const currentHour = dayHours[i];
                    if (currentHour !== prevHour + 1 || i === dayHours.length) {
                        weeklySchedule[day].push({ start: segStart, end: prevHour + 1 });
                        if (i < dayHours.length) segStart = currentHour;
                    }
                    if (currentHour) prevHour = currentHour;
                }
            }
        }
        
        // Check if employee can take more hours
        const hoursAvailable = emp.max_hours - currentHours;
        const gapDuration = gap.endHour - gap.startHour;
        
        if (hoursAvailable < gapDuration) return; // Can't fit this shift
        
        // Check if employee has the required role (if specified)
        if (gap.roleId && emp.roles && emp.roles.length > 0) {
            if (!emp.roles.includes(gap.roleId)) return; // Doesn't have required role
        }
        
        // Check availability for the gap time slot
        const isAvailable = checkEmployeeAvailability(emp, gap.day, gap.startHour, gap.endHour);
        if (!isAvailable) return;
        
        // Check if already scheduled during this time
        const alreadyScheduled = weeklySchedule[gap.day].some(shift => 
            gap.startHour < shift.end && gap.endHour > shift.start
        );
        if (alreadyScheduled) return;
        
        availableEmps.push({
            employee: emp,
            currentHours,
            hoursAvailable,
            weeklySchedule
        });
    });
    
    // Sort by who has most hours available (prioritize those who need hours)
    availableEmps.sort((a, b) => {
        // Prioritize those under minimum hours
        const aUnderMin = a.currentHours < a.employee.min_hours;
        const bUnderMin = b.currentHours < b.employee.min_hours;
        if (aUnderMin && !bUnderMin) return -1;
        if (!aUnderMin && bUnderMin) return 1;
        
        // Then sort by hours available (descending)
        return b.hoursAvailable - a.hoursAvailable;
    });
    
    return availableEmps;
}

function checkEmployeeAvailability(emp, day, startHour, endHour) {
    // Check if employee is available for all hours in the range
    for (let hour = startHour; hour < endHour; hour++) {
        const isAvailable = emp.availability.some(slot => slot.day === day && slot.hour === hour);
        if (!isAvailable) return false;
        
        // Check if it's time off
        const isTimeOff = emp.time_off && emp.time_off.some(slot => slot.day === day && slot.hour === hour);
        if (isTimeOff) return false;
    }
    return true;
}

function createAvailableEmployeeCard(empData, gap) {
    const emp = empData.employee;
    const initials = emp.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
    
    const card = document.createElement('div');
    card.className = 'available-employee-card';
    
    // Build badges
    let badgesHtml = '';
    if (emp.classification === 'full_time') {
        badgesHtml += '<span class="badge badge-ft">FT</span>';
    } else {
        badgesHtml += '<span class="badge badge-pt">PT</span>';
    }
    if (emp.can_supervise) {
        badgesHtml += '<span class="badge badge-sup">SUP</span>';
    }
    if (emp.needs_supervision) {
        badgesHtml += '<span class="badge badge-new">NEW</span>';
    }
    if (emp.overtime_allowed) {
        badgesHtml += '<span class="badge badge-ot">OT</span>';
    }
    
    // Build weekly schedule display
    let scheduleHtml = '';
    const dayAbbrevs = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    
    for (let day = 0; day < 7; day++) {
        const shifts = empData.weeklySchedule[day];
        if (shifts.length > 0) {
            const shiftStrs = shifts.map(s => `${formatHour(s.start)}-${formatHour(s.end)}`).join(', ');
            scheduleHtml += `<span class="schedule-day"><strong>${dayAbbrevs[day]}:</strong> ${shiftStrs}</span>`;
        }
    }
    
    // Hours status
    const hoursClass = empData.currentHours < emp.min_hours ? 'hours-available' : '';
    const underMinText = empData.currentHours < emp.min_hours 
        ? ` (needs ${emp.min_hours - empData.currentHours}h more)` 
        : '';
    
    card.innerHTML = `
        <div class="emp-avatar" style="background: ${emp.color || '#666'}">${initials}</div>
        <div class="emp-info">
            <div class="emp-name-row">
                <span class="emp-name">${emp.name}</span>
                <div class="emp-badges">${badgesHtml}</div>
            </div>
            <div class="emp-hours-info">
                <span class="hours-current ${hoursClass}">${empData.currentHours}h scheduled</span>
                <span>•</span>
                <span>${emp.min_hours}-${emp.max_hours}h range</span>
                <span>•</span>
                <span class="hours-available">${empData.hoursAvailable}h available${underMinText}</span>
            </div>
            <div class="emp-schedule">
                ${scheduleHtml ? `<span>Current schedule:</span><div class="emp-schedule-days">${scheduleHtml}</div>` : '<span>No shifts scheduled yet</span>'}
            </div>
        </div>
    `;
    
    // Add click to assign (future feature)
    card.title = `Click to view ${emp.name}'s details`;
    
    return card;
}

// ==================== TIMELINE ADD SHIFT ====================

// State for availability drag selection
const availabilityDragState = {
    isDragging: false,
    isSelecting: true, // true = selecting, false = deselecting
    currentEmpId: null, // For the availability tab grid
    startCell: null
};

// State for drag-to-create
const timelineCreateState = {
    isDragging: false,
    startX: null,
    startHour: null, // Fixed anchor from mousedown
    currentStart: null, // Left edge of drag
    currentEnd: null,   // Right edge of drag
    dayIdx: null,
    previewElement: null,
    tooltipElement: null,
    slotsContainer: null,
    suppressClick: false // Prevent click-after-drag from reopening modal
};

// Open the add shift modal
function openTimelineAddShiftModal(dayIdx, startHour = null, endHour = null) {
    const modal = document.getElementById('timelineAddShiftModal');
    if (!modal) return;
    
    const dayName = state.days[dayIdx];
    document.getElementById('timelineAddShiftTitle').textContent = `Add Shift - ${dayName}`;
    document.getElementById('timelineAddShiftDay').value = dayIdx;
    
    // Populate role dropdown first (role selection filters employees)
    const roleSelect = document.getElementById('timelineAddShiftRole');
    roleSelect.innerHTML = '<option value="">Select Role...</option>';
    state.roles.forEach(role => {
        const option = document.createElement('option');
        option.value = role.id;
        option.textContent = role.name;
        roleSelect.appendChild(option);
    });
    
    // Populate employee dropdown (will be filtered when role is selected)
    const empSelect = document.getElementById('timelineAddShiftEmployee');
    populateEmployeeDropdownByRole(empSelect, null); // Show all employees initially
    // Clicking inside a role's row pre-selects that role
    const preselect = timelineCreateState.preselectRoleId;
    timelineCreateState.preselectRoleId = null;
    if (preselect && state.roles.some(r => r.id === preselect)) {
        roleSelect.value = preselect;
        populateEmployeeDropdownByRole(empSelect, preselect);
    }
    
    // Populate hour dropdowns
    const startHourSelect = document.getElementById('timelineAddShiftStartHour');
    const endHourSelect = document.getElementById('timelineAddShiftEndHour');
    startHourSelect.innerHTML = '';
    endHourSelect.innerHTML = '';
    
    for (let h = state.startHour; h <= state.endHour; h++) {
        const opt1 = document.createElement('option');
        opt1.value = h;
        opt1.textContent = formatHour(h);
        startHourSelect.appendChild(opt1);
        
        const opt2 = document.createElement('option');
        opt2.value = h;
        opt2.textContent = formatHour(h);
        endHourSelect.appendChild(opt2);
    }
    
    // Set default or provided times
    let startHourVal, startMinVal, endHourVal, endMinVal;
    
    // Helper to extract hour and minute from fractional hour
    const parseFractional = (val) => {
        const h = Math.floor(val + 0.001); // Handle precision
        const m = Math.round((val - h) * 60);
        return [h, Math.round(m / 15) * 15]; // Round to nearest 15
    };

    if (startHour !== null) {
        const [h, m] = parseFractional(startHour);
        startHourVal = h;
        startMinVal = m;
        if (startMinVal === 60) {
            startMinVal = 0;
            startHourVal++;
        }
    } else {
        startHourVal = state.startHour;
        startMinVal = 0;
    }
    
    if (endHour !== null) {
        const [h, m] = parseFractional(endHour);
        endHourVal = h;
        endMinVal = m;
        if (endMinVal === 60) {
            endMinVal = 0;
            endHourVal++;
        }
    } else {
        endHourVal = Math.min(startHourVal + 8, state.endHour);
        endMinVal = 0;
    }
    
    // Important: Convert to strings to ensure matching dropdown values
    startHourSelect.value = String(startHourVal);
    endHourSelect.value = String(endHourVal);
    document.getElementById('timelineAddShiftStartMin').value = String(startMinVal);
    document.getElementById('timelineAddShiftEndMin').value = String(endMinVal);
    
    // Update duration display
    updateTimelineAddShiftDuration();
    
    // Hide employee preview initially
    document.getElementById('timelineAddShiftPreview').style.display = 'none';
    
    // Show modal
    modal.classList.add('active');
}

// Update duration display in the modal
function updateTimelineAddShiftDuration() {
    const startHour = parseInt(document.getElementById('timelineAddShiftStartHour').value) || 0;
    const startMin = parseInt(document.getElementById('timelineAddShiftStartMin').value) || 0;
    const endHour = parseInt(document.getElementById('timelineAddShiftEndHour').value) || 0;
    const endMin = parseInt(document.getElementById('timelineAddShiftEndMin').value) || 0;
    
    const startTime = startHour + startMin / 60;
    const endTime = endHour + endMin / 60;
    const duration = endTime - startTime;
    
    const durationEl = document.getElementById('timelineAddShiftDuration');
    if (duration > 0) {
        const hours = Math.floor(duration);
        const mins = Math.round((duration % 1) * 60);
        const timeStr = mins > 0 ? `${hours}h ${mins}m` : `${hours} hours`;
        durationEl.textContent = `Duration: ${timeStr}`;
        durationEl.style.color = '';
    } else {
        durationEl.textContent = 'End time must be after start time';
        durationEl.style.color = 'var(--color-danger)';
    }
}

/**
 * Populate employee dropdown, optionally filtered by role
 * @param {HTMLSelectElement} empSelect - The employee dropdown element
 * @param {string|null} roleId - Role ID to filter by, or null for all employees
 */
function populateEmployeeDropdownByRole(empSelect, roleId) {
    const currentValue = empSelect.value; // Preserve current selection if still valid
    empSelect.innerHTML = '<option value="">Select Employee...</option>';
    
    // Filter employees by role if a role is selected
    let filteredEmployees = state.employees;
    if (roleId) {
        filteredEmployees = state.employees.filter(emp => 
            emp.roles && emp.roles.includes(roleId)
        );
    }
    
    // Sort by name
    filteredEmployees.sort((a, b) => a.name.localeCompare(b.name));
    
    filteredEmployees.forEach(emp => {
        const option = document.createElement('option');
        option.value = emp.id;
        option.textContent = emp.name;
        empSelect.appendChild(option);
    });
    
    // Restore previous selection if the employee is still in the filtered list
    if (currentValue && filteredEmployees.some(emp => emp.id === currentValue)) {
        empSelect.value = currentValue;
    }
    
    // Show count in placeholder if filtered
    if (roleId && filteredEmployees.length === 0) {
        empSelect.innerHTML = '<option value="">No employees with this role</option>';
    } else if (roleId) {
        empSelect.options[0].textContent = `Select Employee... (${filteredEmployees.length} available)`;
    }
}

/**
 * Handle role change in add shift modal - filter employees by selected role
 */
function handleAddShiftRoleChange() {
    const roleId = document.getElementById('timelineAddShiftRole').value;
    const empSelect = document.getElementById('timelineAddShiftEmployee');
    populateEmployeeDropdownByRole(empSelect, roleId || null);
    updateTimelineAddShiftEmpPreview();
}

// Update employee preview when selection changes
function updateTimelineAddShiftEmpPreview() {
    const empId = document.getElementById('timelineAddShiftEmployee').value;
    const previewSection = document.getElementById('timelineAddShiftPreview');
    const previewInfo = document.getElementById('timelineAddShiftEmpInfo');
    
    if (!empId) {
        previewSection.style.display = 'none';
        return;
    }
    
    const emp = employeeMap[empId];
    if (!emp) {
        previewSection.style.display = 'none';
        return;
    }
    
    // Calculate current hours for this employee
    const slotAssignments = state.currentSchedule?.slot_assignments || {};
    let currentHours = 0;
    let daysWorked = new Set();
    
    for (let day = 0; day < 7; day++) {
        state.hours.forEach(hour => {
            const key = `${day},${hour}`;
            const assignments = slotAssignments[key] || [];
            if (assignments.some(a => a.employee_id === empId)) {
                currentHours++;
                daysWorked.add(day);
            }
        });
    }
    
    const empType = emp.classification === 'full_time' ? 'Full-Time' : 'Part-Time';
    const minHours = emp.min_hours || 0;
    const maxHours = emp.max_hours || 40;
    
    // Check if adding this shift would exceed max
    const startHour = parseInt(document.getElementById('timelineAddShiftStartHour').value) || 0;
    const endHour = parseInt(document.getElementById('timelineAddShiftEndHour').value) || 0;
    const shiftDuration = endHour - startHour;
    const newTotal = currentHours + shiftDuration;
    
    let warningHtml = '';
    if (newTotal > maxHours) {
        warningHtml = `<div class="preview-warning">⚠️ This would exceed max hours (${newTotal}h > ${maxHours}h)</div>`;
    }
    
    previewInfo.innerHTML = `
        <div class="preview-row">
            <span class="preview-label">Type:</span>
            <span class="preview-value">${empType}</span>
        </div>
        <div class="preview-row">
            <span class="preview-label">Current Hours:</span>
            <span class="preview-value">${currentHours}h / ${minHours}-${maxHours}h</span>
        </div>
        <div class="preview-row">
            <span class="preview-label">Days Working:</span>
            <span class="preview-value">${daysWorked.size} days</span>
        </div>
        <div class="preview-row">
            <span class="preview-label">After This Shift:</span>
            <span class="preview-value">${newTotal}h</span>
        </div>
        ${warningHtml}
    `;
    
    previewSection.style.display = 'block';
}

// Save the new shift
function saveTimelineAddShift(e) {
    e.preventDefault();
    
    const dayIdx = parseInt(document.getElementById('timelineAddShiftDay').value);
    const empId = document.getElementById('timelineAddShiftEmployee').value;
    const roleId = document.getElementById('timelineAddShiftRole').value;
    const startHour = parseInt(document.getElementById('timelineAddShiftStartHour').value);
    const startMin = parseInt(document.getElementById('timelineAddShiftStartMin').value);
    const endHour = parseInt(document.getElementById('timelineAddShiftEndHour').value);
    const endMin = parseInt(document.getElementById('timelineAddShiftEndMin').value);
    
    if (!empId || !roleId) {
        showToast('Please select an employee and role', 'error');
        return;
    }
    
    const startTime = startHour + startMin / 60;
    const endTime = endHour + endMin / 60;
    
    if (endTime <= startTime) {
        showToast('End time must be after start time', 'error');
        return;
    }
    
    // Add the shift to slot assignments
    const slotAssignments = state.currentSchedule?.slot_assignments;
    if (!slotAssignments) {
        showToast('No schedule to add shift to', 'error');
        return;
    }
    
    // Add hourly assignments (round to hours for storage)
    const actualStart = Math.floor(startTime);
    const actualEnd = Math.ceil(endTime);
    
    for (let hour = actualStart; hour < actualEnd; hour++) {
        const key = `${dayIdx},${hour}`;
        if (!slotAssignments[key]) {
            slotAssignments[key] = [];
        }
        // Check if already assigned
        if (!slotAssignments[key].some(a => a.employee_id === empId)) {
            slotAssignments[key].push({
                employee_id: empId,
                role_id: roleId
            });
        }
    }
    
    // Close modal and refresh (open hours and metrics update with the new shift)
    const modal = document.getElementById('timelineAddShiftModal');
    modal.classList.remove('active');
    afterManualScheduleEdit();

    const emp = employeeMap[empId];
    const dayName = state.days[dayIdx];
    showToast(`Added ${emp?.name}'s shift on ${dayName}`, 'success');
}

// Initialize timeline add shift modal events
function initTimelineAddShiftModal() {
    const form = document.getElementById('timelineAddShiftForm');
    if (form) {
        form.addEventListener('submit', saveTimelineAddShift);
    }
    
    // Time change listeners
    ['timelineAddShiftStartHour', 'timelineAddShiftStartMin', 'timelineAddShiftEndHour', 'timelineAddShiftEndMin'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', () => {
                updateTimelineAddShiftDuration();
                updateTimelineAddShiftEmpPreview();
            });
        }
    });
    
    // Employee change listener
    const empSelect = document.getElementById('timelineAddShiftEmployee');
    if (empSelect) {
        empSelect.addEventListener('change', updateTimelineAddShiftEmpPreview);
    }
    
    // Role change listener - filter employees by selected role
    const roleSelect = document.getElementById('timelineAddShiftRole');
    if (roleSelect) {
        roleSelect.addEventListener('change', handleAddShiftRoleChange);
    }
}

// Handle click on timeline row to add shift
function handleTimelineRowClick(e, dayIdx, slotsContainer) {
    // Ignore synthetic click immediately after drag-create
    if (timelineCreateState.suppressClick) {
        timelineCreateState.suppressClick = false;
        return;
    }
    // Don't trigger if clicking on a shift block
    if (e.target.closest('.timeline-shift-block') || e.target.closest('.timeline-gap-block')) {
        return;
    }
    
    // Don't trigger if we were dragging to create
    if (timelineCreateState.isDragging) {
        return;
    }
    
    // Calculate hour from click position
    const rect = slotsContainer.getBoundingClientRect();
    const relativeX = e.clientX - rect.left;
    const totalHours = state.endHour - state.startHour;
    const hourFloat = (relativeX / rect.width) * totalHours + state.startHour;
    
    // Snap to nearest hour
    const clickedHour = Math.floor(hourFloat);
    
    // Open modal with clicked hour as start
    openTimelineAddShiftModal(dayIdx, clickedHour, clickedHour + 1);
}

// Handle drag to create shift
function handleTimelineRowMouseDown(e, dayIdx, slotsContainer) {
    // Don't trigger if clicking on a shift block
    if (e.target.closest('.timeline-shift-block') || e.target.closest('.timeline-gap-block')) {
        return;
    }
    
    // Calculate starting hour
    const rect = slotsContainer.getBoundingClientRect();
    const relativeX = e.clientX - rect.left;
    const totalHours = state.endHour - state.startHour;
    const hourFloat = (relativeX / rect.width) * totalHours;
    
    // Snap to 15-minute increments
    const snappedHour = Math.round(hourFloat * 4) / 4;
    
    timelineCreateState.isDragging = false; // Will be set true on mousemove
    timelineCreateState.startX = e.clientX;
    timelineCreateState.startHour = state.startHour + snappedHour;
    timelineCreateState.dayIdx = dayIdx;
    timelineCreateState.slotsContainer = slotsContainer;
    timelineCreateState.rect = rect;
    timelineCreateState.totalHours = totalHours;
    
    // Add mouse listeners
    document.addEventListener('mousemove', handleTimelineCreateMouseMove);
    document.addEventListener('mouseup', handleTimelineCreateMouseUp);
}

function handleTimelineCreateMouseMove(e) {
    const moveDist = Math.abs(e.clientX - timelineCreateState.startX);
    
    // Only start drag if moved at least 10px
    if (moveDist < 10 && !timelineCreateState.isDragging) {
        return;
    }
    
    timelineCreateState.isDragging = true;
    
    const rect = timelineCreateState.rect;
    const totalHours = timelineCreateState.totalHours;
    const slotsContainer = timelineCreateState.slotsContainer;
    
    // Calculate current hour
    const relativeX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const hourFloat = (relativeX / rect.width) * totalHours;
    const snappedHour = Math.round(hourFloat * 4) / 4;
    const currentHour = state.startHour + snappedHour;
    
    // Calculate start and end (ensure start < end)
    const startHour = Math.min(timelineCreateState.startHour, currentHour);
    const endHour = Math.max(timelineCreateState.startHour, currentHour);
    
    // Clamp to business hours
    const clampedStart = Math.max(state.startHour, startHour);
    const clampedEnd = Math.min(state.endHour, endHour);
    
    // Save current range to state to ensure mouseup matches exactly
    timelineCreateState.currentStart = clampedStart;
    timelineCreateState.currentEnd = clampedEnd;
    
    // Create or update preview element (the bar)
    if (!timelineCreateState.previewElement) {
        const preview = document.createElement('div');
        preview.className = 'timeline-create-preview';
        slotsContainer.appendChild(preview);
        timelineCreateState.previewElement = preview;
    }
    
    // Create or update tooltip (floating above)
    if (!timelineCreateState.tooltipElement) {
        const tooltip = document.createElement('div');
        tooltip.className = 'timeline-create-tooltip';
        document.body.appendChild(tooltip);
        timelineCreateState.tooltipElement = tooltip;
    }
    
    const preview = timelineCreateState.previewElement;
    const tooltip = timelineCreateState.tooltipElement;
    const leftPercent = ((clampedStart - state.startHour) / totalHours) * 100;
    const widthPercent = ((clampedEnd - clampedStart) / totalHours) * 100;
    
    preview.style.left = `${leftPercent}%`;
    preview.style.width = `${Math.max(widthPercent, 2)}%`;
    
    // Position tooltip above the preview, centered
    const previewRect = preview.getBoundingClientRect();
    tooltip.style.left = `${previewRect.left + previewRect.width / 2}px`;
    tooltip.style.top = `${previewRect.top - 60}px`;
    
    // Update tooltip content
    const duration = clampedEnd - clampedStart;
    const hours = Math.floor(duration);
    const mins = Math.round((duration % 1) * 60);
    const durationText = hours > 0 && mins > 0 ? `${hours}h ${mins}m` : hours > 0 ? `${hours}h` : `${mins}m`;
    
    tooltip.innerHTML = `
        <span class="tooltip-label">+ New Shift</span>
        <span class="tooltip-time">${formatHour(clampedStart)} – ${formatHour(clampedEnd)}</span>
        <span class="tooltip-duration">${durationText}</span>
    `;
}

function handleTimelineCreateMouseUp(e) {
    document.removeEventListener('mousemove', handleTimelineCreateMouseMove);
    document.removeEventListener('mouseup', handleTimelineCreateMouseUp);
    
    // Remove preview bar
    if (timelineCreateState.previewElement) {
        timelineCreateState.previewElement.remove();
        timelineCreateState.previewElement = null;
    }
    
    // Remove tooltip
    if (timelineCreateState.tooltipElement) {
        timelineCreateState.tooltipElement.remove();
        timelineCreateState.tooltipElement = null;
    }
    
    // If we were dragging, open modal with the range
    if (timelineCreateState.isDragging && timelineCreateState.currentStart !== null) {
        const start = timelineCreateState.currentStart;
        const end = timelineCreateState.currentEnd;
        
        // Only open if there's a meaningful range (at least 15 mins)
        if (end - start >= 0.2) {
            openTimelineAddShiftModal(timelineCreateState.dayIdx, start, end);
            // Prevent the subsequent click event from reopening the modal
            timelineCreateState.suppressClick = true;
        }
    }
    
    // Reset state
    timelineCreateState.isDragging = false;
    timelineCreateState.startX = null;
    timelineCreateState.startHour = null;
    timelineCreateState.currentStart = null;
    timelineCreateState.currentEnd = null;
    timelineCreateState.dayIdx = null;
    timelineCreateState.slotsContainer = null;
}

// ==================== SHIFT EDITOR (Timeline/Grid Click) ====================
function openShiftEditor(shift) {
    const modal = dom.shiftEditModal;
    if (!modal) return;
    
    const role = roleMap[shift.roleId];
    const emp = shift.emp;
    const initials = emp.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
    
    // Store shift data for save/delete
    modal.dataset.shiftData = JSON.stringify({
        empId: shift.empId,
        roleId: shift.roleId,
        dayIdx: shift.dayIdx,
        startHour: shift.startHour,
        endHour: shift.endHour
    });
    
    // Populate shift info
    const infoEl = document.getElementById('shiftEditInfo');
    infoEl.innerHTML = `
        <div class="shift-color-dot" style="background: ${emp.color || '#666'}">${initials}</div>
        <div class="shift-edit-details">
            <h4>${emp.name}</h4>
            <p>Role: ${role?.name || 'Staff'}</p>
            <div class="shift-time">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
                <span>${shift.day}, ${formatHour(shift.startHour)} - ${formatHour(shift.endHour)}</span>
            </div>
        </div>
    `;
    
    // Update title
    document.getElementById('shiftEditModalTitle').textContent = `Edit Shift - ${shift.day}`;
    
    // Populate employee select with available employees
    const empSelect = document.getElementById('shiftEditEmployee');
    empSelect.innerHTML = '';
    
    // Add current employee as first option
    const currentOpt = document.createElement('option');
    currentOpt.value = emp.id;
    currentOpt.textContent = `${emp.name} (current)`;
    empSelect.appendChild(currentOpt);
    
    // Find other available employees for this time slot
    state.employees.forEach(otherEmp => {
        if (otherEmp.id === emp.id) return; // Skip current employee
        
        // Check availability
        const isAvailable = checkEmployeeAvailability(otherEmp, shift.dayIdx, shift.startHour, shift.endHour);
        if (!isAvailable) return;
        
        // Check if already scheduled during this time
        const schedule = state.currentSchedule;
        if (schedule) {
            const slotAssignments = schedule.slot_assignments || {};
            let alreadyScheduled = false;
            
            for (let hour = shift.startHour; hour < shift.endHour; hour++) {
                const key = `${shift.dayIdx},${hour}`;
                const assignments = slotAssignments[key] || [];
                if (assignments.some(a => a.employee_id === otherEmp.id)) {
                    alreadyScheduled = true;
                    break;
                }
            }
            
            if (alreadyScheduled) return;
        }
        
        // Check if has required role
        if (shift.roleId && otherEmp.roles && otherEmp.roles.length > 0) {
            if (!otherEmp.roles.includes(shift.roleId)) return;
        }
        
        // Calculate current hours
        let currentHours = 0;
        if (schedule) {
            const slotAssignments = schedule.slot_assignments || {};
            for (const [key, assignments] of Object.entries(slotAssignments)) {
                if (assignments.some(a => a.employee_id === otherEmp.id)) {
                    currentHours++;
                }
            }
        }
        
        const shiftDuration = shift.endHour - shift.startHour;
        const wouldExceedMax = currentHours + shiftDuration > otherEmp.max_hours;
        
        const opt = document.createElement('option');
        opt.value = otherEmp.id;
        opt.textContent = `${otherEmp.name} (${currentHours}h scheduled)`;
        opt.disabled = wouldExceedMax;
        if (wouldExceedMax) {
            opt.textContent += ' - max hours';
        }
        empSelect.appendChild(opt);
    });
    
    openModal('shiftEditModal');
}

function saveShiftEdit() {
    const modal = dom.shiftEditModal;
    const shiftData = JSON.parse(modal.dataset.shiftData);
    const newEmpId = document.getElementById('shiftEditEmployee').value;
    
    if (!state.currentSchedule) {
        showToast('No schedule to edit', 'warning');
        closeAllModals();
        return;
    }
    
    const slotAssignments = state.currentSchedule.slot_assignments;
    
    // If employee changed, update all slots in the shift range
    if (newEmpId !== shiftData.empId) {
        for (let hour = shiftData.startHour; hour < shiftData.endHour; hour++) {
            const key = `${shiftData.dayIdx},${hour}`;
            const assignments = slotAssignments[key] || [];
            
            // Find and update the assignment for the old employee
            const idx = assignments.findIndex(a => a.employee_id === shiftData.empId);
            if (idx !== -1) {
                assignments[idx].employee_id = newEmpId;
            }
        }
        
        showToast('Shift reassigned successfully', 'success');
    }

    // Re-render whichever view is active and refresh open hours / metrics
    afterManualScheduleEdit();
    closeAllModals();
}

function deleteScheduleShift() {
    const modal = dom.shiftEditModal;
    const shiftData = JSON.parse(modal.dataset.shiftData);
    
    if (!state.currentSchedule) {
        showToast('No schedule to edit', 'warning');
        closeAllModals();
        return;
    }
    
    const slotAssignments = state.currentSchedule.slot_assignments;
    
    // Find ALL hours where this employee is currently assigned on this day
    // This handles cases where the shift was resized and the stored data is stale
    const hoursToDelete = [];
    for (let hour = state.startHour; hour < state.endHour; hour++) {
        const key = `${shiftData.dayIdx},${hour}`;
        const assignments = slotAssignments[key] || [];
        if (assignments.some(a => a.employee_id === shiftData.empId)) {
            hoursToDelete.push(hour);
        }
    }
    
    if (hoursToDelete.length === 0) {
        showToast('Shift not found', 'error');
        closeAllModals();
        return;
    }
    
    // Remove the employee from all found slots
    hoursToDelete.forEach(hour => {
        const key = `${shiftData.dayIdx},${hour}`;
        const assignments = slotAssignments[key] || [];
        
        // Filter out the assignment for this employee
        const filtered = assignments.filter(a => a.employee_id !== shiftData.empId);
        
        if (filtered.length > 0) {
            slotAssignments[key] = filtered;
        } else {
            delete slotAssignments[key];
        }
    });
    
    // Recompute open hours from the requirements (the deleted hours only count
    // as gaps where coverage actually calls for them)
    afterManualScheduleEdit();
    showToast('Shift deleted', 'success');
    closeAllModals();
}

// ==================== SLOT EDITOR ====================
function openSlotEditor(day, hour) {
    const dayName = state.days[day];
    const timeStr = `${hour.toString().padStart(2, '0')}:00`;
    
    document.getElementById('slotInfo').textContent = `${dayName} at ${timeStr}`;
    
    // Populate employee select
    const empSelect = document.getElementById('slotEmployee');
    empSelect.innerHTML = '<option value="">— Unassigned —</option>';
    
    state.employees.forEach(emp => {
        // Check if employee is available
        const isAvailable = emp.availability.some(slot => slot.day === day && slot.hour === hour);
        const opt = document.createElement('option');
        opt.value = emp.id;
        opt.textContent = emp.name + (isAvailable ? '' : ' (unavailable)');
        opt.disabled = !isAvailable;
        empSelect.appendChild(opt);
    });
    
    // Populate role select
    const roleSelect = document.getElementById('slotRole');
    roleSelect.innerHTML = '';
    state.roles.forEach(role => {
        const opt = document.createElement('option');
        opt.value = role.id;
        opt.textContent = role.name;
        roleSelect.appendChild(opt);
    });
    
    // Check current assignment
    if (state.currentSchedule) {
        const key = `${day},${hour}`;
        const assignments = state.currentSchedule.slot_assignments[key];
        if (assignments && assignments.length > 0) {
            empSelect.value = assignments[0].employee_id;
            roleSelect.value = assignments[0].role_id;
        }
    }
    
    // Store context for save
    document.getElementById('slotModal').dataset.day = day;
    document.getElementById('slotModal').dataset.hour = hour;
    
    openModal('slotModal');
}

function saveSlotAssignment() {
    const modal = document.getElementById('slotModal');
    const day = parseInt(modal.dataset.day);
    const hour = parseInt(modal.dataset.hour);
    const empId = document.getElementById('slotEmployee').value;
    const roleId = document.getElementById('slotRole').value;
    
    if (!state.currentSchedule) {
        showToast('Generate a schedule first', 'warning');
        closeAllModals();
        return;
    }
    
    const key = `${day},${hour}`;
    
    if (empId) {
        state.currentSchedule.slot_assignments[key] = [{
            employee_id: empId,
            role_id: roleId
        }];
    } else {
        delete state.currentSchedule.slot_assignments[key];
    }
    
    renderSchedule(state.currentSchedule);
    closeAllModals();
    showToast('Shift updated', 'success');
}

// ==================== EMPLOYEES TAB ====================
let employeeFilterBy = 'all'; // Default filter

function setupEmployeesTab() {
    // The team list lives on the Staff Availability page; only the Add button remains.
    if (dom.addEmployeeBtn) dom.addEmployeeBtn.addEventListener('click', () => openEmployeeForm());
    if (dom.employeeSearch) dom.employeeSearch.addEventListener('input', renderEmployeesGrid);
    if (!dom.employeeFilterBtn || !dom.employeeFilterMenu) return;

    dom.employeeFilterBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dom.employeeFilterMenu.classList.toggle('open');
        populateRoleFilterOptions();
    });
    dom.employeeFilterMenu.querySelectorAll('.filter-option').forEach(option => {
        option.addEventListener('click', (e) => {
            e.stopPropagation();
            selectFilterOption(option);
        });
    });
    document.addEventListener('click', () => {
        dom.employeeFilterMenu.classList.remove('open');
    });
}

function populateRoleFilterOptions() {
    dom.roleFilterOptions.innerHTML = '';
    state.roles.forEach(role => {
        const btn = document.createElement('button');
        btn.className = 'filter-option';
        if (employeeFilterBy === `role_${role.id}`) btn.classList.add('active');
        btn.dataset.filter = `role_${role.id}`;
        btn.textContent = role.name;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            selectFilterOption(btn);
        });
        dom.roleFilterOptions.appendChild(btn);
    });
}

function selectFilterOption(option) {
    const filterBy = option.dataset.filter;
    employeeFilterBy = filterBy;
    
    // Update active state for all options
    dom.employeeFilterMenu.querySelectorAll('.filter-option').forEach(o => o.classList.remove('active'));
    option.classList.add('active');
    
    // Update label
    dom.employeeFilterLabel.textContent = option.textContent;
    
    // Close menu and re-render
    dom.employeeFilterMenu.classList.remove('open');
    renderEmployeesGrid(); if (state.currentTab === 'settings') renderAvailabilityPage();
}

function renderEmployeesGrid() {
    if (!dom.employeesGrid || !dom.employeeSearch) return;
    const search = dom.employeeSearch.value.toLowerCase();
    
    // Filter by search and selected filter
    let filtered = state.employees.filter(emp => {
        // Search filter
        if (search && !emp.name.toLowerCase().includes(search)) {
            return false;
        }
        
        // Category filter
        switch (employeeFilterBy) {
            case 'all':
                return true;
            case 'full_time':
                return emp.classification === 'full_time';
            case 'part_time':
                return emp.classification === 'part_time';
            case 'supervisors':
                return emp.can_supervise === true;
            case 'new_hires':
                return emp.needs_supervision === true;
            default:
                // Check for role filter (role_xxx)
                if (employeeFilterBy.startsWith('role_')) {
                    const roleId = employeeFilterBy.replace('role_', '');
                    return emp.roles.includes(roleId);
                }
                return true;
        }
    });
    
    // Always sort by name
    filtered.sort((a, b) => a.name.localeCompare(b.name));
    
    dom.employeesGrid.innerHTML = '';
    dom.employeeCount.textContent = `${filtered.length} employee${filtered.length !== 1 ? 's' : ''}`;
    
    filtered.forEach(emp => {
        const card = document.createElement('div');
        card.className = 'employee-card';
        card.dataset.id = emp.id;
        
        const initials = emp.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
        const rolesText = emp.roles.map(rId => roleMap[rId]?.name || rId).join(', ') || 'No roles';
        
        // Badges carry both full and short labels; CSS picks one per screen size
        let badgesFull = getBadgesHTML(emp);
        let badgesShort = '';
        
        card.innerHTML = `
            <div class="employee-card-header">
                <div class="employee-avatar" style="background: ${emp.color}">${initials}</div>
                <div class="employee-card-name">${emp.name}</div>
                <div class="employee-card-badges badges-full">${badgesFull}</div>
                <div class="employee-card-badges badges-short">${badgesShort}</div>
                <div class="employee-card-roles">${rolesText}</div>
                <div class="employee-card-meta">
                    <div class="meta-item">
                        <span class="meta-label">Hours</span>
                        <span class="meta-value">${emp.min_hours}-${emp.max_hours}h</span>
                    </div>
                    <div class="meta-item">
                        <span class="meta-label">Rate</span>
                        <span class="meta-value">$${emp.hourly_rate}/hr</span>
                    </div>
                </div>
                <div class="employee-card-expand">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                </div>
            </div>
            <div class="employee-card-details">
                <div class="employee-details-content">
                    <div class="detail-item">
                        <span class="detail-label">Classification</span>
                        <span class="detail-value">${emp.classification === 'full_time' ? 'Full-Time' : 'Part-Time'}</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">Weekly Hours</span>
                        <span class="detail-value">${emp.min_hours} - ${emp.max_hours} hours</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">Hourly Rate</span>
                        <span class="detail-value">$${emp.hourly_rate}</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">Roles</span>
                        <span class="detail-value">${rolesText}</span>
                    </div>
                    ${emp.can_supervise ? '<div class="detail-item"><span class="detail-label">Supervisor</span><span class="detail-value">Yes - Can train others</span></div>' : ''}
                    ${emp.needs_supervision ? '<div class="detail-item"><span class="detail-label">New Hire</span><span class="detail-value">Needs supervision</span></div>' : ''}
                    ${emp.overtime_allowed ? '<div class="detail-item"><span class="detail-label">Overtime</span><span class="detail-value">Allowed</span></div>' : ''}
                </div>
                <div class="employee-card-actions">
                    <button class="btn btn-sm btn-secondary edit-emp-btn" data-id="${emp.id}">
                        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg> Edit
                    </button>
                    <button class="btn btn-sm btn-secondary avail-emp-btn" data-id="${emp.id}">
                        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg> Availability
                    </button>
                    <button class="btn btn-sm btn-ghost delete-emp-btn" data-id="${emp.id}">
                        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </button>
                </div>
            </div>
        `;
        
        // Click to expand/collapse (only one at a time)
        card.querySelector('.employee-card-header').addEventListener('click', (e) => {
            // Don't expand if clicking on a button
            if (e.target.closest('button')) return;
            
            const isExpanding = !card.classList.contains('expanded');
            
            // Collapse all other cards first
            document.querySelectorAll('.employee-card.expanded').forEach(otherCard => {
                if (otherCard !== card) {
                    otherCard.classList.remove('expanded');
                }
            });
            
            // Toggle this card
            card.classList.toggle('expanded');
        });
        
        // Event listeners for action buttons
        card.querySelector('.edit-emp-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            openEmployeeForm(emp.id);
        });
        card.querySelector('.avail-emp-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            // Navigate to Settings (Availability) tab and select this employee
            switchTab('settings');
            setTimeout(() => {
                selectAvailabilityEmployee(emp.id);
            }, 100);
        });
        card.querySelector('.delete-emp-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            confirmDeleteEmployee(emp.id);
        });
        
        dom.employeesGrid.appendChild(card);
    });
}

function openEmployeeForm(empId = null) {
    const modal = dom.employeeModal;
    const form = document.getElementById('employeeForm');
    const title = document.getElementById('employeeModalTitle');
    
    // Reset form
    form.reset();
    
    // Populate roles checkboxes
    const rolesContainer = document.getElementById('empRoles');
    rolesContainer.innerHTML = '';
    state.roles.forEach(role => {
        const label = document.createElement('label');
        label.className = 'role-checkbox';
        label.innerHTML = `
            <input type="checkbox" value="${role.id}">
            <span class="role-color-swatch" style="background: ${role.color}"></span>
            <span>${role.name}</span>
        `;
        rolesContainer.appendChild(label);
    });
    
    if (empId) {
        // Edit mode
        const emp = employeeMap[empId];
        if (!emp) return;
        
        title.textContent = 'Edit Employee';
        state.editingEmployee = empId;
        
        document.getElementById('empId').value = emp.id;
        document.getElementById('empName').value = emp.name;
        document.getElementById('empColor').value = emp.color;
        document.getElementById('empEmail').value = emp.email || '';
        document.getElementById('empPhone').value = emp.phone || '';
        document.getElementById('empClassification').value = emp.classification;
        document.getElementById('empHourlyRate').value = emp.hourly_rate;
        document.getElementById('empMinHours').value = emp.min_hours;
        document.getElementById('empMaxHours').value = emp.max_hours;
        document.getElementById('empCanSupervise').checked = emp.can_supervise;
        document.getElementById('empNeedsSupervision').checked = emp.needs_supervision;
        document.getElementById('empOvertimeAllowed').checked = emp.overtime_allowed;
        
        // Check roles
        emp.roles.forEach(roleId => {
            const checkbox = rolesContainer.querySelector(`input[value="${roleId}"]`);
            if (checkbox) {
                checkbox.checked = true;
                checkbox.closest('.role-checkbox').classList.add('selected');
            }
        });
    } else {
        // Add mode
        title.textContent = 'Add Employee';
        state.editingEmployee = null;
        document.getElementById('empId').value = '';
        document.getElementById('empEmail').value = '';
        document.getElementById('empPhone').value = '';
        // Get a color not already used by existing employees
        const usedColors = state.employees.map(e => e.color);
        document.getElementById('empColor').value = getNextDistinctColor(usedColors);
    }
    
    // Role checkbox styling
    rolesContainer.querySelectorAll('input').forEach(cb => {
        cb.addEventListener('change', (e) => {
            e.target.closest('.role-checkbox').classList.toggle('selected', e.target.checked);
        });
    });
    
    // Setup invite toggle
    setupInviteToggle();
    
    openModal('employeeModal');
}

function setupInviteToggle() {
    const sendInviteCheckbox = document.getElementById('empSendInvite');
    const inviteOptions = document.getElementById('inviteOptions');
    const inviteByEmail = document.getElementById('inviteByEmail');
    const inviteBySMS = document.getElementById('inviteBySMS');
    const inviteNote = document.getElementById('inviteNote');
    const emailInput = document.getElementById('empEmail');
    const phoneInput = document.getElementById('empPhone');
    
    if (!sendInviteCheckbox) return;
    
    // Reset invite state
    sendInviteCheckbox.checked = false;
    inviteOptions.style.display = 'none';
    inviteByEmail.checked = true;
    inviteBySMS.checked = false;
    
    function updateInviteNote() {
        const email = emailInput.value.trim();
        const phone = phoneInput.value.trim();
        const wantEmail = inviteByEmail.checked;
        const wantSMS = inviteBySMS.checked;
        
        const warnings = [];
        if (wantEmail && !email) {
            warnings.push('email address');
        }
        if (wantSMS && !phone) {
            warnings.push('phone number');
        }
        
        if (warnings.length > 0) {
            inviteNote.textContent = `⚠️ Please add ${warnings.join(' and ')} above to send invitation.`;
            inviteNote.className = 'invite-note warning';
        } else if (wantEmail || wantSMS) {
            const methods = [];
            if (wantEmail && email) methods.push('email');
            if (wantSMS && phone) methods.push('text message');
            inviteNote.textContent = `Invitation will be sent via ${methods.join(' and ')}.`;
            inviteNote.className = 'invite-note';
        } else {
            inviteNote.textContent = 'Select at least one method to send invitation.';
            inviteNote.className = 'invite-note warning';
        }
    }
    
    sendInviteCheckbox.addEventListener('change', () => {
        inviteOptions.style.display = sendInviteCheckbox.checked ? 'block' : 'none';
        if (sendInviteCheckbox.checked) {
            updateInviteNote();
        }
    });
    
    inviteByEmail.addEventListener('change', updateInviteNote);
    inviteBySMS.addEventListener('change', updateInviteNote);
    emailInput.addEventListener('input', updateInviteNote);
    phoneInput.addEventListener('input', updateInviteNote);
}

async function handleEmployeeSubmit(e) {
    e.preventDefault();
    
    const empId = document.getElementById('empId').value;
    const isNew = !empId;
    
    const roles = [];
    document.getElementById('empRoles').querySelectorAll('input:checked').forEach(cb => {
        roles.push(cb.value);
    });
    
    const sendInvite = document.getElementById('empSendInvite').checked;
    const inviteByEmail = document.getElementById('inviteByEmail').checked;
    const inviteBySMS = document.getElementById('inviteBySMS').checked;
    
    const employeeData = {
        name: document.getElementById('empName').value,
        color: document.getElementById('empColor').value,
        email: document.getElementById('empEmail').value.trim() || null,
        phone: document.getElementById('empPhone').value.trim() || null,
        classification: document.getElementById('empClassification').value,
        hourly_rate: parseFloat(document.getElementById('empHourlyRate').value),
        min_hours: parseInt(document.getElementById('empMinHours').value),
        max_hours: parseInt(document.getElementById('empMaxHours').value),
        roles: roles,
        can_supervise: document.getElementById('empCanSupervise').checked,
        needs_supervision: document.getElementById('empNeedsSupervision').checked,
        overtime_allowed: document.getElementById('empOvertimeAllowed').checked,
        send_invite: sendInvite,
        invite_by_email: sendInvite && inviteByEmail,
        invite_by_sms: sendInvite && inviteBySMS
    };
    
    // Show loading state on save button
    const saveBtn = document.getElementById('saveEmployeeBtn');
    const originalBtnText = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="btn-spinner"></span>' + (isNew ? 'Adding...' : 'Saving...');
    
    try {
        let response;
        if (isNew) {
            response = await fetch('/api/employees', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(employeeData)
            });
        } else {
            response = await fetch(`/api/employees/${empId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(employeeData)
            });
        }
        
        const data = await response.json();
        
        if (data.success) {
            if (isNew) {
                state.employees.push(data.employee);
            } else {
                const idx = state.employees.findIndex(e => e.id === empId);
                if (idx >= 0) state.employees[idx] = data.employee;
            }
            
            buildLookups();
            renderEmployeesGrid(); if (state.currentTab === 'settings') renderAvailabilityPage();
            renderEmployeeHoursList();
            closeAllModals();
            
            // Show appropriate toast based on whether invitation was sent
            if (data.invitation_sent) {
                const methods = data.invitation_methods.join(' & ');
                showToast(`${isNew ? 'Employee added' : 'Employee updated'} — invitation sent via ${methods}`, 'success');
            } else if (data.invitation_errors && data.invitation_errors.length > 0) {
                // Employee was created but invitation had issues — show clear message
                showToast(isNew ? 'Employee added successfully' : 'Employee updated successfully', 'success');
                // Show invitation issue separately so it's clear the employee was saved
                const errors = data.invitation_errors.join('. ');
                showToast(`Could not send invitation: ${errors}`, 'warning');
            } else {
                showToast(isNew ? 'Employee added' : 'Employee updated', 'success');
            }
        } else {
            // Employee was NOT created — show the error clearly
            showToast(data.message || 'Could not save employee. Please try again.', 'error');
        }
    } catch (error) {
        showToast('Connection error — please check your internet and try again.', 'error');
    } finally {
        // Restore button state
        saveBtn.disabled = false;
        saveBtn.textContent = originalBtnText;
    }
}

function confirmDeleteEmployee(empId) {
    const emp = employeeMap[empId];
    if (!emp) return;
    
    document.getElementById('confirmTitle').textContent = 'Delete Employee';
    document.getElementById('confirmMessage').textContent = `Are you sure you want to remove ${emp.name}?`;
    document.getElementById('confirmBtn').dataset.action = 'deleteEmployee';
    document.getElementById('confirmBtn').dataset.id = empId;
    
    openModal('confirmModal');
}

async function deleteEmployee(empId) {
    try {
        const response = await fetch(`/api/employees/${empId}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.success) {
            state.employees = state.employees.filter(e => e.id !== empId);
            delete employeeMap[empId];
            renderEmployeesGrid(); if (state.currentTab === 'settings') renderAvailabilityPage();
            renderEmployeeHoursList();
            showToast(data.message || 'Employee removed', 'success');
        } else {
            showToast(data.message || 'Could not remove employee. Please refresh and try again.', 'error');
        }
    } catch (error) {
        showToast('Connection error — please check your internet and try again.', 'error');
    }
}

// ==================== AVAILABILITY EDITOR ====================
// Store edits for modal (separate from settings page)
let modalAvailEdits = {};

function openAvailabilityEditor(empId) {
    const emp = employeeMap[empId];
    if (!emp) return;
    
    state.editingAvailability = empId;
    document.getElementById('availEmpName').textContent = emp.name;
    
    // Render table view in modal
    renderModalAvailabilityTable(emp);
    
    openModal('availabilityModal');
    
    // Load PTO requests for this employee
    loadEmployeePTORequests(empId);
}

function renderModalAvailabilityTable(emp) {
    const container = document.getElementById('modalAvailTableView');
    if (!container) return;
        
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    
    // Initialize edits from current availability (Mon=0 to Sun=6)
    modalAvailEdits = {};
    for (let d = 0; d < 7; d++) {
        modalAvailEdits[d] = getAvailabilityRangesForDay(emp, d);
        if (modalAvailEdits[d].length === 0) {
            modalAvailEdits[d] = [];
        }
    }
    
    let html = '';
        for (let d = 0; d < 7; d++) {
        const ranges = modalAvailEdits[d];
        
        html += `<div class="avail-day-row" data-day="${d}">
            <div class="avail-day-name">${dayNames[d]}</div>
            <div class="avail-times-container">`;
        
        if (ranges.length > 0) {
            ranges.forEach((range, idx) => {
                html += renderModalTimeRange(d, idx, range[0], range[1]);
            });
        } else {
            html += `<div class="avail-unavailable-text">Unavailable</div>`;
        }
        
        html += `</div>
            <button class="avail-add-btn" data-day="${d}" title="Add time slot">+</button>
        </div>`;
    }
    
    container.innerHTML = html;
    setupModalAvailTableListeners(emp);
}

function renderModalTimeRange(day, idx, startHour, endHour) {
    const startParts = decimalToTimeParts(startHour);
    const endParts = decimalToTimeParts(endHour);
    
    return `
        <div class="avail-time-row" data-day="${day}" data-idx="${idx}">
            <button class="avail-remove-row-btn" data-day="${day}" data-idx="${idx}" title="Remove">−</button>
            ${renderModalTimeInput('start', day, idx, startParts)}
            <span class="avail-time-sep">to</span>
            ${renderModalTimeInput('end', day, idx, endParts)}
        </div>`;
}

function renderModalTimeInput(type, day, idx, parts) {
    const hours = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const mins = ['00', '15', '30', '45'];
    const ampms = ['AM', 'PM'];
    
    return `
        <div class="time-input-group manager-time-input modal-time-input" data-type="${type}" data-day="${day}" data-idx="${idx}">
            <div class="custom-select" data-field="hour" data-value="${parts.hour}">
                <span class="custom-select-value">${parts.hour}</span>
                <div class="custom-select-dropdown">
                    ${hours.map(h => `<div class="custom-select-option ${h === parts.hour ? 'selected' : ''}" data-value="${h}">${h}</div>`).join('')}
                </div>
            </div>
            <span class="time-colon">:</span>
            <div class="custom-select" data-field="min" data-value="${parts.min}">
                <span class="custom-select-value">${parts.min}</span>
                <div class="custom-select-dropdown">
                    ${mins.map(m => `<div class="custom-select-option ${m === parts.min ? 'selected' : ''}" data-value="${m}">${m}</div>`).join('')}
                </div>
            </div>
            <div class="custom-select time-ampm-select" data-field="ampm" data-value="${parts.ampm}">
                <span class="custom-select-value">${parts.ampm.toUpperCase()}</span>
                <div class="custom-select-dropdown">
                    ${ampms.map(a => `<div class="custom-select-option ${a.toLowerCase() === parts.ampm ? 'selected' : ''}" data-value="${a.toLowerCase()}">${a}</div>`).join('')}
                </div>
            </div>
        </div>
    `;
}

function setupModalAvailTableListeners(emp) {
    const container = document.getElementById('modalAvailTableView');
    
    // Custom dropdown handlers
    container.querySelectorAll('.custom-select').forEach(select => {
        const valueEl = select.querySelector('.custom-select-value');
        const dropdown = select.querySelector('.custom-select-dropdown');
        
        valueEl.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.custom-select.open').forEach(s => {
                if (s !== select) s.classList.remove('open');
            });
            select.classList.toggle('open');
        });
        
        dropdown.querySelectorAll('.custom-select-option').forEach(option => {
            option.addEventListener('click', (e) => {
                e.stopPropagation();
                const value = option.dataset.value;
                select.dataset.value = value;
                valueEl.textContent = option.textContent;
                dropdown.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
                option.classList.add('selected');
                select.classList.remove('open');
                updateModalTimeFromInputs(select.closest('.time-input-group'));
            });
        });
    });
    
    // Close dropdowns when clicking outside
    document.addEventListener('click', () => {
        document.querySelectorAll('.custom-select.open').forEach(s => s.classList.remove('open'));
    });
    
    // Add button
    container.querySelectorAll('.avail-add-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const day = parseInt(btn.dataset.day);
            if (!modalAvailEdits[day]) {
                modalAvailEdits[day] = [];
            }
            modalAvailEdits[day].push([state.startHour, state.endHour]);
            renderModalAvailabilityTable(emp);
        });
    });
    
    // Remove button
    container.querySelectorAll('.avail-remove-row-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const day = parseInt(btn.dataset.day);
            const idx = parseInt(btn.dataset.idx);
            if (modalAvailEdits[day]) {
                modalAvailEdits[day].splice(idx, 1);
                renderModalAvailabilityTable(emp);
            }
        });
    });
}

function updateModalTimeFromInputs(inputGroup) {
    const type = inputGroup.dataset.type;
    const day = parseInt(inputGroup.dataset.day);
    const idx = parseInt(inputGroup.dataset.idx);
    
    const hour = inputGroup.querySelector('[data-field="hour"]').dataset.value;
    const min = inputGroup.querySelector('[data-field="min"]').dataset.value;
    const ampm = inputGroup.querySelector('[data-field="ampm"]').dataset.value;
    
    const decimal = timePartsToDecimalManager(hour, min, ampm);
        
    if (!modalAvailEdits[day] || !modalAvailEdits[day][idx]) return;
    
    if (type === 'start') {
        modalAvailEdits[day][idx][0] = decimal;
    } else {
        modalAvailEdits[day][idx][1] = decimal;
    }
    
    // Validate: end must be after start
    const [start, end] = modalAvailEdits[day][idx];
    if (end <= start) {
        if (type === 'start') {
            modalAvailEdits[day][idx][1] = Math.min(start + 0.25, state.endHour);
        } else {
            modalAvailEdits[day][idx][0] = Math.max(end - 0.25, state.startHour);
        }
        const emp = employeeMap[state.editingAvailability];
        if (emp) renderModalAvailabilityTable(emp);
        }
}

async function saveAvailability() {
    const empId = state.editingAvailability;
    if (!empId) return;
    
    // Convert modalAvailEdits ranges to individual hour slots
    const availability = [];
    
    for (const [dayStr, ranges] of Object.entries(modalAvailEdits)) {
        const day = parseInt(dayStr);
        ranges.forEach(([start, end]) => {
            for (let h = Math.floor(start); h < Math.ceil(end); h++) {
                availability.push({ day, hour: h });
        }
    });
    }
    
    try {
        const response = await fetch(getAvailabilityApiUrl(empId), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ availability, preferences: [], time_off: [] })
        });
        
        const data = await response.json();
        
        if (data.success) {
            // Update local state
            const emp = employeeMap[empId];
            if (emp) {
                emp.availability = availability;
                emp.preferences = [];
                emp.time_off = [];
            }
            
            closeAllModals();
            showToast('Availability saved', 'success');
        } else {
            showToast(data.message || 'Failed to save availability', 'error');
        }
    } catch (error) {
        showToast('Error saving availability', 'error');
    }
}

// ==================== PTO NOTIFICATION BELL (Header) ====================
let ptoNotificationState = {
    requests: [],
    isDropdownOpen: false
};

function initPTONotifications() {
    const bell = document.getElementById('ptoNotificationBell');
    const dropdown = document.getElementById('ptoNotificationDropdown');
    
    if (!bell || !dropdown) return;
    
    // Toggle dropdown on bell click
    bell.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePTODropdown();
    });
    
    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!dropdown.contains(e.target) && !bell.contains(e.target)) {
            closePTODropdown();
        }
    });
    
    // Close on escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closePTODropdown();
        }
    });
    
    // Load initial PTO requests
    loadPTONotifications();
    
    // Refresh PTO notifications periodically (every 60 seconds)
    setInterval(loadPTONotifications, 60000);
}

function togglePTODropdown() {
    const dropdown = document.getElementById('ptoNotificationDropdown');
    if (!dropdown) return;
    
    if (ptoNotificationState.isDropdownOpen) {
        closePTODropdown();
    } else {
        openPTODropdown();
    }
}

function openPTODropdown() {
    const dropdown = document.getElementById('ptoNotificationDropdown');
    if (!dropdown) return;
    
    dropdown.classList.add('visible');
    ptoNotificationState.isDropdownOpen = true;
    
    // Reload requests when opening
    loadPTONotifications();
}

function closePTODropdown() {
    const dropdown = document.getElementById('ptoNotificationDropdown');
    if (!dropdown) return;
    
    dropdown.classList.remove('visible');
    ptoNotificationState.isDropdownOpen = false;
}

async function loadPTONotifications() {
    const list = document.getElementById('ptoNotificationList');
    const badge = document.getElementById('ptoNotificationBadge');
    const bell = document.getElementById('ptoNotificationBell');
    
    if (!list || !badge || !bell) return;
    
    try {
        const response = await fetch(`/api/${state.business.id}/pto?status=pending`);
        const data = await response.json();
        
        if (data.success) {
            ptoNotificationState.requests = data.pto_requests || [];
            renderPTONotifications();
        }
    } catch (error) {
        console.error('Error loading PTO notifications:', error);
        list.innerHTML = '<div class="pto-loading">Failed to load</div>';
    }
}

function renderPTONotifications() {
    const list = document.getElementById('ptoNotificationList');
    const badge = document.getElementById('ptoNotificationBadge');
    const bell = document.getElementById('ptoNotificationBell');
    
    if (!list || !badge || !bell) return;
    
    const requests = ptoNotificationState.requests;
    const pendingCount = requests.length;
    
    // Update badge
    if (pendingCount > 0) {
        badge.textContent = pendingCount > 99 ? '99+' : pendingCount;
        bell.classList.add('has-notifications');
    } else {
        badge.textContent = '';
        bell.classList.remove('has-notifications');
    }
    
    // Render list
    if (requests.length === 0) {
        list.innerHTML = `
            <div class="pto-empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <path d="M8 15h8M9 9h.01M15 9h.01"></path>
                </svg>
                <p>No pending requests</p>
            </div>
        `;
        return;
    }
    
    list.innerHTML = requests.map(req => {
        const startDate = new Date(req.start_date).toLocaleDateString('en-US', { 
            month: 'short', day: 'numeric' 
        });
        const endDate = new Date(req.end_date).toLocaleDateString('en-US', { 
            month: 'short', day: 'numeric', year: 'numeric' 
        });
        const dateRange = req.start_date === req.end_date 
            ? startDate 
            : `${startDate} - ${endDate}`;
        
        const typeEmoji = {
            'vacation': '🌴',
            'sick': '🤒',
            'personal': '👤',
            'other': '📋'
        }[req.pto_type] || '📅';
        
        const typeName = (req.pto_type || 'other').charAt(0).toUpperCase() + (req.pto_type || 'other').slice(1);
        
        return `
            <div class="pto-notification-item" data-request-id="${req.id}">
                <div class="pto-notification-item-header">
                    <span class="pto-notification-employee">${req.employee_name || 'Employee'}</span>
                    <span class="pto-notification-type">${typeEmoji} ${typeName}</span>
                </div>
                <div class="pto-notification-dates">${dateRange}</div>
                <div class="pto-notification-actions">
                    <button class="pto-approve-btn" onclick="approvePTOFromNotification('${req.id}')">
                        ✓ Approve
                    </button>
                    <button class="pto-deny-btn" onclick="denyPTOFromNotification('${req.id}')">
                        ✕ Deny
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

async function approvePTOFromNotification(requestId) {
    try {
        const response = await fetch(`/api/${state.business.id}/pto/${requestId}/approve`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        
        const data = await response.json();
        
        if (data.success) {
            // Show appropriate message based on whether shifts were removed
            if (data.shifts_removed && data.shifts_removed > 0) {
                showToast(`Time off approved. ${data.shifts_removed} shift(s) removed from schedule.`, 'warning');
            } else {
            showToast('Time off request approved', 'success');
            }
            
            loadPTONotifications();
            
            // Reload the schedule to show updated data (shifts removed, time off visible)
            await loadApprovedPTOForWeek();
            await loadScheduleData(true);
            
            // Also reload if we're in the availability modal
            if (currentPTOEmployeeId) {
                loadEmployeePTORequests(currentPTOEmployeeId);
            }
        } else {
            showToast(data.error || 'Failed to approve request', 'error');
        }
    } catch (error) {
        console.error('Error approving PTO:', error);
        showToast('Failed to approve request', 'error');
    }
}

async function denyPTOFromNotification(requestId) {
    const note = prompt('Add a reason for denying (optional):');
    
    try {
        const response = await fetch(`/api/${state.business.id}/pto/${requestId}/deny`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: note || '' })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast('Time off request denied', 'success');
            loadPTONotifications();
            // Also reload if we're in the availability modal
            if (currentPTOEmployeeId) {
                loadEmployeePTORequests(currentPTOEmployeeId);
            }
        } else {
            showToast(data.error || 'Failed to deny request', 'error');
        }
    } catch (error) {
        console.error('Error denying PTO:', error);
        showToast('Failed to deny request', 'error');
    }
}

// ==================== PTO REQUEST MANAGEMENT (Manager View) ====================
let currentPTOEmployeeId = null;

async function loadEmployeePTORequests(empId) {
    currentPTOEmployeeId = empId;
    const container = document.getElementById('managerPTOList');
    if (!container) return;
    
    container.innerHTML = '<div class="pto-loading">Loading requests...</div>';
    
    // Find the employee's db_id - we need to find it from the employee data
    const emp = employeeMap[empId];
    if (!emp) {
        container.innerHTML = '<div class="manager-pto-empty">Employee not found</div>';
        return;
    }
    
    try {
        // Get PTO requests for this employee
        const response = await fetch(`/api/${state.business.id}/pto?employee_id=${empId}`);
        const data = await response.json();
        
        if (data.success) {
            renderManagerPTOList(data.pto_requests);
        } else {
            container.innerHTML = '<div class="manager-pto-empty">Failed to load requests</div>';
        }
    } catch (error) {
        console.error('Error loading PTO requests:', error);
        container.innerHTML = '<div class="manager-pto-empty">Failed to load requests</div>';
    }
}

function renderManagerPTOList(requests) {
    const container = document.getElementById('managerPTOList');
    const badge = document.getElementById('ptoPendingBadge');
    if (!container) return;
    
    // Filter out cancelled requests
    const visibleRequests = requests.filter(req => req.status !== 'cancelled');
    const pendingCount = visibleRequests.filter(req => req.status === 'pending').length;
    
    // Update badge
    if (badge) {
        if (pendingCount > 0) {
            badge.textContent = pendingCount;
            badge.style.display = 'inline-flex';
        } else {
            badge.style.display = 'none';
        }
    }
    
    if (visibleRequests.length === 0) {
        container.innerHTML = `
            <div class="manager-pto-empty">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                    <line x1="16" y1="2" x2="16" y2="6"></line>
                    <line x1="8" y1="2" x2="8" y2="6"></line>
                    <line x1="3" y1="10" x2="21" y2="10"></line>
                </svg>
                No time off requests
            </div>
        `;
        return;
    }
    
    // Sort: pending first, then by date
    visibleRequests.sort((a, b) => {
        if (a.status === 'pending' && b.status !== 'pending') return -1;
        if (a.status !== 'pending' && b.status === 'pending') return 1;
        return new Date(b.created_at) - new Date(a.created_at);
    });
    
    let html = '';
    visibleRequests.forEach(req => {
        const statusIcon = getPTOStatusIcon(req.status);
        const typeEmoji = getPTOTypeEmoji(req.pto_type);
        const dateRange = formatPTODateRange(req.start_date, req.end_date);
        
        html += `
            <div class="manager-pto-item ${req.status}">
                <div class="manager-pto-icon">${statusIcon}</div>
                <div class="manager-pto-info">
                    <div class="manager-pto-dates">${dateRange}</div>
                    <div class="manager-pto-meta">
                        <span class="manager-pto-type">${typeEmoji} ${capitalizeFirst(req.pto_type)}</span>
                        <span class="manager-pto-status ${req.status}">${capitalizeFirst(req.status)}</span>
                    </div>
                    ${req.employee_note ? `<div class="manager-pto-note">"${req.employee_note}"</div>` : ''}
                </div>
                ${req.status === 'pending' ? `
                    <div class="manager-pto-actions">
                        <button class="btn-approve" onclick="approvePTORequest('${req.id}')">Approve</button>
                        <button class="btn-deny" onclick="denyPTORequest('${req.id}')">Deny</button>
                    </div>
                ` : ''}
            </div>
        `;
    });
    
    container.innerHTML = html;
}

function getPTOStatusIcon(status) {
    switch (status) {
        case 'pending': return '🟡';
        case 'approved': return '🟢';
        case 'denied': return '🔴';
        case 'cancelled': return '⚪';
        default: return '⚪';
    }
}

function getPTOTypeEmoji(type) {
    switch (type) {
        case 'vacation': return '🌴';
        case 'sick': return '🤒';
        case 'personal': return '👤';
        default: return '📋';
    }
}

function formatPTODateRange(startDate, endDate) {
    const start = new Date(startDate + 'T00:00:00');
    const end = new Date(endDate + 'T00:00:00');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    if (startDate === endDate) {
        return `${months[start.getMonth()]} ${start.getDate()}, ${start.getFullYear()}`;
    } else if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
        return `${months[start.getMonth()]} ${start.getDate()}-${end.getDate()}, ${start.getFullYear()}`;
    } else {
        return `${months[start.getMonth()]} ${start.getDate()} - ${months[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
    }
}

function capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

async function approvePTORequest(requestId) {
    try {
        const response = await fetch(`/api/${state.business.id}/pto/${requestId}/approve`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' }
        });
        
        const data = await response.json();
        
        if (data.success) {
            // Show appropriate message based on whether shifts were removed
            if (data.shifts_removed && data.shifts_removed > 0) {
                showToast(`Time off approved. ${data.shifts_removed} shift(s) removed from schedule.`, 'warning');
            } else {
            showToast('Time off request approved', 'success');
            }
            
            // Reload the PTO list
            if (currentPTOEmployeeId) {
                loadEmployeePTORequests(currentPTOEmployeeId);
            }
            
            // Reload the schedule to show updated data
            await loadApprovedPTOForWeek();
            await loadScheduleData(true);
        } else {
            showToast(data.error || 'Failed to approve request', 'error');
        }
    } catch (error) {
        console.error('Error approving PTO request:', error);
        showToast('Failed to approve request', 'error');
    }
}

async function denyPTORequest(requestId) {
    const note = prompt('Reason for denial (optional):');
    
    try {
        const response = await fetch(`/api/${state.business.id}/pto/${requestId}/deny`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: note || '' })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast('Time off request denied', 'success');
            // Reload the PTO list
            if (currentPTOEmployeeId) {
                loadEmployeePTORequests(currentPTOEmployeeId);
            }
        } else {
            showToast(data.error || 'Failed to deny request', 'error');
        }
    } catch (error) {
        console.error('Error denying PTO request:', error);
        showToast('Failed to deny request', 'error');
    }
}

// ==================== AVAILABILITY PAGE ====================
let selectedAvailabilityEmpId = null;
let availabilitySearchTerm = '';
let availabilityRoleFilter = '';
let availabilityTypeFilter = '';

function initAvailabilityFilters() {
    const searchInput = document.getElementById('availabilitySearch');
    const roleSelect = document.getElementById('availabilityRoleFilter');
    const typeSelect = document.getElementById('availabilityTypeFilter');
    
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            availabilitySearchTerm = e.target.value.toLowerCase().trim();
            renderAvailabilityPage();
        });
    }
    
    if (roleSelect) {
        roleSelect.addEventListener('change', (e) => {
            availabilityRoleFilter = e.target.value;
            renderAvailabilityPage();
        });
    }

    if (typeSelect) {
        typeSelect.addEventListener('change', (e) => {
            availabilityTypeFilter = e.target.value;
            renderAvailabilityPage();
        });
    }
}

function populateAvailabilityRoleFilter() {
    const roleSelect = document.getElementById('availabilityRoleFilter');
    if (!roleSelect) return;
    
    // Build unique role list ONLY from state.roles (current business roles)
    const roles = [...state.roles]
        .map(role => ({ id: role.id.toString(), name: role.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
    
    // Clear existing options except "All Roles"
    roleSelect.innerHTML = '<option value="">All Roles</option>';
    
    roles.forEach(role => {
        const option = document.createElement('option');
        option.value = role.id;
        option.textContent = role.name;
        roleSelect.appendChild(option);
    });
    
    // Restore selected value if it still exists
    const roleIds = roles.map(r => r.id);
    if (availabilityRoleFilter && roleIds.includes(availabilityRoleFilter.toString())) {
        roleSelect.value = availabilityRoleFilter;
    } else {
        availabilityRoleFilter = '';
        roleSelect.value = '';
    }
}

function populateAvailabilityTypeFilter() {
    const typeSelect = document.getElementById('availabilityTypeFilter');
    if (!typeSelect) return;
    const allowed = ['', 'full_time', 'part_time'];
    if (!allowed.includes(availabilityTypeFilter)) {
        availabilityTypeFilter = '';
    }
    typeSelect.value = availabilityTypeFilter || '';
}

function renderAvailabilityPage() {
    const staffList = document.getElementById('availabilityStaffList');
    if (!staffList) return;
    
    staffList.innerHTML = '';
    
    // Populate role filter dropdown
    populateAvailabilityRoleFilter();
    populateAvailabilityTypeFilter();
    
    // Sort employees by name
    let sorted = [...state.employees].sort((a, b) => a.name.localeCompare(b.name));
    
    // Apply search filter
    if (availabilitySearchTerm) {
        sorted = sorted.filter(emp => 
            emp.name.toLowerCase().includes(availabilitySearchTerm)
        );
    }
    
    // Apply role filter
    if (availabilityRoleFilter) {
        const filterId = availabilityRoleFilter.toString();
        sorted = sorted.filter(emp => 
            emp.roles && emp.roles.map(r => r.toString()).includes(filterId)
        );
    }
    
    // Apply type filter (full time / part time)
    if (availabilityTypeFilter) {
        sorted = sorted.filter(emp => emp.classification === availabilityTypeFilter);
    }
    
    // Show "no results" message if empty
    if (sorted.length === 0) {
        staffList.innerHTML = `
            <div class="avail-no-results">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"></circle>
                    <path d="m21 21-4.35-4.35"></path>
                </svg>
                <p>No staff found</p>
            </div>
        `;
        return;
    }
    
    sorted.forEach(emp => {
        const availHours = calculateAvailableHours(emp);
        const initials = emp.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
        const isSelected = selectedAvailabilityEmpId === emp.id;
        
        // Get role names for display
        const roleNames = emp.roles && emp.roles.length > 0 
            ? emp.roles.map(rid => roleMap[rid]?.name || rid).join(', ')
            : 'No role';
        
        const item = document.createElement('div');
        item.className = `avail-staff-item${isSelected ? ' selected' : ''}`;
        item.dataset.id = emp.id;
        const flags = [];
        if (emp.can_supervise) flags.push('Supervisor');
        if (emp.needs_supervision) flags.push('New hire');
        item.innerHTML = `
            <div class="avail-staff-avatar" style="background: ${escHtml(emp.color || '#467df6')}">${escHtml(initials)}</div>
            <div class="avail-staff-info">
                <div class="avail-staff-name">${escHtml(emp.name)}</div>
                <div class="avail-staff-roles">${roleBadgesHtml(emp) || '<span class="avail-staff-role">No roles yet</span>'}</div>
                <div class="avail-staff-meta">
                    <span class="avail-meta-pill ${emp.classification === 'full_time' ? 'pill-ft' : 'pill-pt'}">${emp.classification === 'full_time' ? 'Full-time' : 'Part-time'}</span>
                    <span class="avail-meta-text">${emp.min_hours}–${emp.max_hours} hrs/week</span>
                    ${flags.map(f => `<span class="avail-meta-text">· ${f}</span>`).join('')}
                </div>
                <div class="avail-staff-hours">${availHours} hours available</div>
            </div>
        `;
        
        item.addEventListener('click', () => selectAvailabilityEmployee(emp.id));
        staffList.appendChild(item);
    });
    
    // If we have a selected employee, show their availability
    if (selectedAvailabilityEmpId) {
        showAvailabilityPanel(selectedAvailabilityEmpId);
    }
}

function calculateAvailableHours(emp) {
    // Count unique hours in availability
    const uniqueSlots = new Set();
    emp.availability.forEach(slot => {
        uniqueSlots.add(`${slot.day}-${slot.hour}`);
    });
    return uniqueSlots.size;
}

function selectAvailabilityEmployee(empId) {
    selectedAvailabilityEmpId = empId;
    
    // Update selection UI
    document.querySelectorAll('.avail-staff-item').forEach(item => {
        item.classList.toggle('selected', item.dataset.id === empId);
    });
    
    showAvailabilityPanel(empId);
}

let currentAvailEmpId = null;

function showAvailabilityPanel(empId) {
    const emp = employeeMap[empId];
    if (!emp) return;
    
    currentAvailEmpId = empId;
    
    const emptyPanel = document.getElementById('availabilityPanelEmpty');
    const contentPanel = document.getElementById('availabilityPanelContent');
    
    emptyPanel.style.display = 'none';
    contentPanel.style.display = 'block';
    
    // Update header
    const initials = emp.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
    document.getElementById('availPanelAvatar').textContent = initials;
    document.getElementById('availPanelAvatar').style.background = emp.color || '#467df6';
    document.getElementById('availPanelName').textContent = emp.name;
    
    const availHours = calculateAvailableHours(emp);
    const roleNames = (emp.roles || []).map(r => roleMap[r]?.name || r).join(', ') || 'No roles yet';
    document.getElementById('availPanelHours').textContent = `${roleNames} · ${availHours} hours available per week`;

    // Edit / delete this person right here
    const editBtn = document.getElementById('availEditEmpBtn');
    if (editBtn) editBtn.onclick = () => openEmployeeForm(empId);
    const editBtnFull = document.getElementById('availEditEmpBtnFull');
    if (editBtnFull) editBtnFull.onclick = () => openEmployeeForm(empId);
    const deleteBtn = document.getElementById('availDeleteEmpBtn');
    if (deleteBtn) deleteBtn.onclick = () => confirmDeleteEmployee(empId);

    // Rules and info card (spelled out, no abbreviations)
    const details = document.getElementById('availPanelDetails');
    if (details) details.innerHTML = buildEmployeeDetailHtml(emp, { availability: false, rules: true });

    // Render table view
    renderManagerAvailabilityTable(emp);
}

function navigateToStaffAndEdit(empId) {
    // The Staff page lives inside Staff Availability now: open the editor directly.
    openEmployeeForm(empId);
}

// Store manager availability edits in progress
let managerAvailEdits = {};
let managerAvailEditsEmpId = null;

function renderManagerAvailabilityTable(emp) {
    console.log('[ManagerAvail] renderManagerAvailabilityTable called');
    const container = document.getElementById('managerAvailTableView');
    if (!container) {
        console.log('[ManagerAvail] Container not found in render!');
        return;
    }
    
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    // Convert display day index to data day (our data uses Mon=0, Sun=6)
    const toDataDay = (displayDay) => displayDay === 0 ? 6 : displayDay - 1;
    
    // Initialize edits from current availability only when switching employees or if not yet initialized
    const shouldInitialize = managerAvailEditsEmpId !== emp.id || 
                             !managerAvailEdits || 
                             Object.keys(managerAvailEdits).length === 0;

    if (shouldInitialize) {
        console.log('[ManagerAvail] Initializing managerAvailEdits for emp:', emp.id);
        console.log('[ManagerAvail] Raw emp.availability_ranges:', JSON.stringify(emp.availability_ranges));
        managerAvailEdits = {};
        
        // Normalize availability_ranges keys to integers if they are strings
        if (emp.availability_ranges) {
            const normalized = {};
            Object.entries(emp.availability_ranges).forEach(([day, ranges]) => {
                normalized[parseInt(day)] = ranges;
            });
            emp.availability_ranges = normalized;
            console.log('[ManagerAvail] Normalized availability_ranges:', JSON.stringify(emp.availability_ranges));
        }

        for (let d = 0; d < 7; d++) {
            const dataDay = toDataDay(d);
            console.log(`[ManagerAvail] Display day ${d} (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]}) -> Data day ${dataDay}`);
            managerAvailEdits[dataDay] = getAvailabilityRangesForDay(emp, dataDay);
            // If no availability, start with empty array
            if (managerAvailEdits[dataDay].length === 0) {
                managerAvailEdits[dataDay] = [];
            }
        }
        managerAvailEditsEmpId = emp.id;
    }
    
    let html = '';
    for (let d = 0; d < 7; d++) {
        const dataDay = toDataDay(d);
        const ranges = managerAvailEdits[dataDay];
        
        html += `<div class="avail-day-row" data-day="${dataDay}" data-display-day="${d}">
            <div class="avail-day-name">${dayNames[d]}</div>
            <div class="avail-day-times">`;
        
        if (ranges.length > 0) {
            ranges.forEach((range, idx) => {
                html += renderManagerTimeRange(dataDay, idx, range[0], range[1]);
            });
        } else {
            html += `<div class="avail-unavailable-text">Unavailable</div>`;
        }
        
        html += `</div>
            <button class="avail-add-btn" data-day="${dataDay}" title="Add time slot">+</button>
        </div>`;
    }
    
    container.innerHTML = html;
    setupManagerAvailTableListeners(emp);
}

function renderManagerTimeRange(dataDay, idx, startHour, endHour) {
    const startParts = decimalToTimeParts(startHour);
    const endParts = decimalToTimeParts(endHour);
    
    return `
        <div class="avail-time-row" data-day="${dataDay}" data-idx="${idx}">
            <button class="avail-remove-row-btn" data-day="${dataDay}" data-idx="${idx}" title="Remove">−</button>
            ${renderManagerTimeInput('start', dataDay, idx, startParts)}
            <span class="avail-time-sep">to</span>
            ${renderManagerTimeInput('end', dataDay, idx, endParts)}
        </div>`;
}

function renderManagerTimeInput(type, day, idx, parts) {
    const hours = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const mins = ['00', '15', '30', '45'];
    const ampms = ['AM', 'PM'];
    
    return `
        <div class="time-input-group manager-time-input" data-type="${type}" data-day="${day}" data-idx="${idx}">
            <div class="custom-select" data-field="hour" data-value="${parts.hour}">
                <span class="custom-select-value">${parts.hour}</span>
                <div class="custom-select-dropdown">
                    ${hours.map(h => `<div class="custom-select-option ${h === parts.hour ? 'selected' : ''}" data-value="${h}">${h}</div>`).join('')}
                </div>
            </div>
            <span class="time-colon">:</span>
            <div class="custom-select" data-field="min" data-value="${parts.min}">
                <span class="custom-select-value">${parts.min}</span>
                <div class="custom-select-dropdown">
                    ${mins.map(m => `<div class="custom-select-option ${m === parts.min ? 'selected' : ''}" data-value="${m}">${m}</div>`).join('')}
                </div>
            </div>
            <div class="custom-select time-ampm-select" data-field="ampm" data-value="${parts.ampm}">
                <span class="custom-select-value">${parts.ampm.toUpperCase()}</span>
                <div class="custom-select-dropdown">
                    ${ampms.map(a => `<div class="custom-select-option ${a.toLowerCase() === parts.ampm ? 'selected' : ''}" data-value="${a.toLowerCase()}">${a}</div>`).join('')}
                </div>
            </div>
        </div>
    `;
}

function decimalToTimeParts(decimal) {
    const hour24 = Math.floor(decimal);
    const mins = Math.round((decimal - hour24) * 60);
    const hour12 = hour24 > 12 ? hour24 - 12 : (hour24 === 0 ? 12 : hour24);
    const ampm = hour24 >= 12 ? 'pm' : 'am';
    return { hour: hour12, min: mins.toString().padStart(2, '0'), ampm };
}

function timePartsToDecimalManager(hour, min, ampm) {
    let hour24 = parseInt(hour);
    if (ampm === 'pm' && hour24 !== 12) hour24 += 12;
    if (ampm === 'am' && hour24 === 12) hour24 = 0;
    return hour24 + parseInt(min) / 60;
}

function setupManagerAvailTableListeners(emp) {
    const container = document.getElementById('managerAvailTableView');
    if (!container) return;
    
    // Remove button - attach directly to each button
    container.querySelectorAll('.avail-remove-row-btn').forEach(btn => {
        btn.onclick = function(e) {
            e.preventDefault();
            e.stopPropagation();
            const dataDay = parseInt(this.dataset.day);
            const idx = parseInt(this.dataset.idx);
            
            if (managerAvailEdits[dataDay]) {
                managerAvailEdits[dataDay].splice(idx, 1);
                renderManagerAvailabilityTable(emp);
            }
        };
    });
    
    // Add button
    container.querySelectorAll('.avail-add-btn').forEach(btn => {
        btn.onclick = function(e) {
            e.preventDefault();
            const dataDay = parseInt(this.dataset.day);
            if (!managerAvailEdits[dataDay]) {
                managerAvailEdits[dataDay] = [];
            }
            // Use business hours for default if available, otherwise 9-5
            const start = state.business ? state.business.start_hour : 9;
            const end = state.business ? state.business.end_hour : 17;
            managerAvailEdits[dataDay].push([start, end]);
            renderManagerAvailabilityTable(emp);
        };
    });
    
    // Custom dropdown handlers
    container.querySelectorAll('.custom-select').forEach(select => {
        const valueEl = select.querySelector('.custom-select-value');
        const dropdown = select.querySelector('.custom-select-dropdown');
        const field = select.dataset.field; // 'hour', 'min', or 'ampm'
        
        // Make focusable for keyboard input
        select.setAttribute('tabindex', '0');
        
        valueEl.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.custom-select.open').forEach(s => {
                if (s !== select) s.classList.remove('open');
            });
            select.classList.toggle('open');
            select.focus();
        });
        
        // Keyboard input support
        let keyBuffer = '';
        let keyBufferTimeout = null;
        
        select.addEventListener('keydown', (e) => {
            e.stopPropagation();
            
            // Handle AM/PM toggle
            if (field === 'ampm') {
                if (e.key.toLowerCase() === 'a') {
                    selectDropdownOption(select, 'am', emp);
                    return;
                } else if (e.key.toLowerCase() === 'p') {
                    selectDropdownOption(select, 'pm', emp);
                    return;
                }
            }
            
            // Handle number input for hours/minutes
            if (/^[0-9]$/.test(e.key)) {
                e.preventDefault();
                clearTimeout(keyBufferTimeout);
                keyBuffer += e.key;
                
                if (field === 'hour') {
                    // Hours: 1-12
                    const num = parseInt(keyBuffer);
                    if (keyBuffer.length === 1) {
                        // Single digit: 2-9 select immediately, 1 waits for potential 10-12
                        if (num >= 2 && num <= 9) {
                            selectDropdownOption(select, num.toString(), emp);
                            keyBuffer = '';
                            return;
                        }
                        // 1 could be 1, 10, 11, or 12 - wait for more input
                        keyBufferTimeout = setTimeout(() => {
                            if (keyBuffer === '1') {
                                selectDropdownOption(select, '1', emp);
                            }
                            keyBuffer = '';
                        }, 800);
                    } else if (keyBuffer.length >= 2) {
                        // Two digits: try to match 10, 11, or 12
                        if (num >= 10 && num <= 12) {
                            selectDropdownOption(select, num.toString(), emp);
                        } else if (keyBuffer[1] >= '0' && keyBuffer[1] <= '2') {
                            // Invalid like "13" - take just second digit if valid
                            selectDropdownOption(select, '1', emp);
                        }
                        keyBuffer = '';
                    }
                } else if (field === 'min') {
                    // Minutes: 00, 15, 30, 45
                    const validMins = ['00', '15', '30', '45'];
                    if (keyBuffer.length === 1) {
                        // Single digit starting with 0, 1, 3, or 4
                        if (e.key === '0') {
                            selectDropdownOption(select, '00', emp);
                            keyBuffer = '';
                            return;
                        }
                        keyBufferTimeout = setTimeout(() => {
                            // Match closest
                            if (keyBuffer === '1') selectDropdownOption(select, '15', emp);
                            else if (keyBuffer === '3') selectDropdownOption(select, '30', emp);
                            else if (keyBuffer === '4') selectDropdownOption(select, '45', emp);
                            keyBuffer = '';
                        }, 500);
                    } else {
                        const match = validMins.find(m => m === keyBuffer || m.startsWith(keyBuffer));
                        if (match) {
                            selectDropdownOption(select, match, emp);
                        }
                        keyBuffer = '';
                    }
                }
            }
            
            // Enter/Space to toggle dropdown
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                select.classList.toggle('open');
            }
            
            // Escape to close
            if (e.key === 'Escape') {
                select.classList.remove('open');
            }
            
            // Tab to move to next field
            if (e.key === 'Tab' && !e.shiftKey) {
                select.classList.remove('open');
            }
        });
        
        dropdown.querySelectorAll('.custom-select-option').forEach(option => {
            option.addEventListener('click', (e) => {
                e.stopPropagation();
                selectDropdownOption(select, option.dataset.value, emp);
            });
        });
    });
    
    // Close dropdowns when clicking outside
    document.addEventListener('click', () => {
        document.querySelectorAll('.custom-select.open').forEach(s => s.classList.remove('open'));
    });
}

function selectDropdownOption(select, value, emp) {
    const valueEl = select.querySelector('.custom-select-value');
    const dropdown = select.querySelector('.custom-select-dropdown');
    const option = dropdown.querySelector(`[data-value="${value}"]`);
    
    if (!option) return;
    
    select.dataset.value = value;
    valueEl.textContent = option.textContent;
    dropdown.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
    option.classList.add('selected');
    select.classList.remove('open');
    
    const inputGroup = select.closest('.time-input-group');
    if (inputGroup) {
        updateManagerTimeFromInputs(inputGroup, emp);
    }
}

function updateManagerTimeFromInputs(inputGroup, emp) {
    const type = inputGroup.dataset.type;
    const dataDay = parseInt(inputGroup.dataset.day);
    const idx = parseInt(inputGroup.dataset.idx);
    
    const hour = inputGroup.querySelector('[data-field="hour"]').dataset.value;
    const min = inputGroup.querySelector('[data-field="min"]').dataset.value;
    const ampm = inputGroup.querySelector('[data-field="ampm"]').dataset.value;
    
    const decimal = timePartsToDecimalManager(hour, min, ampm);
            
    // Check for both string and number keys
    let dayEdits = managerAvailEdits[dataDay] || managerAvailEdits[dataDay.toString()];
    if (!dayEdits || !dayEdits[idx]) return;
    
    // Ensure it's stored under the numeric key for consistency
    managerAvailEdits[dataDay] = dayEdits;
    
    if (type === 'start') {
        dayEdits[idx][0] = decimal;
    } else {
        dayEdits[idx][1] = decimal;
    }
    
    // Validate: end must be after start
    const [start, end] = dayEdits[idx];
    if (end <= start) {
        if (type === 'start') {
            managerAvailEdits[dataDay][idx][1] = Math.min(start + 0.25, state.endHour);
        } else {
            managerAvailEdits[dataDay][idx][0] = Math.max(end - 0.25, state.startHour);
        }
        renderManagerAvailabilityTable(emp);
            }
            
    // Don't auto-save - user must click Save button
}

async function saveSettingsAvailability() {
    const emp = employeeMap[currentAvailEmpId];
    if (!emp) {
        showToast('No employee selected', 'error');
        return;
    }
    
    // Use the model ID (e.g., "emp_abc123") with the manager API endpoint
    // which accepts range-based availability format
    
    try {
        const response = await fetch(getAvailabilityApiUrl(emp.id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                availability: managerAvailEdits 
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            // Update local employee data with the returned availability
            if (data.employee) {
                // Update the entire employee object to get the latest ranges
                Object.assign(emp, data.employee);
                
                // Normalize keys in the newly received availability_ranges
                if (emp.availability_ranges) {
                    const normalized = {};
                    Object.entries(emp.availability_ranges).forEach(([day, ranges]) => {
                        normalized[parseInt(day)] = ranges;
                    });
                    emp.availability_ranges = normalized;
                }
            } else {
                // Fallback if data.employee is missing
                // Convert ranges back to slots for compatibility
                const availabilitySlots = [];
                for (const [dayStr, ranges] of Object.entries(data.availability || managerAvailEdits)) {
                    const day = parseInt(dayStr);
                    ranges.forEach(([start, end]) => {
                        // Store slots for each hour in the range
                        for (let h = Math.floor(start); h < Math.ceil(end); h++) {
                            availabilitySlots.push({ day, hour: h });
                        }
                    });
                }
                emp.availability = availabilitySlots;
            }
            
            // Update hours display
            const availHours = calculateAvailableHoursFromRanges(managerAvailEdits);
            document.getElementById('availPanelHours').textContent = `${availHours} hours/week available`;
            updateSidebarHours(emp.id, availHours);
            
            showToast('Availability saved', 'success');
        } else {
            showToast(data.message || 'Failed to save availability', 'error');
        }
    } catch (error) {
        console.error('Failed to save availability:', error);
        showToast('Error saving availability', 'error');
    }
}

function calculateAvailableHoursFromRanges(rangesObj) {
    let totalHours = 0;
    for (const ranges of Object.values(rangesObj)) {
        for (const [start, end] of ranges) {
            totalHours += (end - start);
        }
    }
    return Math.round(totalHours * 10) / 10; // Round to 1 decimal
}

function getAvailabilityRangesForDay(emp, dataDay) {
    // First, check if we have availability_ranges (new format with 15-min precision)
    // Handle both string and number keys
    const ranges = emp.availability_ranges ? (emp.availability_ranges[dataDay] || emp.availability_ranges[dataDay.toString()]) : null;
    
    console.log(`[ManagerAvail] getAvailabilityRangesForDay: emp=${emp.name}, dataDay=${dataDay}, ranges=`, ranges);
    
    if (ranges) {
        // availability_ranges is { day: [[start, end], ...] }
        return ranges.map(r => [r[0], r[1]]);
    }
    
    // Fall back to converting from slot-based availability
    const slots = emp.availability.filter(s => s.day === dataDay).map(s => s.hour);
    if (slots.length === 0) return [];
    
    // Sort and group into ranges
    slots.sort((a, b) => a - b);
    const groupedRanges = [];
    let start = slots[0];
    let end = slots[0] + 1;
    
    for (let i = 1; i < slots.length; i++) {
        if (slots[i] === end) {
            end = slots[i] + 1;
        } else {
            groupedRanges.push([start, end]);
            start = slots[i];
            end = slots[i] + 1;
        }
    }
    groupedRanges.push([start, end]);
    
    return groupedRanges;
}

function formatDecimalTime(decimal) {
    const hour24 = Math.floor(decimal);
    const mins = Math.round((decimal - hour24) * 60);
    const hour12 = hour24 > 12 ? hour24 - 12 : (hour24 === 0 ? 12 : hour24);
    const ampm = hour24 >= 12 ? 'PM' : 'AM';
    
    if (mins === 0) {
        return `${hour12}${ampm}`;
    }
    return `${hour12}:${mins.toString().padStart(2, '0')}${ampm}`;
}

function calculateAvailableHoursFromGrid() {
    const cells = document.querySelectorAll('#availabilityTableBody .avail-cell');
    let count = 0;
    cells.forEach(cell => {
        if (cell.classList.contains('available')) {
            count++;
        }
    });
    return count;
}

function updateSidebarHours(empId, hours) {
    const item = document.querySelector(`.avail-staff-item[data-id="${empId}"]`);
    if (item) {
        const hoursEl = item.querySelector('.avail-staff-hours');
        if (hoursEl) {
            hoursEl.textContent = `${hours} hrs/week available`;
        }
    }
}

function setupAvailabilityPresets(emp) {
    const presetBtns = document.querySelectorAll('.preset-btn');
    presetBtns.forEach(btn => {
        // Remove old listeners by cloning
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        
        newBtn.addEventListener('click', () => applyAvailabilityPreset(emp.id, newBtn.dataset.preset));
    });
}

async function applyAvailabilityPreset(empId, preset) {
    // Confirm before clearing all
    if (preset === 'clear') {
        document.getElementById('confirmTitle').textContent = 'Clear Availability';
        document.getElementById('confirmMessage').textContent = 'Are you sure you want to clear all availability for this employee?';
        document.getElementById('confirmBtn').textContent = 'Clear All';
        document.getElementById('confirmBtn').className = 'btn btn-danger';
        document.getElementById('confirmBtn').dataset.action = 'clearAvailability';
        document.getElementById('confirmBtn').dataset.id = empId;
        openModal('confirmModal');
        return;
    }
    
    const tbody = document.getElementById('availabilityTableBody');
    const cells = tbody.querySelectorAll('.avail-cell');
    
    // Clear all first
    cells.forEach(cell => {
        cell.classList.remove('available');
    });
    
    if (preset === 'all-9-5') {
        // Mon-Sun 9-5
        cells.forEach(cell => {
            const hour = parseInt(cell.dataset.hour);
            if (hour >= 9 && hour < 17) {
                cell.classList.add('available');
            }
        });
    } else if (preset === 'weekdays-9-5') {
        // Mon-Fri 9-5 (data days 0-4)
        cells.forEach(cell => {
            const day = parseInt(cell.dataset.day);
            const hour = parseInt(cell.dataset.hour);
            if (day >= 0 && day <= 4 && hour >= 9 && hour < 17) {
                cell.classList.add('available');
            }
        });
    } else if (preset === 'weekends-9-5') {
        // Sat-Sun 9-5 (data days 5, 6)
        cells.forEach(cell => {
            const day = parseInt(cell.dataset.day);
            const hour = parseInt(cell.dataset.hour);
            if ((day === 5 || day === 6) && hour >= 9 && hour < 17) {
                cell.classList.add('available');
            }
        });
    }
    
    // Save all changes
    await saveFullAvailability(empId);
    
    // Update hours display
    const availHours = calculateAvailableHoursFromGrid();
    document.getElementById('availPanelHours').textContent = `${availHours} hours/week available`;
    updateSidebarHours(empId, availHours);
    
    showToast(`Applied ${preset.replace(/-/g, ' ')} preset`, 'success');
}

async function executeClearAvailability(empId) {
    const tbody = document.getElementById('availabilityTableBody');
    const cells = tbody.querySelectorAll('.avail-cell');
    
    // Clear all cells
    cells.forEach(cell => {
        cell.classList.remove('available');
    });
    
    // Save all changes
    await saveFullAvailability(empId);
    
    // Update hours display
    const availHours = calculateAvailableHoursFromGrid();
    const hoursEl = document.getElementById('availPanelHours');
    if (hoursEl) {
        hoursEl.textContent = `${availHours} hours/week available`;
    }
    updateSidebarHours(empId, availHours);
    
    showToast('Availability cleared', 'success');
}

async function saveFullAvailability(empId) {
    const tbody = document.getElementById('availabilityTableBody');
    const cells = tbody.querySelectorAll('.avail-cell');
    
    const availability = [];
    
    cells.forEach(cell => {
        const day = parseInt(cell.dataset.day);
        const hour = parseInt(cell.dataset.hour);
        
        if (cell.classList.contains('available')) {
            availability.push({ day, hour });
        }
    });
    
    try {
        const response = await fetch(getAvailabilityApiUrl(empId), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ availability, preferences: [], time_off: [] })
        });
        
        if (response.ok) {
            // Update local state
            const emp = employeeMap[empId];
            if (emp) {
                emp.availability = availability;
                emp.preferences = [];
                emp.time_off = [];
            }
        }
    } catch (error) {
        console.error('Error saving availability:', error);
    }
}

// ==================== SETTINGS TAB ====================
function setupSettingsTab() {
    if (dom.addRoleBtn) {
        dom.addRoleBtn.addEventListener('click', () => openRoleForm());
    }
    
    // Setup Requirements sub-tabs
    setupRequirementsSubTabs();
}

function setupRequirementsSubTabs() {
    const subTabs = document.querySelectorAll('.sub-tab');
    const subTabContents = document.querySelectorAll('.sub-tab-content');
    
    subTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetId = tab.dataset.subtab;
            
            // Update active tab
            subTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            
            // Update active content
            subTabContents.forEach(content => {
                content.classList.toggle('active', content.id === `subtab-${targetId}`);
            });
            
            // Re-render calendar if switching to shifts tab
            if (targetId === 'shifts') {
                requestAnimationFrame(() => {
                    renderShiftTemplates();
                });
            }
        });
    });
}

function formatHour(hour) {
    const wholeHour = Math.floor(hour);
    const minutes = Math.round((hour - wholeHour) * 60);
    const minuteStr = minutes > 0 ? `:${minutes.toString().padStart(2, '0')}` : '';
    
    if (wholeHour === 0) return `12${minuteStr}am`;
    if (wholeHour === 12) return `12${minuteStr}pm`;
    if (wholeHour < 12) return `${wholeHour}${minuteStr}am`;
    return `${wholeHour - 12}${minuteStr}pm`;
}

// ==================== ROLE COVERAGE ====================
function renderRoleCoverageEditor() {
    const container = document.getElementById('roleCoverageEditor');
    if (!container) return; // Element may not exist in new UI
    container.innerHTML = '';
    
    state.roles.forEach(role => {
        // Find existing config or create default
        let config = state.roleCoverageConfigs.find(c => c.role_id === role.id);
        if (!config) {
            config = {
                role_id: role.id,
                default_min_staff: 1,
                default_max_staff: 3,
                peak_boost: 0,
                required_hours: [],
                required_days: []
            };
        }
        
        const card = document.createElement('div');
        card.className = 'role-coverage-card';
        card.dataset.roleId = role.id;
        
        // Summary text
        let summary = `${config.default_min_staff} staff`;
        if (config.peak_boost > 0) {
            summary += ` (+${config.peak_boost} peak)`;
        }
        if (config.required_hours && config.required_hours.length > 0) {
            summary += ' • Custom hours';
        } else {
            summary += ' • All hours';
        }
        
        card.innerHTML = `
            <div class="role-coverage-header" onclick="toggleRoleCoverage('${role.id}')">
                <span class="role-color-swatch" style="background: ${role.color}"></span>
                <span class="role-coverage-title">${role.name}</span>
                <span class="role-coverage-summary">${summary}</span>
                <span class="role-coverage-expand">▼</span>
            </div>
            <div class="role-coverage-body">
                <div class="coverage-field">
                    <span class="coverage-field-label" data-tooltip="Minimum number of ${role.name}s needed during normal hours">Staff needed:</span>
                    <div class="coverage-field-input staff-number-range">
                        <input type="number" class="staff-number-input" id="min-staff-${role.id}" 
                               value="${config.default_min_staff}" min="0" max="10"
                               onchange="updateRoleCoverage('${role.id}')">
                        <span>to</span>
                        <input type="number" class="staff-number-input" id="max-staff-${role.id}" 
                               value="${config.default_max_staff}" min="1" max="20"
                               onchange="updateRoleCoverage('${role.id}')">
                        <span>people</span>
                    </div>
                </div>
                <div class="coverage-field">
                    <span class="coverage-field-label" data-tooltip="How many extra ${role.name}s to add during peak hours">Extra during peak:</span>
                    <div class="coverage-field-input">
                        <select id="peak-boost-${role.id}" onchange="updateRoleCoverage('${role.id}')">
                            <option value="0" ${config.peak_boost === 0 ? 'selected' : ''}>No extra staff</option>
                            <option value="1" ${config.peak_boost === 1 ? 'selected' : ''}>+1 person</option>
                            <option value="2" ${config.peak_boost === 2 ? 'selected' : ''}>+2 people</option>
                            <option value="3" ${config.peak_boost === 3 ? 'selected' : ''}>+3 people</option>
                        </select>
                    </div>
                </div>
                <div class="hours-required-section">
                    <div class="hours-required-title">When is this role needed?</div>
                    <div class="hours-required-options">
                        <label class="hours-option">
                            <input type="radio" name="hours-${role.id}" value="all" 
                                   ${(!config.required_hours || config.required_hours.length === 0) ? 'checked' : ''}
                                   onchange="setRoleHoursOption('${role.id}', 'all')">
                            <div>
                                <div class="hours-option-label">All operating hours</div>
                                <div class="hours-option-desc">This role is needed from open to close</div>
                            </div>
                        </label>
                        <label class="hours-option">
                            <input type="radio" name="hours-${role.id}" value="custom"
                                   ${(config.required_hours && config.required_hours.length > 0) ? 'checked' : ''}
                                   onchange="setRoleHoursOption('${role.id}', 'custom')">
                            <div>
                                <div class="hours-option-label">Specific hours only</div>
                                <div class="hours-option-desc">This role is only needed during certain times</div>
                            </div>
                        </label>
                    </div>
                    <div class="custom-hours-picker ${(config.required_hours && config.required_hours.length > 0) ? 'visible' : ''}" 
                         id="custom-hours-${role.id}">
                        <div id="custom-hours-list-${role.id}">
                            ${renderCustomHours(role.id, config.required_hours || [])}
                        </div>
                        <button class="btn btn-sm btn-ghost" onclick="addCustomHoursPeriod('${role.id}')">
                            + Add time period
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        container.appendChild(card);
    });
}

function renderCustomHours(roleId, periods) {
    if (!periods || periods.length === 0) {
        return `
            <div class="time-period-row">
                <select class="time-select" id="custom-start-${roleId}-0">
                    ${generateHourOptions(state.startHour)}
                </select>
                <span>to</span>
                <select class="time-select" id="custom-end-${roleId}-0">
                    ${generateHourOptions(state.endHour)}
                </select>
            </div>
        `;
    }
    
    return periods.map((period, idx) => `
        <div class="time-period-row">
            <select class="time-select" id="custom-start-${roleId}-${idx}" onchange="updateRoleCoverage('${roleId}')">
                ${generateHourOptions(period.start_hour)}
            </select>
            <span>to</span>
            <select class="time-select" id="custom-end-${roleId}-${idx}" onchange="updateRoleCoverage('${roleId}')">
                ${generateHourOptions(period.end_hour)}
            </select>
            ${idx > 0 ? `<button class="btn-icon-sm" onclick="removeCustomHoursPeriod('${roleId}', ${idx})">✕</button>` : ''}
        </div>
    `).join('');
}

function generateHourOptions(selectedHour) {
    let html = '';
    for (let h = state.startHour; h <= state.endHour; h++) {
        html += `<option value="${h}" ${h === selectedHour ? 'selected' : ''}>${formatHour(h)}</option>`;
    }
    return html;
}

function toggleRoleCoverage(roleId) {
    const card = document.querySelector(`.role-coverage-card[data-role-id="${roleId}"]`);
    if (card) {
        card.classList.toggle('expanded');
    }
}

function setRoleHoursOption(roleId, option) {
    const customPicker = document.getElementById(`custom-hours-${roleId}`);
    if (option === 'custom') {
        customPicker.classList.add('visible');
    } else {
        customPicker.classList.remove('visible');
    }
    updateRoleCoverage(roleId);
}

function addCustomHoursPeriod(roleId) {
    const config = state.roleCoverageConfigs.find(c => c.role_id === roleId) || {
        role_id: roleId,
        required_hours: []
    };
    
    if (!config.required_hours) config.required_hours = [];
    config.required_hours.push({
        start_hour: state.startHour,
        end_hour: state.endHour
    });
    
    const idx = state.roleCoverageConfigs.findIndex(c => c.role_id === roleId);
    if (idx >= 0) {
        state.roleCoverageConfigs[idx] = config;
    } else {
        state.roleCoverageConfigs.push(config);
    }
    
    renderRoleCoverageEditor();
    // Re-expand the card
    setTimeout(() => {
        const card = document.querySelector(`.role-coverage-card[data-role-id="${roleId}"]`);
        if (card) card.classList.add('expanded');
    }, 0);
}

function removeCustomHoursPeriod(roleId, idx) {
    const config = state.roleCoverageConfigs.find(c => c.role_id === roleId);
    if (config && config.required_hours) {
        config.required_hours.splice(idx, 1);
        renderRoleCoverageEditor();
        // Re-expand the card
        setTimeout(() => {
            const card = document.querySelector(`.role-coverage-card[data-role-id="${roleId}"]`);
            if (card) card.classList.add('expanded');
        }, 0);
    }
}

async function updateRoleCoverage(roleId) {
    const minStaff = parseInt(document.getElementById(`min-staff-${roleId}`).value) || 1;
    const maxStaff = parseInt(document.getElementById(`max-staff-${roleId}`).value) || 3;
    const peakBoost = parseInt(document.getElementById(`peak-boost-${roleId}`).value) || 0;
    
    // Check hours option
    const allHoursRadio = document.querySelector(`input[name="hours-${roleId}"][value="all"]`);
    const isAllHours = allHoursRadio && allHoursRadio.checked;
    
    let requiredHours = [];
    if (!isAllHours) {
        // Collect custom hours
        let idx = 0;
        while (true) {
            const startEl = document.getElementById(`custom-start-${roleId}-${idx}`);
            const endEl = document.getElementById(`custom-end-${roleId}-${idx}`);
            if (!startEl || !endEl) break;
            
            requiredHours.push({
                start_hour: parseInt(startEl.value),
                end_hour: parseInt(endEl.value)
            });
            idx++;
        }
    }
    
    const configData = {
        default_min_staff: minStaff,
        default_max_staff: maxStaff,
        peak_boost: peakBoost,
        required_hours: requiredHours,
        required_days: []  // For now, always all days
    };
    
    try {
        const response = await fetch(`/api/settings/role-coverage/${roleId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(configData)
        });
        
        const data = await response.json();
        
        if (data.success) {
            // Update local state
            const idx = state.roleCoverageConfigs.findIndex(c => c.role_id === roleId);
            if (idx >= 0) {
                state.roleCoverageConfigs[idx] = data.role_config;
            } else {
                state.roleCoverageConfigs.push(data.role_config);
            }
            
            // Update summary display
            const card = document.querySelector(`.role-coverage-card[data-role-id="${roleId}"]`);
            if (card) {
                let summary = `${minStaff} staff`;
                if (peakBoost > 0) {
                    summary += ` (+${peakBoost} peak)`;
                }
                if (requiredHours.length > 0) {
                    summary += ' • Custom hours';
                } else {
                    summary += ' • All hours';
                }
                card.querySelector('.role-coverage-summary').textContent = summary;
            }
            
            showToast(`${roleId} coverage updated`, 'success');
        } else {
            showToast(data.message || 'Failed to update coverage', 'error');
        }
    } catch (error) {
        showToast('Error updating coverage', 'error');
    }
}

function renderRolesList() {
    const list = document.getElementById('rolesList');
    if (!list) return;
    list.innerHTML = '';
    
    state.roles.forEach(role => {
        const card = document.createElement('div');
        card.className = 'role-card';
        card.dataset.id = role.id;
        card.innerHTML = `
            <div class="role-card-color" style="background: ${role.color}"></div>
            <div class="role-card-info">
                <span class="role-card-name">${role.name}</span>
            </div>
            <div class="role-card-actions">
                <button class="btn-icon-sm edit-role-btn" title="Edit role"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>
                <button class="btn-icon-sm delete-role-btn" title="Remove role"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
            </div>
        `;
        
        card.querySelector('.edit-role-btn').addEventListener('click', () => openRoleForm(role.id));
        card.querySelector('.delete-role-btn').addEventListener('click', () => confirmDeleteRole(role.id));
        
        list.appendChild(card);
    });
    
    // Update coverage editor (old UI - may not exist)
    const coverageEditor = document.getElementById('coverageEditor');
    if (!coverageEditor) return;
    coverageEditor.innerHTML = '';
    state.roles.forEach(role => {
        const row = document.createElement('div');
        row.className = 'coverage-row';
        row.dataset.role = role.id;
        row.innerHTML = `
            <div class="coverage-role">
                <span class="role-color-swatch" style="background: ${role.color}"></span>
                <span>${role.name}</span>
            </div>
            <div class="coverage-slider">
                <input type="range" min="0" max="5" value="1" class="slider">
                <span class="slider-value">1 person</span>
            </div>
        `;
        
        row.querySelector('.slider').addEventListener('input', (e) => {
            const value = e.target.value;
            const label = value === '1' ? '1 person' : `${value} people`;
            e.target.nextElementSibling.textContent = label;
        });
        
        coverageEditor.appendChild(row);
    });
}

function openRoleForm(roleId = null) {
    const form = document.getElementById('roleForm');
    const title = document.getElementById('roleModalTitle');
    
    form.reset();
    
    if (roleId) {
        const role = roleMap[roleId];
        if (!role) return;
        
        title.textContent = 'Edit Role';
        document.getElementById('roleId').value = role.id;
        document.getElementById('roleName').value = role.name;
        document.getElementById('roleColor').value = role.color;
    } else {
        title.textContent = 'Add Role';
        document.getElementById('roleId').value = '';
        document.getElementById('roleColor').value = getRandomColor();
    }
    
    openModal('roleModal');
}

async function handleRoleSubmit(e) {
    e.preventDefault();
    
    const roleId = document.getElementById('roleId').value;
    const isNew = !roleId;
    
    const roleData = {
        name: document.getElementById('roleName').value,
        color: document.getElementById('roleColor').value
    };
    
    try {
        let response;
        if (isNew) {
            response = await fetch(`/api/${state.business.id}/settings/roles`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(roleData)
            });
        } else {
            response = await fetch(`/api/${state.business.id}/settings/roles/${roleId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(roleData)
            });
        }
        
        const data = await response.json();
        
        if (data.success) {
            if (isNew) {
                state.roles.push(data.role);
            } else {
                const idx = state.roles.findIndex(r => r.id === roleId);
                if (idx >= 0) state.roles[idx] = data.role;
            }
            
            buildLookups();
            renderRolesList();
            renderRoleLegend();
            closeAllModals();
            showToast(isNew ? 'Role added' : 'Role updated', 'success');
        } else {
            showToast(data.message || 'Failed to save role', 'error');
        }
    } catch (error) {
        showToast('Error saving role', 'error');
    }
}

function confirmDeleteRole(roleId) {
    const role = roleMap[roleId];
    if (!role) return;
    
    document.getElementById('confirmTitle').textContent = 'Delete Role';
    document.getElementById('confirmMessage').textContent = `Are you sure you want to remove "${role.name}"?`;
    document.getElementById('confirmBtn').dataset.action = 'deleteRole';
    document.getElementById('confirmBtn').dataset.id = roleId;
    
    openModal('confirmModal');
}

async function deleteRole(roleId) {
    try {
        const response = await fetch(`/api/${state.business.id}/settings/roles/${roleId}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.success) {
            state.roles = state.roles.filter(r => r.id !== roleId);
            delete roleMap[roleId];
            renderRolesList();
            renderRoleLegend();
            showToast('Role removed', 'success');
        } else {
            showToast(data.message || 'Failed to delete role', 'error');
        }
    } catch (error) {
        showToast('Error deleting role', 'error');
    }
}

// ==================== CONFIRM HANDLER ====================
function handleConfirm() {
    const btn = document.getElementById('confirmBtn');
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    
    closeAllModals();
    
    if (action === 'deleteEmployee') {
        deleteEmployee(id);
    } else if (action === 'deleteRole') {
        deleteRole(id);
    } else if (action === 'clearAvailability') {
        executeClearAvailability(id);
    } else if (action === 'deleteShift') {
        deleteShift(id);
    }
}

// ==================== KEYBOARD SHORTCUTS ====================
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Ignore if typing in input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') {
            return;
        }
        
        // Ignore if a custom dropdown is open (time pickers, etc.)
        if (document.querySelector('.custom-select.open')) {
            return;
        }
        
        // Close modals on Escape
        if (e.key === 'Escape') {
            closeAllModals();
            return;
        }
        
        // Tab switching with number keys
        if (e.key === '1') switchTab('schedule');
        else if (e.key === '2') switchTab('settings');
        else if (e.key === '3') switchTab('help');
        
        // Schedule shortcuts
        else if (e.key === 'g' && !e.ctrlKey && !e.metaKey) {
            if (!dom.generateBtn.disabled) generateSchedule();
        }
        else if (e.key === 'a' && !e.ctrlKey && !e.metaKey) {
            if (!dom.alternativeBtn.disabled) findAlternative();
        }
        else if (e.key === 'r' && !e.ctrlKey && !e.metaKey) {
            resetSchedule();
        }
        
        // New employee shortcut
        else if (e.key === 'n' && !e.ctrlKey && !e.metaKey) {
            if (state.currentTab === 'settings') {
                openEmployeeForm();
            }
        }
    });
}

// ==================== UTILITIES ====================

// Maximally distinct color palette
// Avoids: reds (reserved for "needs coverage" indicators)
// Avoids: purples near #8b5cf6 (reserved for time-off display)
const DISTINCT_COLORS = [
    '#2a9d8f', // Teal
    '#e9c46a', // Yellow/Gold
    '#264653', // Dark Blue-Gray
    '#f4a261', // Orange
    '#3a86ff', // Bright Blue
    '#06d6a0', // Mint Green
    '#118ab2', // Ocean Blue
    '#ffd166', // Sunny Yellow
    '#073b4c', // Navy
    '#4ecdc4', // Turquoise
    '#ffe66d', // Lemon
    '#95e1d3', // Seafoam
    '#a8d8ea', // Sky Blue
    '#ffc93c', // Amber
    '#1eb980', // Emerald
    '#00b4d8', // Cyan
    '#90be6d', // Olive Green
    '#577590', // Steel Blue
    '#43aa8b', // Sea Green
    '#f9844a', // Tangerine
    '#10b981', // Emerald Green
    '#0ea5e9', // Sky Blue
    '#14b8a6', // Teal
    '#f59e0b', // Amber
];

function getRandomColor() {
    return DISTINCT_COLORS[Math.floor(Math.random() * DISTINCT_COLORS.length)];
}

// Get a distinct color based on index - ensures no two adjacent employees have similar colors
function getDistinctColor(index) {
    return DISTINCT_COLORS[index % DISTINCT_COLORS.length];
}

// Get next available distinct color that's not already used
function getNextDistinctColor(usedColors = []) {
    for (const color of DISTINCT_COLORS) {
        if (!usedColors.includes(color) && !usedColors.includes(color.toLowerCase())) {
            return color;
        }
    }
    // If all colors used, just return a random one
    return getRandomColor();
}

// ==================== COVERAGE MODE ====================

function setupCoverageMode() {
    // Mode toggle buttons
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => switchCoverageMode(btn.dataset.mode));
    });
    
    // Mode card selection (onboarding)
    document.querySelectorAll('.mode-card').forEach(card => {
        card.addEventListener('click', () => selectCoverageMode(card.dataset.mode));
    });
    
    document.querySelectorAll('.select-mode-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const mode = btn.closest('.mode-card').dataset.mode;
            selectCoverageMode(mode);
        });
    });
    
    // Add shift buttons
    if (dom.addShiftBtn) {
        dom.addShiftBtn.addEventListener('click', () => openShiftForm());
    }
    if (dom.addFirstShiftBtn) {
        dom.addFirstShiftBtn.addEventListener('click', () => openShiftForm());
    }
    
    // Shift form
    const shiftForm = document.getElementById('shiftForm');
    if (shiftForm) {
        shiftForm.addEventListener('submit', handleShiftSubmit);
    }
    
    // Shift time selects
    const shiftStartHour = document.getElementById('shiftStartHour');
    const shiftEndHour = document.getElementById('shiftEndHour');
    if (shiftStartHour && shiftEndHour) {
        shiftStartHour.addEventListener('change', updateShiftDuration);
        shiftEndHour.addEventListener('change', updateShiftDuration);
    }
    
    // Collapsible sections
    const rulesToggle = document.getElementById('rulesToggle');
    if (rulesToggle) {
        rulesToggle.addEventListener('click', () => {
            const section = rulesToggle.closest('.collapsible-section');
            section.classList.toggle('open');
        });
    }
    
    const rolesToggle = document.getElementById('rolesToggle');
    if (rolesToggle) {
        rolesToggle.addEventListener('click', () => {
            const section = rolesToggle.closest('.collapsible-section');
            section.classList.toggle('open');
        });
    }
}

function renderCoverageUI() {
    // Always show the shifts calendar section
    if (dom.shiftsSection) dom.shiftsSection.style.display = 'block';
    
    // Mark setup as complete
    state.hasCompletedSetup = true;
    state.coverageMode = 'shifts';
    
    // Initialize calendar and render shifts
    initCalendar();
    renderShiftTemplates();
}

// ==================== CALENDAR WEEK VIEW ====================

// Calendar state
const calendarState = {
    isDragging: false,
    startCell: null,
    endCell: null,
    gridElement: null,
    timeRange: 'business', // 'business' or 'full'
    viewStartHour: 0,
    viewEndHour: 24
};

function initCalendar() {
    // Set initial view hours based on business hours
    calendarState.viewStartHour = calendarState.timeRange === 'full' ? 0 : state.startHour;
    calendarState.viewEndHour = calendarState.timeRange === 'full' ? 24 : state.endHour;
    
    const calendars = [
        { 
            container: document.getElementById('calendarContainer'),
            grid: document.getElementById('calendarGrid'), 
            events: document.getElementById('calendarEvents'), 
            legend: document.getElementById('calendarLegend') 
        }
    ];
    
    calendars.forEach(({ container, grid, events, legend }) => {
        if (grid) {
            buildCalendarGrid(grid, container);
            setupCalendarDrag(grid, events, container);
        }
        if (legend) {
            renderCalendarLegend(legend);
        }
    });
    
    // Setup legend expand button (only once)
    setupLegendExpand();
    
    // Setup time range toggle button (icon style)
    setupTimeRangeToggle();
}

function setupTimeRangeToggle() {
    const toggleBtn = document.getElementById('timeRangeToggle');
    const toggleLabel = document.getElementById('timeToggleLabel');
    
    if (!toggleBtn || toggleBtn.hasAttribute('data-listener-attached')) return;
    toggleBtn.setAttribute('data-listener-attached', 'true');
    
    // Update visual state
    function updateToggleState() {
        const is24h = calendarState.timeRange === 'full';
        toggleBtn.classList.toggle('mode-24h', is24h);
        toggleBtn.title = is24h ? '24 Hours - Click for Business Hours' : 'Business Hours - Click for 24 Hours';
        if (toggleLabel) {
            toggleLabel.textContent = is24h ? '24h' : 'Business';
        }
    }
    
    toggleBtn.addEventListener('click', () => {
        // Toggle between business and full
        calendarState.timeRange = calendarState.timeRange === 'business' ? 'full' : 'business';
        calendarState.viewStartHour = calendarState.timeRange === 'full' ? 0 : state.startHour;
        calendarState.viewEndHour = calendarState.timeRange === 'full' ? 24 : state.endHour;
        
        updateToggleState();
        
        // Rebuild calendar
        initCalendar();
        renderShiftTemplates();
    });
    
    // Initial state
    updateToggleState();
}

function buildCalendarGrid(gridElement, containerElement) {
    // Clear grid
    gridElement.innerHTML = '';
    
    const startHour = calendarState.viewStartHour;
    const endHour = calendarState.viewEndHour;
    
    // Corner cell
    const corner = document.createElement('div');
    corner.className = 'calendar-corner';
    gridElement.appendChild(corner);
    
    // Day headers
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    dayNames.forEach((name, idx) => {
        const header = document.createElement('div');
        header.className = 'calendar-day-header';
        header.dataset.day = idx;
        header.textContent = name;
        gridElement.appendChild(header);
    });
    
    // Add hour rows
    for (let hour = startHour; hour < endHour; hour++) {
        // Hour label
        const label = document.createElement('div');
        label.className = 'calendar-hour-label';
        label.dataset.hour = hour;
        label.innerHTML = `<span>${formatHour(hour)}</span>`;
        gridElement.appendChild(label);
        
        // 7 day cells
        for (let day = 0; day < 7; day++) {
            const cell = document.createElement('div');
            cell.className = 'calendar-cell';
            cell.dataset.day = day;
            cell.dataset.hour = hour;
            gridElement.appendChild(cell);
        }
    }
    
    // Store dimensions for event positioning
    if (containerElement) {
        containerElement.dataset.startHour = startHour;
        containerElement.dataset.endHour = endHour;
    }
}

function setupCalendarDrag(gridElement, eventsElement, containerElement) {
    let startDay, startHour, currentDay, currentHour;
    let selectionEl = containerElement?.querySelector('.calendar-selection');
    
    const getCellInfo = (cell) => {
        return {
            day: parseInt(cell.dataset.day),
            hour: parseInt(cell.dataset.hour)
        };
    };
    
    const getGridDimensions = () => {
        const cell = gridElement.querySelector('.calendar-cell');
        const header = gridElement.querySelector('.calendar-day-header');
        const label = gridElement.querySelector('.calendar-hour-label');
        
        return {
            cellWidth: cell?.offsetWidth || 100,
            cellHeight: cell?.offsetHeight || 40,
            headerHeight: header?.offsetHeight || 35,
            labelWidth: label?.offsetWidth || 50
        };
    };
    
    const updateSelection = () => {
        if (!selectionEl || startDay === undefined) return;
        
        const dims = getGridDimensions();
        const minDay = Math.min(startDay, currentDay);
        const maxDay = Math.max(startDay, currentDay);
        const minHour = Math.min(startHour, currentHour);
        const maxHour = Math.max(startHour, currentHour);
        
        selectionEl.style.display = 'block';
        selectionEl.style.left = `${dims.labelWidth + minDay * dims.cellWidth}px`;
        selectionEl.style.top = `${dims.headerHeight + (minHour - calendarState.viewStartHour) * dims.cellHeight}px`;
        selectionEl.style.width = `${(maxDay - minDay + 1) * dims.cellWidth}px`;
        selectionEl.style.height = `${(maxHour - minHour + 1) * dims.cellHeight}px`;
    };
    
    gridElement.addEventListener('mousedown', (e) => {
        const cell = e.target.closest('.calendar-cell');
        if (!cell) return;
        
        calendarState.isDragging = true;
        calendarState.gridElement = gridElement;
        const info = getCellInfo(cell);
        startDay = currentDay = info.day;
        startHour = currentHour = info.hour;
        
        updateSelection();
        e.preventDefault();
    });
    
    gridElement.addEventListener('mousemove', (e) => {
        if (!calendarState.isDragging || calendarState.gridElement !== gridElement) return;
        
        const cell = e.target.closest('.calendar-cell');
        if (!cell) return;
        
        const info = getCellInfo(cell);
        currentDay = info.day;
        currentHour = info.hour;
        
        updateSelection();
    });
    
    document.addEventListener('mouseup', (e) => {
        if (!calendarState.isDragging || calendarState.gridElement !== gridElement) return;
        
        calendarState.isDragging = false;
        
        if (selectionEl) selectionEl.style.display = 'none';
        
        // Open shift form with selected time range
        const minDay = Math.min(startDay, currentDay);
        const maxDay = Math.max(startDay, currentDay);
        const minHour = Math.min(startHour, currentHour);
        const maxHour = Math.max(startHour, currentHour) + 1;
        
        const selectedDays = [];
        for (let d = minDay; d <= maxDay; d++) {
            selectedDays.push(d);
        }
        
        openShiftForm(null, {
            startHour: minHour,
            endHour: maxHour,
            days: selectedDays
        });
        
        startDay = startHour = currentDay = currentHour = undefined;
    });
    
    // Right-click to delete
    eventsElement?.addEventListener('contextmenu', (e) => {
        const shiftEl = e.target.closest('.shift-event');
        if (shiftEl) {
            e.preventDefault();
            const shiftId = shiftEl.dataset.id;
            confirmDeleteShift(shiftId);
        }
    });
    
    // Click to edit
    eventsElement?.addEventListener('click', (e) => {
        const shiftEl = e.target.closest('.shift-event');
        if (shiftEl) {
            openShiftForm(shiftEl.dataset.id);
        }
    });
}

function renderCalendarLegend(legendElement) {
    if (!legendElement) return;
    
    legendElement.innerHTML = state.roles.map(role => `
        <div class="legend-item">
            <div class="legend-color" style="background: ${role.color}"></div>
            <span>${role.name}</span>
        </div>
    `).join('');
    
    // Check if legend needs expand button (after render)
    requestAnimationFrame(() => {
        checkLegendOverflow();
    });
}

function checkLegendOverflow() {
    const wrapper = document.getElementById('legendWrapper');
    const legend = document.getElementById('calendarLegend');
    const expandBtn = document.getElementById('legendExpandBtn');
    
    if (!wrapper || !legend || !expandBtn) return;
    
    // Temporarily remove max-height to measure full height
    const wasExpanded = wrapper.classList.contains('expanded');
    legend.style.maxHeight = 'none';
    
    const fullHeight = legend.scrollHeight;
    const singleRowHeight = 24; // Approximate height of one row
    
    // Restore max-height
    legend.style.maxHeight = '';
    
    // Show expand button if content is taller than one row
    if (fullHeight > singleRowHeight + 5) {
        expandBtn.style.display = 'flex';
    } else {
        expandBtn.style.display = 'none';
        wrapper.classList.remove('expanded');
    }
}

function setupLegendExpand() {
    const wrapper = document.getElementById('legendWrapper');
    const expandBtn = document.getElementById('legendExpandBtn');
    
    if (!wrapper || !expandBtn) return;
    
    // Only attach listener once
    if (expandBtn.hasAttribute('data-listener-attached')) return;
    expandBtn.setAttribute('data-listener-attached', 'true');
    
    expandBtn.addEventListener('click', () => {
        wrapper.classList.toggle('expanded');
    });
}

function renderShiftTemplates() {
    // Render to calendar
    const calendars = [
        { 
            events: document.getElementById('calendarEvents'), 
            container: document.getElementById('calendarContainer'),
            grid: document.getElementById('calendarGrid')
        }
    ];
    
    calendars.forEach(({ events, container, grid }) => {
        if (!events || !grid) return;
        events.innerHTML = '';
        
        // Get actual grid dimensions
        const cell = grid.querySelector('.calendar-cell');
        const header = grid.querySelector('.calendar-day-header');
        const label = grid.querySelector('.calendar-hour-label');
        
        if (!cell) return;
        
        const cellWidth = cell.offsetWidth;
        const cellHeight = cell.offsetHeight;
        const headerHeight = header?.offsetHeight || 35;
        const labelWidth = label?.offsetWidth || 50;
        
        const viewStartHour = calendarState.viewStartHour;
        const viewEndHour = calendarState.viewEndHour;
        
        // Group shifts by day to handle overlapping
        const shiftsByDay = {};
        for (let d = 0; d < 7; d++) {
            shiftsByDay[d] = [];
        }
        
        state.shiftTemplates.forEach(shift => {
            (shift.days || []).forEach(dayIndex => {
                // Check if shift is visible in current view
                if (shift.end_hour <= viewStartHour || shift.start_hour >= viewEndHour) return;
                
                shiftsByDay[dayIndex].push({
                    ...shift,
                    visibleStart: Math.max(shift.start_hour, viewStartHour),
                    visibleEnd: Math.min(shift.end_hour, viewEndHour)
                });
            });
        });
        
        // Render shifts for each day, splitting width only when shifts actually overlap
        Object.entries(shiftsByDay).forEach(([dayIndex, shifts]) => {
            dayIndex = parseInt(dayIndex);
            if (shifts.length === 0) return;
            
            // Sort shifts by start time for consistent ordering
            shifts.sort((a, b) => a.start_hour - b.start_hour);
            
            // Assign columns to shifts - only overlapping shifts need separate columns
            // Use a greedy algorithm: assign each shift to the first available column
            const columns = []; // Array of arrays, each sub-array is a column with non-overlapping shifts
            
            shifts.forEach(shift => {
                // Find a column where this shift doesn't overlap with any existing shift
                let placed = false;
                for (let colIdx = 0; colIdx < columns.length; colIdx++) {
                    const column = columns[colIdx];
                    const hasOverlap = column.some(existingShift => 
                        shift.start_hour < existingShift.end_hour && shift.end_hour > existingShift.start_hour
                    );
                    if (!hasOverlap) {
                        shift.column = colIdx;
                        column.push(shift);
                        placed = true;
                        break;
                    }
                }
                // If no column found, create a new one
                if (!placed) {
                    shift.column = columns.length;
                    columns.push([shift]);
                }
            });
            
            const numColumns = columns.length;
            const widthPadding = 4;
            const availableWidth = cellWidth - widthPadding;
            const shiftWidth = numColumns > 1 ? (availableWidth / numColumns) - 1 : availableWidth;
            
            shifts.forEach((shift) => {
                const startOffset = shift.visibleStart - viewStartHour;
                const duration = shift.visibleEnd - shift.visibleStart;
                
                // Use the shift's saved color
                let color = shift.color || '#6366f1';
                
                const el = document.createElement('div');
                el.className = 'shift-event';
                el.dataset.id = shift.id;
                el.style.backgroundColor = color;
                
                // Position: labelWidth + day offset + column offset
                const leftPos = labelWidth + (dayIndex * cellWidth) + (widthPadding / 2) + (shift.column * (shiftWidth + 1));
                el.style.left = `${leftPos}px`;
                el.style.top = `${headerHeight + startOffset * cellHeight + 1}px`;
                el.style.width = `${shiftWidth}px`;
                el.style.height = `${duration * cellHeight - 2}px`;
                el.style.zIndex = 10 + shift.column;
                
                // Calculate total staff required for this shift
                const totalStaff = (shift.roles || []).reduce((sum, r) => sum + (r.count || 0), 0);
                
                // Build tooltip with full details
                const timeStr = `${formatHour(shift.start_hour)}-${formatHour(shift.end_hour)}`;
                const roleDetails = (shift.roles || []).map(r => {
                    const role = roleMap[r.role_id];
                    return `${role?.name || r.role_id}: ${r.count}`;
                }).join(', ');
                
                // Display only the total staff count number
                el.innerHTML = `<div class="shift-event-staff">${totalStaff}</div>`;
                
                el.title = `${shift.name}\n${timeStr}\n${roleDetails ? 'Staff: ' + roleDetails : ''}\nClick to edit, right-click to delete`;
                
                events.appendChild(el);
            });
        });
    });
}

function openShiftForm(shiftId = null, preselect = null) {
    const modal = dom.shiftModal;
    const form = document.getElementById('shiftForm');
    const title = document.getElementById('shiftModalTitle');
    
    if (!modal || !form) return;
    
    form.reset();
    state.editingShift = shiftId;
    
    // Populate time selects
    populateShiftTimeSelects();
    
    // Populate shift roles editor
    populateShiftRolesEditor();
    
    if (shiftId) {
        const shift = state.shiftTemplates.find(s => s.id === shiftId);
        if (!shift) return;
        
        title.textContent = 'Edit Shift';
        document.getElementById('shiftId').value = shift.id;
        document.getElementById('shiftName').value = shift.name;
        document.getElementById('shiftColor').value = shift.color || '#6366f1';
        document.getElementById('shiftStartHour').value = shift.start_hour;
        document.getElementById('shiftEndHour').value = shift.end_hour;
        
        // Set days
        document.querySelectorAll('#shiftDays input').forEach(cb => {
            cb.checked = shift.days.includes(parseInt(cb.value));
        });
        
        // Set role counts (min and max)
        (shift.roles || []).forEach(roleReq => {
            const minInput = document.querySelector(`#shiftRolesEditor input[data-role="${roleReq.role_id}"][data-type="min"]`);
            const maxInput = document.querySelector(`#shiftRolesEditor input[data-role="${roleReq.role_id}"][data-type="max"]`);
            if (minInput) minInput.value = roleReq.count;
            if (maxInput) maxInput.value = roleReq.max_count || roleReq.count;
        });
        
        // Update role color options after setting counts
        updateRoleColorOptions();
    } else {
        title.textContent = 'Add Shift';
        document.getElementById('shiftId').value = '';
        document.getElementById('shiftColor').value = getRandomColor();
        
        // Apply preselected values from calendar drag
        if (preselect) {
            document.getElementById('shiftStartHour').value = preselect.startHour;
            document.getElementById('shiftEndHour').value = preselect.endHour;
            
            // Set only selected days
            document.querySelectorAll('#shiftDays input').forEach(cb => {
                cb.checked = preselect.days.includes(parseInt(cb.value));
            });
        } else {
            // Default all days checked
            document.querySelectorAll('#shiftDays input').forEach(cb => cb.checked = true);
        }
    }
    
    updateShiftDuration();
    openModal('shiftModal');
}

function populateShiftTimeSelects() {
    const startSelect = document.getElementById('shiftStartHour');
    const endSelect = document.getElementById('shiftEndHour');
    
    if (!startSelect || !endSelect) return;
    
    startSelect.innerHTML = '';
    endSelect.innerHTML = '';
    
    for (let h = 0; h < 24; h++) {
        const opt1 = document.createElement('option');
        opt1.value = h;
        opt1.textContent = formatHour(h);
        startSelect.appendChild(opt1);
        
        const opt2 = document.createElement('option');
        opt2.value = h;
        opt2.textContent = formatHour(h);
        endSelect.appendChild(opt2);
    }
    
    // Also add 24:00 for end
    const opt24 = document.createElement('option');
    opt24.value = 24;
    opt24.textContent = '24:00';
    endSelect.appendChild(opt24);
    
    // Set defaults
    startSelect.value = state.startHour;
    endSelect.value = state.endHour;
}

function populateShiftRolesEditor() {
    const editor = document.getElementById('shiftRolesEditor');
    if (!editor) return;
    
    const hasSearch = state.roles.length > 5;
    
    // Build the HTML with optional search bar
    let html = '';
    
    if (hasSearch) {
        html += `
            <div class="roles-search-wrapper">
                <input type="text" id="rolesSearchInput" class="roles-search" placeholder="Search roles..." autocomplete="off">
            </div>
        `;
    }
    
    html += `<div class="roles-list-container" id="rolesListContainer">`;
    html += state.roles.map(role => `
        <div class="shift-role-row" data-role-name="${role.name.toLowerCase()}">
            <span class="role-color-dot" style="background: ${role.color}"></span>
            <span class="role-name">${role.name}</span>
            <div class="role-staff-inputs">
                <div class="staff-input-group">
                    <label>Min</label>
                    <input type="number" min="0" max="20" value="0" data-role="${role.id}" data-type="min" placeholder="0">
                </div>
                <div class="staff-input-group">
                    <label>Max</label>
                    <input type="number" min="0" max="20" value="0" data-role="${role.id}" data-type="max" placeholder="0">
                </div>
            </div>
        </div>
    `).join('');
    html += `</div>`;
    
    editor.innerHTML = html;
    
    // Setup search functionality if search bar exists
    if (hasSearch) {
        const searchInput = document.getElementById('rolesSearchInput');
        const rolesContainer = document.getElementById('rolesListContainer');
        
        searchInput.addEventListener('input', () => {
            const searchTerm = searchInput.value.toLowerCase().trim();
            rolesContainer.querySelectorAll('.shift-role-row').forEach(row => {
                const roleName = row.dataset.roleName;
                const matches = roleName.includes(searchTerm);
                row.style.display = matches ? '' : 'none';
            });
        });
    }
    
    // Auto-sync max when min changes (if max is empty or less than min)
    // Also update role color options when staff counts change
    editor.querySelectorAll('input[data-type="min"]').forEach(minInput => {
        minInput.addEventListener('change', () => {
            const roleId = minInput.dataset.role;
            const maxInput = editor.querySelector(`input[data-role="${roleId}"][data-type="max"]`);
            const minVal = parseInt(minInput.value) || 0;
            const maxVal = parseInt(maxInput.value) || 0;
            if (maxVal < minVal) {
                maxInput.value = minVal;
            }
            // Update available role colors
            updateRoleColorOptions();
        });
    });
    
    // Initial population of role color options
    updateRoleColorOptions();
}

function updateRoleColorOptions() {
    const container = document.getElementById('roleColorOptions');
    const colorInput = document.getElementById('shiftColor');
    if (!container || !colorInput) return;
    
    // Get roles that have staff assigned (min > 0)
    const activeRoles = [];
    document.querySelectorAll('#shiftRolesEditor input[data-type="min"]').forEach(input => {
        const minVal = parseInt(input.value) || 0;
        if (minVal > 0) {
            const roleId = input.dataset.role;
            const role = state.roles.find(r => r.id === roleId);
            if (role) {
                activeRoles.push(role);
            }
        }
    });
    
    // Generate color option buttons
    if (activeRoles.length === 0) {
        container.innerHTML = '<span class="no-roles-hint">Add staff to roles to see color options</span>';
    } else {
        container.innerHTML = activeRoles.map(role => `
            <button type="button" class="color-option" data-color="${role.color}" title="${role.name}">
                <span class="color-swatch" style="background: ${role.color}"></span>
            </button>
        `).join('');
        
        // Add click handlers
        container.querySelectorAll('.color-option').forEach(btn => {
            btn.addEventListener('click', () => {
                const color = btn.dataset.color;
                colorInput.value = color;
                // Update selected state
                container.querySelectorAll('.color-option').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
            });
        });
        
        // Check if current color matches a role color
        const currentColor = colorInput.value.toLowerCase();
        container.querySelectorAll('.color-option').forEach(btn => {
            if (btn.dataset.color.toLowerCase() === currentColor) {
                btn.classList.add('selected');
            }
        });
    }
    
    // Handle custom color input - deselect role colors when custom is changed
    // Use a flag to prevent adding multiple listeners
    if (!colorInput.hasAttribute('data-listener-attached')) {
        colorInput.setAttribute('data-listener-attached', 'true');
        colorInput.addEventListener('input', () => {
            const cont = document.getElementById('roleColorOptions');
            if (cont) {
                cont.querySelectorAll('.color-option').forEach(b => b.classList.remove('selected'));
            }
        });
    }
}

function updateShiftDuration() {
    const start = parseInt(document.getElementById('shiftStartHour')?.value || 0);
    const end = parseInt(document.getElementById('shiftEndHour')?.value || 0);
    const durationEl = document.getElementById('shiftDuration');
    
    if (durationEl) {
        const hours = end - start;
        durationEl.textContent = `Duration: ${hours} hour${hours !== 1 ? 's' : ''}`;
        durationEl.style.color = hours <= 0 ? 'var(--danger)' : 'var(--text-secondary)';
    }
}

async function handleShiftSubmit(e) {
    e.preventDefault();
    
    const shiftId = document.getElementById('shiftId').value;
    const isNew = !shiftId;
    
    // Gather role requirements
    const roles = [];
    const roleData = {};
    
    // Collect min and max values for each role
    document.querySelectorAll('#shiftRolesEditor input').forEach(input => {
        const roleId = input.dataset.role;
        const type = input.dataset.type;
        const value = parseInt(input.value) || 0;
        
        if (!roleData[roleId]) {
            roleData[roleId] = { min: 0, max: 0 };
        }
        roleData[roleId][type] = value;
    });
    
    // Convert to roles array
    Object.entries(roleData).forEach(([roleId, data]) => {
        if (data.min > 0 || data.max > 0) {
            roles.push({
                role_id: roleId,
                count: data.min,
                max_count: Math.max(data.max, data.min) // max must be >= min
            });
        }
    });
    
    // Gather days
    const days = [];
    document.querySelectorAll('#shiftDays input:checked').forEach(cb => {
        days.push(parseInt(cb.value));
    });
    
    const shiftData = {
        name: document.getElementById('shiftName').value,
        start_hour: parseInt(document.getElementById('shiftStartHour').value),
        end_hour: parseInt(document.getElementById('shiftEndHour').value),
        color: document.getElementById('shiftColor').value,
        days: days,
        roles: roles
    };
    
    // Validation
    if (shiftData.end_hour <= shiftData.start_hour) {
        showToast('End time must be after start time', 'error');
        return;
    }
    
    if (roles.length === 0) {
        showToast('Please add at least one role requirement', 'error');
        return;
    }
    
    try {
        let response;
        if (isNew) {
            response = await fetch('/api/settings/shifts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(shiftData)
            });
        } else {
            response = await fetch(`/api/settings/shifts/${shiftId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(shiftData)
            });
        }
        
        const data = await response.json();
        
        if (data.success) {
            if (isNew) {
                state.shiftTemplates.push(data.shift);
            } else {
                const idx = state.shiftTemplates.findIndex(s => s.id === shiftId);
                if (idx >= 0) state.shiftTemplates[idx] = data.shift;
            }
            
            renderShiftTemplates();
            closeAllModals();
            showToast(isNew ? 'Shift added' : 'Shift updated', 'success');
        } else {
            showToast(data.message || 'Failed to save shift', 'error');
        }
    } catch (error) {
        showToast('Error saving shift', 'error');
    }
}

function confirmDeleteShift(shiftId) {
    const shift = state.shiftTemplates.find(s => s.id === shiftId);
    if (!shift) return;
    
    document.getElementById('confirmTitle').textContent = 'Delete Shift';
    document.getElementById('confirmMessage').textContent = `Are you sure you want to remove "${shift.name}"?`;
    document.getElementById('confirmBtn').dataset.action = 'deleteShift';
    document.getElementById('confirmBtn').dataset.id = shiftId;
    
    openModal('confirmModal');
}

async function deleteShift(shiftId) {
    try {
        const response = await fetch(`/api/settings/shifts/${shiftId}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.success) {
            state.shiftTemplates = state.shiftTemplates.filter(s => s.id !== shiftId);
            renderShiftTemplates();
            showToast('Shift removed', 'success');
        } else {
            showToast(data.message || 'Failed to delete shift', 'error');
        }
    } catch (error) {
        showToast('Error deleting shift', 'error');
    }
}

// ==================== DETAILED MODE (GRID) ====================

function renderStaffingGrid() {
    if (!dom.staffingGridHeader || !dom.staffingGridBody || !dom.staffingGridTotal) return;
    
    // Render header with hours
    let headerHtml = '<th class="grid-role-col">Role</th>';
    for (let h = state.startHour; h < state.endHour; h++) {
        headerHtml += `<th>${formatHour(h)}</th>`;
    }
    dom.staffingGridHeader.innerHTML = headerHtml;
    
    // Render body with role rows
    dom.staffingGridBody.innerHTML = state.roles.map(role => {
        // Find config for this role
        const config = state.roleCoverageConfigs.find(c => c.role_id === role.id) || {
            default_min_staff: 1,
            peak_boost: 0
        };
        
        let rowHtml = `<td class="grid-role-col">
            <span class="role-color-dot" style="background: ${role.color}; display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px;"></span>
            ${role.name}
        </td>`;
        
        for (let h = state.startHour; h < state.endHour; h++) {
            const isPeak = isPeakHour(h);
            const value = config.default_min_staff + (isPeak ? config.peak_boost : 0);
            rowHtml += `<td class="${isPeak ? 'peak-cell' : ''}">
                <input type="number" min="0" max="20" value="${value}" 
                       data-role="${role.id}" data-hour="${h}"
                       onchange="updateGridCell(this)">
            </td>`;
        }
        
        return `<tr>${rowHtml}</tr>`;
    }).join('');
    
    // Render totals
    updateGridTotals();
}

function isPeakHour(hour) {
    return state.peakPeriods.some(p => hour >= p.start_hour && hour < p.end_hour);
}

function updateGridCell(input) {
    // TODO: Save individual cell changes
    updateGridTotals();
}

function updateGridTotals() {
    if (!dom.staffingGridTotal) return;
    
    let html = '<td class="grid-role-col"><strong>Total</strong></td>';
    
    for (let h = state.startHour; h < state.endHour; h++) {
        let total = 0;
        document.querySelectorAll(`#staffingGridBody input[data-hour="${h}"]`).forEach(input => {
            total += parseInt(input.value) || 0;
        });
        const isPeak = isPeakHour(h);
        html += `<td class="${isPeak ? 'peak-cell' : ''}"><strong>${total}</strong></td>`;
    }
    
    dom.staffingGridTotal.innerHTML = html;
}

// ==================== PEAK PERIODS ====================

function renderPeakPeriods() {
    if (!dom.peakPeriodsList) return;
    
    if (state.peakPeriods.length === 0) {
        dom.peakPeriodsList.innerHTML = '<span class="peak-empty">No peak periods defined</span>';
        return;
    }
    
    dom.peakPeriodsList.innerHTML = state.peakPeriods.map((period, idx) => `
        <div class="peak-period-tag" data-index="${idx}">
            <span class="name">${period.name}</span>
            <span class="time">${formatHour(period.start_hour)} - ${formatHour(period.end_hour)}</span>
            <button class="btn-icon-sm" onclick="editPeakPeriod(${idx})" title="Edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>
            <button class="btn-icon-sm" onclick="deletePeakPeriod(${idx})" title="Delete">×</button>
        </div>
    `).join('');
}

function openPeakForm(index = null) {
    const form = document.getElementById('peakForm');
    const title = document.getElementById('peakModalTitle');
    
    if (!form) return;
    
    form.reset();
    
    // Populate time selects
    const startSelect = document.getElementById('peakStartHour');
    const endSelect = document.getElementById('peakEndHour');
    
    if (startSelect) {
        startSelect.innerHTML = '';
        for (let h = 0; h < 24; h++) {
            const opt = document.createElement('option');
            opt.value = h;
            opt.textContent = formatHour(h);
            startSelect.appendChild(opt);
        }
    }
    
    if (endSelect) {
        endSelect.innerHTML = '';
        for (let h = 1; h <= 24; h++) {
            const opt = document.createElement('option');
            opt.value = h;
            opt.textContent = formatHour(h);
            endSelect.appendChild(opt);
        }
    }
    
    if (index !== null && state.peakPeriods[index]) {
        const period = state.peakPeriods[index];
        title.textContent = 'Edit Peak Period';
        document.getElementById('peakIndex').value = index;
        document.getElementById('peakName').value = period.name;
        document.getElementById('peakStartHour').value = period.start_hour;
        document.getElementById('peakEndHour').value = period.end_hour;
        
        document.querySelectorAll('#peakDays input').forEach(cb => {
            cb.checked = period.days.includes(parseInt(cb.value));
        });
    } else {
        title.textContent = 'Add Peak Period';
        document.getElementById('peakIndex').value = '';
        document.getElementById('peakStartHour').value = 8;
        document.getElementById('peakEndHour').value = 10;
        document.querySelectorAll('#peakDays input').forEach(cb => cb.checked = true);
    }
    
    openModal('peakModal');
}

function editPeakPeriod(index) {
    openPeakForm(index);
}

async function handlePeakSubmit(e) {
    e.preventDefault();
    
    const indexVal = document.getElementById('peakIndex').value;
    const isNew = indexVal === '';
    
    const days = [];
    document.querySelectorAll('#peakDays input:checked').forEach(cb => {
        days.push(parseInt(cb.value));
    });
    
    const periodData = {
        name: document.getElementById('peakName').value,
        start_hour: parseInt(document.getElementById('peakStartHour').value),
        end_hour: parseInt(document.getElementById('peakEndHour').value),
        days: days
    };
    
    if (isNew) {
        state.peakPeriods.push(periodData);
    } else {
        state.peakPeriods[parseInt(indexVal)] = periodData;
    }
    
    // Save to server
    try {
        await fetch('/api/settings/peak-periods', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ peak_periods: state.peakPeriods })
        });
        
        renderPeakPeriods();
        if (state.coverageMode === 'detailed') {
            renderStaffingGrid();
        }
        closeAllModals();
        showToast(isNew ? 'Peak period added' : 'Peak period updated', 'success');
    } catch (error) {
        showToast('Error saving peak period', 'error');
    }
}

async function deletePeakPeriod(index) {
    state.peakPeriods.splice(index, 1);
    
    try {
        await fetch('/api/settings/peak-periods', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ peak_periods: state.peakPeriods })
        });
        
        renderPeakPeriods();
        if (state.coverageMode === 'detailed') {
            renderStaffingGrid();
        }
        showToast('Peak period removed', 'success');
    } catch (error) {
        showToast('Error removing peak period', 'error');
    }
}

// ==================== MOBILE SLIDE MENU (Manager View) ====================

function setupMobileSlideMenu() {
    const hamburgerBtn = document.getElementById('managerHamburgerBtn');
    const slideMenuOverlay = document.getElementById('managerSlideMenuOverlay');
    const slideMenu = document.getElementById('managerSlideMenu');
    const slideMenuClose = document.getElementById('managerSlideMenuClose');
    const slideMenuItems = document.querySelectorAll('.manager-slide-menu-item[data-tab]');
    
    // Also handle PTO notification dropdown close on mobile
    const closePtoNotificationsMobile = document.getElementById('closePtoNotificationsMobile');
    const ptoNotificationDropdown = document.getElementById('ptoNotificationDropdown');
    
    if (!hamburgerBtn || !slideMenu) return;
    
    function openMenu() {
        slideMenuOverlay.classList.add('visible');
        slideMenu.classList.add('visible');
        document.body.classList.add('manager-menu-open');
    }
    
    function closeMenu() {
        slideMenuOverlay.classList.remove('visible');
        slideMenu.classList.remove('visible');
        document.body.classList.remove('manager-menu-open');
    }
    
    // Toggle menu
    hamburgerBtn.addEventListener('click', openMenu);
    
    // Close menu
    if (slideMenuClose) {
        slideMenuClose.addEventListener('click', closeMenu);
    }
    
    // Close on overlay click
    if (slideMenuOverlay) {
        slideMenuOverlay.addEventListener('click', closeMenu);
    }
    
    // Handle menu item clicks
    slideMenuItems.forEach(item => {
        item.addEventListener('click', () => {
            const tabId = item.dataset.tab;
            
            // Update active state on slide menu items
            slideMenuItems.forEach(mi => mi.classList.remove('active'));
            item.classList.add('active');
            
            // Switch tab
            switchTab(tabId);
            
            // Close menu
            closeMenu();
        });
    });
    
    // Sync slide menu active state with main nav
    function syncSlideMenuState() {
        const activeTab = state.currentTab;
        slideMenuItems.forEach(item => {
            item.classList.toggle('active', item.dataset.tab === activeTab);
        });
    }
    
    // Observe tab changes
    const originalSwitchTab = window.switchTab;
    if (typeof originalSwitchTab === 'function') {
        // Patch switchTab to also sync slide menu
        const navTabs = document.querySelectorAll('.nav-tab');
        navTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                setTimeout(syncSlideMenuState, 10);
            });
        });
    }
    
    // Handle PTO notifications close button on mobile
    if (closePtoNotificationsMobile && ptoNotificationDropdown) {
        closePtoNotificationsMobile.addEventListener('click', () => {
            ptoNotificationDropdown.classList.remove('visible');
        });
    }
    
    // Close menu on escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && slideMenu.classList.contains('visible')) {
            closeMenu();
        }
    });
}

// ==================== START ====================
setupMobileSlideMenu();
init();

// ==================== "TODAY" BUTTON ====================
// Shown only when the user is looking at a different week.
(function setupTodayButton() {
    document.addEventListener('DOMContentLoaded', () => {
        const btn = document.getElementById('weekNavToday');
        if (!btn) return;
        btn.addEventListener('click', () => {
            if (state.weekOffset !== 0) navigateWeek(-state.weekOffset);
        });
        const sync = () => { btn.hidden = state.weekOffset === 0; };
        sync();
        // Keep in sync whenever the week label is rewritten
        const label = document.getElementById('weekDateRange');
        if (label) new MutationObserver(sync).observe(label, { childList: true, characterData: true, subtree: true });
    });
})();
