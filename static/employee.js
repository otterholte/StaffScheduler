/**
 * Employee Portal JavaScript
 * Handles schedule viewing and availability editing for individual employees
 */

// ==================== STATE ====================
const employeeState = {
    business: EMPLOYEE_DATA.business,
    employee: EMPLOYEE_DATA.employee,
    allEmployees: EMPLOYEE_DATA.allEmployees || [],
    roles: EMPLOYEE_DATA.roles,
    days: EMPLOYEE_DATA.days,
    daysOpen: EMPLOYEE_DATA.daysOpen,
    hours: EMPLOYEE_DATA.hours,
    startHour: EMPLOYEE_DATA.startHour,
    endHour: EMPLOYEE_DATA.endHour,
    businessSlug: EMPLOYEE_DATA.businessSlug,
    schedule: EMPLOYEE_DATA.schedule || null,
    availability: EMPLOYEE_DATA.availability || {},
    weekOffset: 0,
    viewMode: 'timeline', // 'timeline', 'grid', or 'table'
    filterMode: 'mine', // 'mine' or 'everyone'
    // Availability editing state
    isSelecting: false,
    selectionStart: null,
    selectionMode: null // 'add' or 'remove'
};

// Build lookup maps
const employeeMap = {};
const roleMap = {};

employeeState.allEmployees.forEach(emp => {
    employeeMap[emp.id] = emp;
});
employeeState.roles.forEach(role => {
    roleMap[role.id] = role;
});

// ==================== UTILITIES ====================
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatHour(hour) {
    if (hour === 0 || hour === 24) return '12am';
    if (hour === 12) return '12pm';
    if (hour < 12) return `${hour}am`;
    return `${hour - 12}pm`;
}

function formatAmPm(hour) {
    return hour < 12 ? 'am' : 'pm';
}

function formatTime(hour) {
    return formatHour(hour);
}

function formatTimeRange(startHour, endHour) {
    return `${formatTime(startHour)} - ${formatTime(endHour)}`;
}

function getWeekDates(offset = 0) {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - dayOfWeek + (offset * 7));
    
    const dates = [];
    for (let i = 0; i < 7; i++) {
        const date = new Date(startOfWeek);
        date.setDate(startOfWeek.getDate() + i);
        dates.push(date);
    }
    return dates;
}

function formatDateRange(dates) {
    const options = { month: 'short', day: 'numeric' };
    const start = dates[0].toLocaleDateString('en-US', options);
    const end = dates[6].toLocaleDateString('en-US', { ...options, year: 'numeric' });
    return `${start} - ${end}`;
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <span class="toast-message">${message}</span>
        <button class="toast-close" onclick="this.parentElement.remove()">×</button>
    `;
    container.appendChild(toast);
    
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ==================== SCHEDULE VIEW ====================
function initScheduleView() {
    setupViewToggle();
    setupFilterToggle();
    setupWeekNavigation();
    updateWeekDisplay();
    loadScheduleData();
    renderScheduleView();
}

function setupViewToggle() {
    const viewToggle = document.getElementById('viewToggle');
    if (!viewToggle) return;
    
    viewToggle.querySelectorAll('.view-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            viewToggle.querySelectorAll('.view-toggle-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            employeeState.viewMode = btn.dataset.view;
            renderScheduleView();
        });
    });
}

function setupFilterToggle() {
    const filterToggle = document.getElementById('filterToggle');
    if (!filterToggle) return;
    
    filterToggle.querySelectorAll('.filter-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            filterToggle.querySelectorAll('.filter-toggle-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            employeeState.filterMode = btn.dataset.filter;
            renderScheduleView();
            updateHoursSummary();
        });
    });
}

function setupWeekNavigation() {
    const prevBtn = document.getElementById('weekNavPrev');
    const nextBtn = document.getElementById('weekNavNext');
    
    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            employeeState.weekOffset--;
            updateWeekDisplay();
            loadScheduleData();
        });
    }
    
    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            employeeState.weekOffset++;
            updateWeekDisplay();
            loadScheduleData();
        });
    }
}

function updateWeekDisplay() {
    const weekDateRange = document.getElementById('weekDateRange');
    if (weekDateRange) {
        const dates = getWeekDates(employeeState.weekOffset);
        weekDateRange.textContent = formatDateRange(dates);
    }
}

function loadScheduleData() {
    // Try to load from localStorage (same key format as main app)
    const storageKey = `schedule_${employeeState.business.id}_week_${employeeState.weekOffset}`;
    const savedData = localStorage.getItem(storageKey);
    
    if (savedData) {
        try {
            employeeState.schedule = JSON.parse(savedData);
        } catch (e) {
            employeeState.schedule = null;
        }
    } else {
        employeeState.schedule = null;
    }
    
    renderScheduleView();
    updateHoursSummary();
    renderUpcomingShifts();
}

function renderScheduleView() {
    const timelineView = document.getElementById('scheduleViewTimeline');
    const gridView = document.getElementById('scheduleViewGrid');
    const tableView = document.getElementById('scheduleViewTable');
    
    // Hide all views
    if (timelineView) timelineView.classList.remove('active');
    if (gridView) gridView.classList.remove('active');
    if (tableView) tableView.classList.remove('active');
    
    // Show selected view
    if (employeeState.viewMode === 'timeline') {
        renderTimelineView();
        if (timelineView) timelineView.classList.add('active');
    } else if (employeeState.viewMode === 'grid') {
        renderGridView();
        if (gridView) gridView.classList.add('active');
    } else {
        renderTableView();
        if (tableView) tableView.classList.add('active');
    }
}

// ==================== TIMELINE VIEW ====================
function renderTimelineView() {
    const grid = document.getElementById('timelineGrid');
    if (!grid) return;
    
    const dates = getWeekDates(employeeState.weekOffset);
    const schedule = employeeState.schedule;
    const myId = employeeState.employee.id;
    const showEveryone = employeeState.filterMode === 'everyone';
    
    // Calculate hours span
    const startHour = employeeState.startHour;
    const endHour = employeeState.endHour;
    const totalHours = endHour - startHour;
    
    let html = '';
    
    // Header row with hours
    html += '<div class="timeline-header">';
    html += '<div class="timeline-day-label"></div>';
    for (let h = startHour; h < endHour; h++) {
        html += `<div class="timeline-hour-label">${formatTime(h)}</div>`;
    }
    html += '</div>';
    
    // Day rows
    employeeState.daysOpen.forEach((dayIdx, i) => {
        const date = dates[dayIdx];
        const dayName = DAYS_SHORT[dayIdx];
        const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        
        html += `<div class="timeline-row" data-day="${dayIdx}">`;
        html += `<div class="timeline-day-label">
            <span class="day-name">${dayName}</span>
            <span class="day-date">${dateStr}</span>
        </div>`;
        html += '<div class="timeline-day-content">';
        
        // Hour slots background
        for (let h = startHour; h < endHour; h++) {
            html += `<div class="timeline-hour-slot" data-hour="${h}"></div>`;
        }
        
        // Render shifts for this day
        if (schedule && schedule.slot_assignments) {
            const shifts = showEveryone ? getAllShiftsForDay(schedule, dayIdx) : getMyShiftsForDay(schedule, dayIdx);
            shifts.forEach(shift => {
                const left = ((shift.start - startHour) / totalHours) * 100;
                const width = ((shift.end - shift.start) / totalHours) * 100;
                const role = roleMap[shift.role] || {};
                const emp = employeeMap[shift.employeeId] || {};
                const isMine = shift.employeeId === myId;
                
                const shiftClass = isMine ? 'shift-block my-shift' : 'shift-block other-shift';
                const bgColor = role.color || emp.color || '#6366f1';
                
                const shortName = emp.name ? (emp.name.length > 6 ? emp.name.substring(0, 5) + '…' : emp.name) : '';
                
                html += `<div class="${shiftClass}" style="left: ${left}%; width: ${width}%; background: ${bgColor}" title="${emp.name || ''}\n${role.name || 'Shift'}\n${formatTimeRange(shift.start, shift.end)}">
                    <span class="shift-name">${shortName}</span>
                    <span class="shift-time-small">${formatTimeRange(shift.start, shift.end)}</span>
                </div>`;
            });
        }
        
        html += '</div></div>';
    });
    
    grid.innerHTML = html;
}

function getAllShiftsForDay(schedule, dayIdx) {
    const shifts = [];
    
    if (!schedule || !schedule.slot_assignments) return shifts;
    
    // Group assignments by employee for this day
    const empShifts = {}; // { empId: { roleId, hours: Set } }
    
    Object.entries(schedule.slot_assignments).forEach(([slotKey, assignments]) => {
        const parts = slotKey.split(',');
        if (parts.length >= 2) {
            const day = parseInt(parts[0]);
            const hour = parseInt(parts[1]);
            
            if (day === dayIdx) {
                assignments.forEach(assignment => {
                    const empId = assignment.employee_id;
                    const roleId = assignment.role_id;
                    const key = `${empId}_${roleId}`;
                    
                    if (!empShifts[key]) {
                        empShifts[key] = {
                            employeeId: empId,
                            role: roleId,
                            hours: new Set()
                        };
                    }
                    empShifts[key].hours.add(hour);
                });
            }
        }
    });
    
    // Convert to shift segments
    Object.values(empShifts).forEach(empShift => {
        const hours = Array.from(empShift.hours).sort((a, b) => a - b);
        if (hours.length === 0) return;
        
        // Group consecutive hours into shifts
        let shiftStart = hours[0];
        let prevHour = hours[0];
        
        for (let i = 1; i <= hours.length; i++) {
            if (i === hours.length || hours[i] !== prevHour + 1) {
                shifts.push({
                    employeeId: empShift.employeeId,
                    role: empShift.role,
                    start: shiftStart,
                    end: prevHour + 1
                });
                if (i < hours.length) {
                    shiftStart = hours[i];
                }
            }
            if (i < hours.length) {
                prevHour = hours[i];
            }
        }
    });
    
    return shifts;
}

function getMyShiftsForDay(schedule, dayIdx) {
    const shifts = [];
    const myId = employeeState.employee.id;
    
    if (!schedule || !schedule.slot_assignments) return shifts;
    
    // Parse slot assignments to find my shifts
    Object.entries(schedule.slot_assignments).forEach(([slotKey, assignments]) => {
        // slotKey format: "day,hour"
        const parts = slotKey.split(',');
        if (parts.length >= 2) {
            const day = parseInt(parts[0]);
            const hour = parseInt(parts[1]);
            
            if (day === dayIdx) {
                assignments.forEach(assignment => {
                    if (assignment.employee_id === myId) {
                        // Check if we already have a shift that extends to this hour
                        const existingShift = shifts.find(s => 
                            s.role === assignment.role_id && s.end === hour
                        );
                        
                        if (existingShift) {
                            existingShift.end = hour + 1;
                        } else {
                            shifts.push({
                                employeeId: myId,
                                start: hour,
                                end: hour + 1,
                                role: assignment.role_id
                            });
                        }
                    }
                });
            }
        }
    });
    
    return shifts;
}

// ==================== GRID VIEW ====================
function renderGridView() {
    const gridBody = document.getElementById('scheduleGridBody');
    const eventsContainer = document.getElementById('scheduleEvents');
    if (!gridBody) return;
    
    const dates = getWeekDates(employeeState.weekOffset);
    const schedule = employeeState.schedule;
    const myId = employeeState.employee.id;
    const showEveryone = employeeState.filterMode === 'everyone';
    
    // Build grid body with time rows
    let html = '';
    for (let hour = employeeState.startHour; hour < employeeState.endHour; hour++) {
        html += `<tr>`;
        html += `<td class="time-cell">${formatTime(hour)}</td>`;
        
        employeeState.daysOpen.forEach((dayIdx) => {
            html += `<td class="slot" data-day="${dayIdx}" data-hour="${hour}"></td>`;
        });
        
        html += `</tr>`;
    }
    gridBody.innerHTML = html;
    
    // Clear and render shift blocks
    if (eventsContainer) {
        eventsContainer.innerHTML = '';
        
        if (schedule && schedule.slot_assignments) {
            renderGridShifts(schedule, eventsContainer, showEveryone);
        }
    }
}

function renderGridShifts(schedule, container, showEveryone) {
    const myId = employeeState.employee.id;
    const slotAssignments = schedule.slot_assignments || {};
    
    // Get grid dimensions
    const wrapper = document.getElementById('scheduleGridWrapper');
    const grid = document.getElementById('scheduleGrid');
    const firstSlot = grid?.querySelector('.slot');
    const headerRow = grid?.querySelector('thead tr');
    const timeCell = grid?.querySelector('.time-cell');
    
    if (!firstSlot || !wrapper) return;
    
    const hSpacing = 8;
    const vSpacing = 3;
    const slotWidth = firstSlot.offsetWidth + hSpacing;
    const slotHeight = firstSlot.offsetHeight + vSpacing;
    const headerHeight = headerRow?.offsetHeight || 35;
    const timeCellWidth = (timeCell?.offsetWidth || 50) + hSpacing;
    
    // Build shift segments
    const shiftSegments = [];
    
    employeeState.daysOpen.forEach((day, dayIdx) => {
        const empHours = {};
        
        employeeState.hours.forEach(hour => {
            const key = `${day},${hour}`;
            const assignments = slotAssignments[key] || [];
            
            assignments.forEach(assignment => {
                const empId = assignment.employee_id;
                
                // Filter by mine/everyone
                if (!showEveryone && empId !== myId) return;
                
                if (!empHours[empId]) {
                    empHours[empId] = { hours: new Map() };
                }
                if (!empHours[empId].hours.has(hour)) {
                    empHours[empId].hours.set(hour, new Set());
                }
                empHours[empId].hours.get(hour).add(assignment.role_id);
            });
        });
        
        // Convert to segments
        Object.entries(empHours).forEach(([employeeId, data]) => {
            const hoursList = Array.from(data.hours.keys()).sort((a, b) => a - b);
            if (hoursList.length === 0) return;
            
            let segmentStart = hoursList[0];
            let prevHour = hoursList[0];
            let segmentRoles = new Set(data.hours.get(hoursList[0]));
            
            for (let i = 1; i <= hoursList.length; i++) {
                const currentHour = hoursList[i];
                
                if (currentHour !== prevHour + 1 || i === hoursList.length) {
                    shiftSegments.push({
                        employeeId,
                        roles: segmentRoles,
                        day,
                        dayIdx,
                        startHour: segmentStart,
                        endHour: prevHour + 1
                    });
                    
                    if (i < hoursList.length) {
                        segmentStart = currentHour;
                        segmentRoles = new Set(data.hours.get(currentHour));
                    }
                } else {
                    data.hours.get(currentHour).forEach(r => segmentRoles.add(r));
                }
                prevHour = currentHour;
            }
        });
    });
    
    // Assign columns for overlapping shifts
    const blocksByDay = {};
    employeeState.daysOpen.forEach((day, idx) => {
        blocksByDay[idx] = shiftSegments.filter(s => s.dayIdx === idx);
    });
    
    Object.entries(blocksByDay).forEach(([dayIdx, blocks]) => {
        dayIdx = parseInt(dayIdx);
        blocks.sort((a, b) => a.startHour - b.startHour);
        
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
        
        const isMine = segment.employeeId === myId;
        const roleNames = Array.from(segment.roles)
            .map(roleId => roleMap[roleId]?.name || roleId)
            .join(', ');
        
        // Get color
        let color = emp.color || '#666';
        if (segment.roles.size > 0) {
            const firstRoleId = Array.from(segment.roles)[0];
            color = roleMap[firstRoleId]?.color || emp.color || '#666';
        }
        
        const hourOffset = segment.startHour - employeeState.hours[0];
        const duration = segment.endHour - segment.startHour;
        
        const widthPadding = 6;
        const availableWidth = slotWidth - widthPadding;
        const blockWidth = segment.totalColumns > 1 
            ? (availableWidth / segment.totalColumns) - 1 
            : availableWidth;
        
        const el = document.createElement('div');
        el.className = isMine ? 'schedule-shift-block my-shift' : 'schedule-shift-block other-shift';
        el.style.backgroundColor = color;
        
        const leftPos = timeCellWidth + (segment.dayIdx * slotWidth) + (widthPadding / 2) + 
            (segment.column * (blockWidth + 1));
        el.style.left = `${leftPos}px`;
        el.style.top = `${headerHeight + hourOffset * slotHeight + 2}px`;
        el.style.width = `${blockWidth}px`;
        el.style.height = `${duration * slotHeight - 4}px`;
        el.style.zIndex = 10 + segment.column;
        
        const shortName = emp.name.length > 5 ? emp.name.substring(0, 4) : emp.name;
        el.innerHTML = `<span class="shift-name">${shortName}</span>`;
        el.title = `${emp.name}\nRoles: ${roleNames}\n${formatHour(segment.startHour)} - ${formatHour(segment.endHour)}`;
        
        container.appendChild(el);
    });
}

// ==================== TABLE/LIST VIEW ====================
function renderTableView() {
    const listContainer = document.getElementById('employeeShiftList');
    if (!listContainer) return;
    
    const dates = getWeekDates(employeeState.weekOffset);
    const schedule = employeeState.schedule;
    const myId = employeeState.employee.id;
    const showEveryone = employeeState.filterMode === 'everyone';
    
    let html = '';
    let hasAnyShifts = false;
    
    employeeState.daysOpen.forEach((dayIdx) => {
        const date = dates[dayIdx];
        const dayName = DAYS_FULL[dayIdx];
        const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        
        const shifts = schedule ? (showEveryone ? getAllShiftsForDay(schedule, dayIdx) : getMyShiftsForDay(schedule, dayIdx)) : [];
        
        // Sort shifts by start time, then by employee name
        shifts.sort((a, b) => {
            if (a.start !== b.start) return a.start - b.start;
            const nameA = employeeMap[a.employeeId]?.name || '';
            const nameB = employeeMap[b.employeeId]?.name || '';
            return nameA.localeCompare(nameB);
        });
        
        html += `<div class="shift-list-day">`;
        html += `<div class="shift-list-day-header">${dayName}, ${dateStr}</div>`;
        
        if (shifts.length > 0) {
            hasAnyShifts = true;
            shifts.forEach(shift => {
                const role = roleMap[shift.role] || {};
                const emp = employeeMap[shift.employeeId] || {};
                const duration = shift.end - shift.start;
                const isMine = shift.employeeId === myId;
                const itemClass = isMine ? 'shift-list-item my-shift' : 'shift-list-item other-shift';
                
                html += `<div class="${itemClass}">`;
                if (showEveryone) {
                    html += `<span class="shift-list-employee">
                        <span class="employee-dot" style="background: ${emp.color || '#666'}"></span>
                        ${emp.name || 'Unknown'}
                    </span>`;
                }
                html += `<span class="shift-list-time">${formatTimeRange(shift.start, shift.end)}</span>
                    <span class="shift-list-role">
                        <span class="shift-list-role-dot" style="background: ${role.color || '#6366f1'}"></span>
                        <span class="shift-list-role-name">${role.name || 'Shift'}</span>
                    </span>
                    <span class="shift-list-duration">${duration}h</span>
                </div>`;
            });
        } else {
            html += `<div class="no-shifts-day">No shifts scheduled</div>`;
        }
        
        html += `</div>`;
    });
    
    listContainer.innerHTML = html;
}

function updateHoursSummary() {
    const schedule = employeeState.schedule;
    const myId = employeeState.employee.id;
    const showEveryone = employeeState.filterMode === 'everyone';
    
    let totalHours = 0;
    let shiftCount = 0;
    
    if (schedule) {
        employeeState.daysOpen.forEach(dayIdx => {
            // Always show MY hours in the summary, regardless of filter
            const shifts = getMyShiftsForDay(schedule, dayIdx);
            shifts.forEach(shift => {
                totalHours += (shift.end - shift.start);
                shiftCount++;
            });
        });
    }
    
    const hoursEl = document.getElementById('myScheduledHours');
    const shiftsEl = document.getElementById('myShiftCount');
    
    if (hoursEl) hoursEl.textContent = totalHours > 0 ? `${totalHours}h` : '—';
    if (shiftsEl) shiftsEl.textContent = shiftCount > 0 ? shiftCount : '—';
}

function renderUpcomingShifts() {
    const listContainer = document.getElementById('upcomingShiftsList');
    const noShiftsMsg = document.getElementById('noShiftsMessage');
    if (!listContainer) return;
    
    const schedule = employeeState.schedule;
    const dates = getWeekDates(employeeState.weekOffset);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const upcomingShifts = [];
    
    if (schedule) {
        employeeState.daysOpen.forEach(dayIdx => {
            const date = dates[dayIdx];
            if (date >= today) {
                // Only show MY upcoming shifts
                const shifts = getMyShiftsForDay(schedule, dayIdx);
                shifts.forEach(shift => {
                    upcomingShifts.push({
                        ...shift,
                        date: date,
                        dayIdx: dayIdx
                    });
                });
            }
        });
    }
    
    // Sort by date
    upcomingShifts.sort((a, b) => a.date - b.date);
    
    // Take first 5
    const displayShifts = upcomingShifts.slice(0, 5);
    
    // Clear existing shift items
    listContainer.querySelectorAll('.upcoming-shift-item').forEach(el => el.remove());
    
    if (displayShifts.length === 0) {
        if (noShiftsMsg) noShiftsMsg.style.display = 'block';
        return;
    }
    
    if (noShiftsMsg) noShiftsMsg.style.display = 'none';
    
    let html = '';
    displayShifts.forEach(shift => {
        const role = roleMap[shift.role] || {};
        const duration = shift.end - shift.start;
        
        html += `<div class="upcoming-shift-item">
            <div class="shift-date-badge">
                <span class="day-name">${DAYS_SHORT[shift.dayIdx]}</span>
                <span class="day-num">${shift.date.getDate()}</span>
            </div>
            <div class="shift-details">
                <div class="shift-time">${formatTimeRange(shift.start, shift.end)}</div>
                <div class="shift-role">
                    <span class="shift-role-dot" style="background: ${role.color || '#6366f1'}"></span>
                    ${role.name || 'Shift'}
                </div>
            </div>
            <div class="shift-duration">${duration}h</div>
        </div>`;
    });
    
    // Insert before no-shifts message
    if (noShiftsMsg) {
        noShiftsMsg.insertAdjacentHTML('beforebegin', html);
    } else {
        listContainer.innerHTML = html;
    }
}

// ==================== AVAILABILITY EDITOR ====================
function initAvailabilityEditor() {
    renderAvailabilityGrid();
    setupAvailabilityPresets();
    setupSaveButton();
    updateAvailabilityStats();
}

function renderAvailabilityGrid() {
    const tbody = document.getElementById('availabilityTableBody');
    if (!tbody) return;
    
    const availability = employeeState.availability || {};
    let html = '';
    
    for (let hour = employeeState.startHour; hour < employeeState.endHour; hour++) {
        html += `<tr>`;
        html += `<td class="time-cell">${formatTime(hour)}</td>`;
        
        for (let day = 0; day < 7; day++) {
            const isAvailable = isHourAvailable(day, hour);
            const activeClass = isAvailable ? 'available' : '';
            html += `<td class="avail-cell ${activeClass}" data-day="${day}" data-hour="${hour}"></td>`;
        }
        
        html += `</tr>`;
    }
    
    tbody.innerHTML = html;
    
    // Setup drag selection
    setupAvailabilityDrag();
}

function isHourAvailable(day, hour) {
    const availability = employeeState.availability || {};
    const dayAvail = availability[day];
    
    if (!dayAvail || !Array.isArray(dayAvail)) return false;
    
    // dayAvail is array of [start, end] tuples
    return dayAvail.some(([start, end]) => hour >= start && hour < end);
}

function setupAvailabilityDrag() {
    const tbody = document.getElementById('availabilityTableBody');
    if (!tbody) return;
    
    let isMouseDown = false;
    let selectionMode = null;
    
    tbody.addEventListener('mousedown', (e) => {
        const cell = e.target.closest('.avail-cell');
        if (!cell) return;
        
        isMouseDown = true;
        selectionMode = cell.classList.contains('available') ? 'remove' : 'add';
        toggleCell(cell, selectionMode);
        
        e.preventDefault();
    });
    
    tbody.addEventListener('mouseover', (e) => {
        if (!isMouseDown) return;
        
        const cell = e.target.closest('.avail-cell');
        if (!cell) return;
        
        toggleCell(cell, selectionMode);
    });
    
    document.addEventListener('mouseup', () => {
        if (isMouseDown) {
            isMouseDown = false;
            selectionMode = null;
            updateAvailabilityFromGrid();
            updateAvailabilityStats();
            markUnsaved();
        }
    });
}

function toggleCell(cell, mode) {
    if (mode === 'add') {
        cell.classList.add('available');
    } else {
        cell.classList.remove('available');
    }
}

function updateAvailabilityFromGrid() {
    const tbody = document.getElementById('availabilityTableBody');
    if (!tbody) return;
    
    const newAvailability = {};
    
    for (let day = 0; day < 7; day++) {
        const daySlots = [];
        let currentStart = null;
        
        for (let hour = employeeState.startHour; hour < employeeState.endHour; hour++) {
            const cell = tbody.querySelector(`[data-day="${day}"][data-hour="${hour}"]`);
            const isAvailable = cell && cell.classList.contains('available');
            
            if (isAvailable && currentStart === null) {
                currentStart = hour;
            } else if (!isAvailable && currentStart !== null) {
                daySlots.push([currentStart, hour]);
                currentStart = null;
            }
        }
        
        // Close any open slot at end of day
        if (currentStart !== null) {
            daySlots.push([currentStart, employeeState.endHour]);
        }
        
        if (daySlots.length > 0) {
            newAvailability[day] = daySlots;
        }
    }
    
    employeeState.availability = newAvailability;
}

function setupAvailabilityPresets() {
    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            applyPreset(btn.dataset.preset);
            updateAvailabilityStats();
            markUnsaved();
        });
    });
}

function applyPreset(preset) {
    const tbody = document.getElementById('availabilityTableBody');
    if (!tbody) return;
    
    // Clear all first
    tbody.querySelectorAll('.avail-cell').forEach(cell => {
        cell.classList.remove('available');
    });
    
    const startHour = employeeState.startHour;
    const endHour = employeeState.endHour;
    
    switch (preset) {
        case 'all-9-5':
            // All days 9am-5pm
            for (let day = 0; day < 7; day++) {
                for (let hour = 9; hour < 17; hour++) {
                    if (hour >= startHour && hour < endHour) {
                        const cell = tbody.querySelector(`[data-day="${day}"][data-hour="${hour}"]`);
                        if (cell) cell.classList.add('available');
                    }
                }
            }
            break;
            
        case 'weekdays-9-5':
            // Mon-Fri 9am-5pm
            for (let day = 1; day <= 5; day++) {
                for (let hour = 9; hour < 17; hour++) {
                    if (hour >= startHour && hour < endHour) {
                        const cell = tbody.querySelector(`[data-day="${day}"][data-hour="${hour}"]`);
                        if (cell) cell.classList.add('available');
                    }
                }
            }
            break;
            
        case 'weekends-9-5':
            // Sat-Sun 9am-5pm
            [0, 6].forEach(day => {
                for (let hour = 9; hour < 17; hour++) {
                    if (hour >= startHour && hour < endHour) {
                        const cell = tbody.querySelector(`[data-day="${day}"][data-hour="${hour}"]`);
                        if (cell) cell.classList.add('available');
                    }
                }
            });
            break;
            
        case 'mornings':
            // All days, first half of operating hours
            const midMorning = Math.floor((startHour + endHour) / 2);
            for (let day = 0; day < 7; day++) {
                for (let hour = startHour; hour < midMorning; hour++) {
                    const cell = tbody.querySelector(`[data-day="${day}"][data-hour="${hour}"]`);
                    if (cell) cell.classList.add('available');
                }
            }
            break;
            
        case 'evenings':
            // All days, second half of operating hours
            const midEvening = Math.floor((startHour + endHour) / 2);
            for (let day = 0; day < 7; day++) {
                for (let hour = midEvening; hour < endHour; hour++) {
                    const cell = tbody.querySelector(`[data-day="${day}"][data-hour="${hour}"]`);
                    if (cell) cell.classList.add('available');
                }
            }
            break;
            
        case 'clear':
            // Already cleared above
            break;
    }
    
    updateAvailabilityFromGrid();
}

function updateAvailabilityStats() {
    let totalHours = 0;
    let daysAvailable = 0;
    
    const availability = employeeState.availability || {};
    
    Object.entries(availability).forEach(([day, slots]) => {
        if (slots && slots.length > 0) {
            daysAvailable++;
            slots.forEach(([start, end]) => {
                totalHours += (end - start);
            });
        }
    });
    
    const hoursEl = document.getElementById('totalAvailableHours');
    const daysEl = document.getElementById('daysAvailable');
    
    if (hoursEl) hoursEl.textContent = totalHours;
    if (daysEl) daysEl.textContent = daysAvailable;
}

function setupSaveButton() {
    const saveBtn = document.getElementById('saveAvailabilityBtn');
    if (!saveBtn) return;
    
    saveBtn.addEventListener('click', saveAvailability);
}

function markUnsaved() {
    const status = document.getElementById('saveStatus');
    if (status) {
        status.textContent = 'Unsaved changes';
        status.className = 'save-status';
    }
}

async function saveAvailability() {
    const status = document.getElementById('saveStatus');
    const saveBtn = document.getElementById('saveAvailabilityBtn');
    
    if (status) {
        status.textContent = 'Saving...';
        status.className = 'save-status saving';
    }
    
    if (saveBtn) saveBtn.disabled = true;
    
    try {
        const response = await fetch(`/api/employee/${employeeState.employee.id}/availability`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                business_id: employeeState.business.id,
                availability: employeeState.availability
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            if (status) {
                status.textContent = 'Saved!';
                status.className = 'save-status saved';
            }
            showToast('Availability saved successfully', 'success');
        } else {
            throw new Error(data.error || 'Failed to save');
        }
    } catch (error) {
        console.error('Failed to save availability:', error);
        if (status) {
            status.textContent = 'Failed to save';
            status.className = 'save-status error';
        }
        showToast('Failed to save availability', 'error');
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', () => {
    // Determine which page we're on
    const scheduleView = document.getElementById('scheduleViewTimeline');
    const availabilityTable = document.getElementById('availabilityTable');
    
    if (scheduleView) {
        initScheduleView();
    }
    
    if (availabilityTable) {
        initAvailabilityEditor();
    }
});
