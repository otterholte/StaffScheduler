/**
 * Employee Portal JavaScript
 * Handles schedule viewing and availability editing for individual employees
 */

// ==================== URL PARAMS ====================
function getInitialViewMode() {
    const params = new URLSearchParams(window.location.search);
    const view = params.get('view');
    if (view && ['timeline', 'grid', 'table'].includes(view)) {
        return view;
    }
    return 'table'; // Default to table view for employees
}

function getInitialWeekOffset() {
    const params = new URLSearchParams(window.location.search);
    const week = params.get('week');
    if (week !== null) {
        const offset = parseInt(week, 10);
        if (!isNaN(offset)) return offset;
    }
    return 0;
}

function updateURLView(viewMode) {
    const url = new URL(window.location);
    url.searchParams.set('view', viewMode);
    window.history.replaceState({}, '', url);
}

function updateURLWeek(weekOffset) {
    const url = new URL(window.location);
    if (weekOffset === 0) {
        url.searchParams.delete('week');
    } else {
        url.searchParams.set('week', weekOffset);
    }
    window.history.replaceState({}, '', url);
}

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
    weekOffset: getInitialWeekOffset(),
    viewMode: getInitialViewMode(), // 'timeline', 'grid', or 'table'
    filterMode: 'mine', // 'mine' or 'everyone'
    // Availability editing state
    isSelecting: false,
    selectionStart: null,
    selectionMode: null, // 'add' or 'remove'
    // Swap request state
    swapRequests: { incoming: [], outgoing: [] },
    currentSwapShift: null,
    eligibleStaff: [],
    selectedRecipients: [],
    currentSwapRequest: null,
    selectedSwapShift: null,
    // Approved PTO for schedule display
    approvedPTO: [],
    // PTO notifications for unified notification bell
    ptoNotifications: []
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

// Helper to get shift color based on color mode
function getShiftColor(employeeId, roleIds) {
    const myId = employeeState.employee?.id;
    const isMine = employeeId == myId;
    
    // Other employees' shifts are always grey for easy identification
    if (!isMine) {
        return '#64748b'; // Slate grey for other staff
    }
    
    // My shifts colored by role
    if (roleIds && roleIds.size > 0) {
        const firstRoleId = Array.from(roleIds)[0];
        return roleMap[firstRoleId]?.color || '#3b82f6';
    }
    return '#3b82f6'; // Default blue for my shifts
}

// ==================== UTILITIES ====================
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Schedule day indices: 0=Monday, 1=Tuesday, ..., 6=Sunday
const SCHED_DAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SCHED_DAYS_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

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

function formatDateLocal(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

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
    
    // Generate all 7 days of the week (Mon-Sun)
    const weekDates = [];
    for (let i = 0; i < 7; i++) {
        const date = new Date(monday);
        date.setDate(monday.getDate() + i);
        weekDates.push(date);
    }
    return weekDates;
}

function formatDateRange(dates) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monday = dates[0];
    const sunday = dates[6];
    
    if (monday.getMonth() === sunday.getMonth()) {
        return `${months[monday.getMonth()]} ${monday.getDate()} - ${sunday.getDate()}, ${sunday.getFullYear()}`;
    } else {
        return `${months[monday.getMonth()]} ${monday.getDate()} - ${months[sunday.getMonth()]} ${sunday.getDate()}, ${sunday.getFullYear()}`;
    }
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
async function initScheduleView() {
    setupViewToggle();
    setupFilterToggle();
    setupWeekNavigation();
    updateWeekDisplay();
    await loadScheduleData(); // This now fetches from API and handles rendering
    initSwapFeature();
    initPTONotifications();
}

function setupViewToggle() {
    const viewToggle = document.getElementById('viewToggle');
    if (!viewToggle) return;
    
    // Set initial active state based on URL/default
    viewToggle.querySelectorAll('.view-toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === employeeState.viewMode);
    });
    
    viewToggle.querySelectorAll('.view-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            viewToggle.querySelectorAll('.view-toggle-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            employeeState.viewMode = btn.dataset.view;
            updateURLView(btn.dataset.view); // Update URL
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
            renderUpcomingShifts(); // Also update upcoming list based on filter
            renderScheduleLegend(); // Update legend when filter changes (for employee mode)
        });
    });
}

// Render schedule legend - always shows roles
function renderScheduleLegend() {
    const legend = document.getElementById('scheduleLegend');
    const legendTitle = document.querySelector('.legend-title');
    if (!legend) return;
    
    legend.innerHTML = '';
    if (legendTitle) legendTitle.textContent = 'Roles';
    
    // Show roles with their colors
    employeeState.roles.forEach(role => {
        const item = document.createElement('div');
        item.className = 'legend-item';
        item.innerHTML = `
            <span class="legend-color" style="background: ${role.color || '#666'}"></span>
            <span class="legend-label">${role.name}</span>
        `;
        legend.appendChild(item);
    });
    
    // Add "Other Staff" indicator when in everyone mode
    if (employeeState.filterMode === 'everyone') {
        const otherItem = document.createElement('div');
        otherItem.className = 'legend-item';
        otherItem.innerHTML = `
            <span class="legend-color" style="background: #64748b"></span>
            <span class="legend-label">Other Staff</span>
        `;
        legend.appendChild(otherItem);
    }
}

function setupWeekNavigation() {
    const prevBtn = document.getElementById('weekNavPrev');
    const nextBtn = document.getElementById('weekNavNext');
    
    if (prevBtn) {
        prevBtn.addEventListener('click', async () => {
            employeeState.weekOffset--;
            updateURLWeek(employeeState.weekOffset);
            updateWeekDisplay();
            await loadScheduleData();
        });
    }
    
    if (nextBtn) {
        nextBtn.addEventListener('click', async () => {
            employeeState.weekOffset++;
            updateURLWeek(employeeState.weekOffset);
            updateWeekDisplay();
            await loadScheduleData();
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

async function loadScheduleData() {
    // Always fetch from API to get the latest published schedule (including swaps)
    try {
        // Use db_id for API calls (integer ID from database)
        const empId = employeeState.employee.db_id || employeeState.employee.id;
        // Send the actual week start date to avoid timezone mismatch between client/server
        const dates = getWeekDates(employeeState.weekOffset);
        const weekStart = formatDateLocal(dates[0]);
        const response = await fetch(
            `/api/employee/${employeeState.businessSlug}/${empId}/schedule?weekStart=${weekStart}&weekOffset=${employeeState.weekOffset}`
        );
        const data = await response.json();
        
        if (data.success && data.schedule) {
            employeeState.schedule = data.schedule;
        } else {
            // Fallback to localStorage if API fails
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
        }
    } catch (error) {
        console.error('Failed to load schedule from API:', error);
        // Fallback to localStorage
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
    }
    
    // Load approved PTO for the week
    await loadApprovedPTOForSchedule();
    
    renderScheduleView();
    renderScheduleLegend();
    updateHoursSummary();
    renderUpcomingShifts();
}

async function loadApprovedPTOForSchedule() {
    try {
        const dates = getWeekDates(employeeState.weekOffset);
        const weekStart = formatDateLocal(dates[0]);
        const response = await fetch(`/api/${employeeState.businessSlug}/pto/approved?weekStart=${weekStart}&weekOffset=${employeeState.weekOffset}`);
        const data = await response.json();
        
        if (data.success) {
            employeeState.approvedPTO = data.approved_pto || [];
        } else {
            employeeState.approvedPTO = [];
        }
    } catch (error) {
        console.warn('Could not load approved PTO:', error);
        employeeState.approvedPTO = [];
    }
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
function formatShortDate(date) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[date.getMonth()]} ${date.getDate()}`;
}

function renderTimelineView() {
    const container = document.getElementById('timelineGrid');
    if (!container) return;
    
    container.innerHTML = '';
    
    const dates = getWeekDates(employeeState.weekOffset);
    const schedule = employeeState.schedule;
    const myId = employeeState.employee.id;
    const showEveryone = employeeState.filterMode === 'everyone';
    const slotAssignments = schedule?.slot_assignments || {};
    
    // Calculate hours span
    const startHour = employeeState.startHour;
    const endHour = employeeState.endHour;
    const totalHours = endHour - startHour;
    
    // Build header row with hours
    const headerDiv = document.createElement('div');
    headerDiv.className = 'timeline-header';
    
    // Day column header
    const dayLabelHeader = document.createElement('div');
    dayLabelHeader.className = 'timeline-header-day';
    dayLabelHeader.textContent = 'Day';
    headerDiv.appendChild(dayLabelHeader);
    
    const hoursHeader = document.createElement('div');
    hoursHeader.className = 'timeline-header-hours';
    
    employeeState.hours.forEach(hour => {
        const hourLabel = document.createElement('div');
        hourLabel.className = 'timeline-hour-label';
        hourLabel.textContent = formatTime(hour);
        hoursHeader.appendChild(hourLabel);
    });
    
    // Add the closing hour label
    const closingLabel = document.createElement('div');
    closingLabel.className = 'timeline-hour-label timeline-closing-hour';
    closingLabel.textContent = formatTime(endHour);
    hoursHeader.appendChild(closingLabel);
    
    headerDiv.appendChild(hoursHeader);
    container.appendChild(headerDiv);
    
    // Build a row for each day
    employeeState.daysOpen.forEach(dayIdx => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'timeline-row ' + (dayIdx % 2 === 0 ? 'day-even' : 'day-odd');
        rowDiv.dataset.dayIdx = dayIdx;
        
        // Day label with date
        const dayLabel = document.createElement('div');
        dayLabel.className = 'timeline-day-label';
        const dayDate = dates[dayIdx];
        dayLabel.innerHTML = `
            <span class="day-name">${employeeState.days[dayIdx].substring(0, 3)}</span>
            <span class="day-date">${formatShortDate(dayDate)}</span>
        `;
        rowDiv.appendChild(dayLabel);
        
        // Slots container
        const slotsDiv = document.createElement('div');
        slotsDiv.className = 'timeline-slots';
        slotsDiv.dataset.dayIdx = dayIdx;
        
        // Build shift blocks for this day
        const dayAssignments = {};
        
        // Gather all assignments for this day
        employeeState.hours.forEach(hour => {
            const key = `${dayIdx},${hour}`;
            const assignments = slotAssignments[key] || [];
            assignments.forEach(assignment => {
                const empId = assignment.employee_id;
                
                // Filter by mine/everyone
                if (!showEveryone && empId !== myId) return;
                
                if (!dayAssignments[empId]) {
                    dayAssignments[empId] = { hours: [], roleId: assignment.role_id, viaSwap: false, swappedFrom: null };
                }
                // Deduplicate: don't add same hour twice for same employee
                if (!dayAssignments[empId].hours.includes(hour)) {
                    dayAssignments[empId].hours.push(hour);
                }
                // Track if any hour in shift was obtained via swap
                if (assignment.via_swap) {
                    dayAssignments[empId].viaSwap = true;
                    dayAssignments[empId].swappedFrom = assignment.swapped_from;
                }
            });
        });
        
        // Convert to shift segments
        const allShifts = [];
        Object.entries(dayAssignments).forEach(([empId, data]) => {
            const emp = employeeMap[empId];
            if (!emp) return;
            
            const hours = data.hours.sort((a, b) => a - b);
            
            // Find continuous segments
            let segStart = hours[0];
            let prevHour = hours[0];
            
            for (let i = 1; i <= hours.length; i++) {
                const currentHour = hours[i];
                
                const isGap = currentHour === undefined || currentHour !== prevHour + 1;
                
                if (isGap || i === hours.length) {
                    allShifts.push({
                        empId,
                        emp,
                        roleId: data.roleId,
                        startHour: segStart,
                        endHour: prevHour + 1,
                        viaSwap: data.viaSwap,
                        swappedFrom: data.swappedFrom
                    });
                    
                    if (i < hours.length) {
                        segStart = currentHour;
                    }
                }
                prevHour = currentHour;
            }
        });
        
        // Assign shifts to rows (greedy algorithm)
        const shiftRows = [];
        allShifts.sort((a, b) => a.startHour - b.startHour);
        
        allShifts.forEach(shift => {
            let placed = false;
            for (let rowIdx = 0; rowIdx < shiftRows.length; rowIdx++) {
                const rowShifts = shiftRows[rowIdx];
                const hasOverlap = rowShifts.some(s => 
                    shift.startHour < s.endHour && shift.endHour > s.startHour
                );
                if (!hasOverlap) {
                    shift.row = rowIdx;
                    rowShifts.push(shift);
                    placed = true;
                    break;
                }
            }
            if (!placed) {
                shift.row = shiftRows.length;
                shiftRows.push([shift]);
            }
        });
        
        // Check for PTO on this day FIRST (needed to decide row structure)
        const dayPTOList = (employeeState.approvedPTO || []).filter(pto => {
            // Filter by mine/everyone
            if (!showEveryone && pto.employee_id !== myId) return false;
            
            const ptoStart = new Date(pto.start_date + 'T00:00:00');
            const ptoEnd = new Date(pto.end_date + 'T00:00:00');
            return dayDate >= ptoStart && dayDate <= ptoEnd;
        });
        
        // Create row containers and render shifts
        // Only create empty row if there are no shifts AND no PTO
        const hasShifts = shiftRows.length > 0;
        const hasPTO = dayPTOList.length > 0;
        
        // Render shift rows (only if there are actual shifts)
        shiftRows.forEach((rowShifts, rowIdx) => {
            const rowContainer = document.createElement('div');
            rowContainer.className = 'timeline-slots-row';
            
            rowShifts.forEach(shift => {
                const duration = shift.endHour - shift.startHour;
                
                const block = document.createElement('div');
                block.className = 'timeline-shift-block';
                
                const isMine = shift.empId == myId;
                if (isMine) {
                    block.classList.add('my-shift');
                } else {
                    block.classList.add('other-shift');
                }
                
                // Calculate percentage positions
                const leftPercent = ((shift.startHour - startHour) / totalHours) * 100;
                const widthPercent = (duration / totalHours) * 100;
                block.style.left = `${leftPercent}%`;
                block.style.width = `${widthPercent}%`;
                
                // Color based on color mode setting
                const roleSet = new Set([shift.roleId]);
                const blockColor = getShiftColor(shift.empId, roleSet);
                block.style.background = blockColor;
                
                // Tooltip
                const role = roleMap[shift.roleId];
                const roleName = role?.name || 'Staff';
                let tooltipText = `${shift.emp.name}\nRole: ${roleName}\n${formatTime(shift.startHour)} - ${formatTime(shift.endHour)}`;
                
                // Add swap indicator if obtained via swap
                let swapIndicator = '';
                if (shift.viaSwap) {
                    block.classList.add('via-swap');
                    const swappedFromName = shift.swappedFrom ? (employeeMap[shift.swappedFrom]?.name || 'another employee') : 'another employee';
                    tooltipText += `\n\n🔄 Obtained via shift swap from ${swappedFromName}`;
                    swapIndicator = '<span class="swap-indicator" title="Obtained via shift swap">🔄</span>';
                }
                
                block.title = tooltipText;
                
                // Content
                block.innerHTML = `<span class="shift-name">${shift.emp.name}</span>${swapIndicator}`;
                
                // Attach click handler for popover
                const shiftData = {
                    dayIdx: dayIdx,
                    empId: shift.empId,
                    roleId: shift.roleId,
                    startHour: shift.startHour,
                    endHour: shift.endHour,
                    viaSwap: shift.viaSwap,
                    swappedFrom: shift.swappedFrom
                };
                block.addEventListener('click', (e) => showShiftPopover(e, shiftData));
                
                rowContainer.appendChild(block);
            });
            
            slotsDiv.appendChild(rowContainer);
        });
        
        // Add PTO blocks if any
        if (hasPTO) {
            const ptoRow = document.createElement('div');
            ptoRow.className = 'timeline-slots-row timeline-pto-row';
            
            dayPTOList.forEach(pto => {
                const ptoBlock = document.createElement('div');
                ptoBlock.className = 'timeline-pto-block';
                const isMine = pto.employee_id === myId;
                if (isMine) {
                    ptoBlock.classList.add('my-pto');
                } else {
                    ptoBlock.classList.add('other-pto');
                }
                
                ptoBlock.style.left = '0';
                ptoBlock.style.width = '100%';
                ptoBlock.style.cursor = 'pointer';
                
                const emoji = getPTOTypeEmojiEmployee(pto.pto_type);
                const typeLabel = capitalizeFirstEmployee(pto.pto_type);
                const name = pto.employee_name || employeeState.employee.name;
                
                ptoBlock.innerHTML = `<span class="pto-content">${name} - ${emoji} ${typeLabel}</span>`;
                ptoBlock.title = `${name}'s Time Off: ${typeLabel}`;
                
                // Add click handler for PTO popover
                ptoBlock.addEventListener('click', (e) => showPTOPopover(e, pto, isMine));
                
                ptoRow.appendChild(ptoBlock);
            });
            
            slotsDiv.appendChild(ptoRow);
        }
        
        // Ensure at least one empty row if no shifts and no PTO
        if (!hasShifts && !hasPTO) {
            const emptyRow = document.createElement('div');
            emptyRow.className = 'timeline-slots-row';
            slotsDiv.appendChild(emptyRow);
        }
        
        rowDiv.appendChild(slotsDiv);
        container.appendChild(rowDiv);
    });
}

function getAllShiftsForDay(schedule, dayIdx) {
    const shifts = [];
    
    if (!schedule || !schedule.slot_assignments) return shifts;
    
    // Group assignments by employee for this day
    const empShifts = {}; // { empId: { roleId, hours: Set, viaSwap: bool } }
    
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
                            hours: new Set(),
                            viaSwap: false,
                            swappedFrom: null
                        };
                    }
                    empShifts[key].hours.add(hour);
                    // Track if any hour in the shift was obtained via swap
                    if (assignment.via_swap) {
                        empShifts[key].viaSwap = true;
                        empShifts[key].swappedFrom = assignment.swapped_from;
                    }
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
                    end: prevHour + 1,
                    viaSwap: empShift.viaSwap,
                    swappedFrom: empShift.swappedFrom
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
                            // Track swap status
                            if (assignment.via_swap) {
                                existingShift.viaSwap = true;
                                existingShift.swappedFrom = assignment.swapped_from;
                            }
                        } else {
                            shifts.push({
                                employeeId: myId,
                                start: hour,
                                end: hour + 1,
                                role: assignment.role_id,
                                viaSwap: assignment.via_swap || false,
                                swappedFrom: assignment.swapped_from || null
                            });
                        }
                    }
                });
            }
        }
    });
    
    return shifts;
}

// Get continuous work periods for a day (merges consecutive hours regardless of role)
function getMyContinuousShiftsForDay(schedule, dayIdx) {
    const shifts = [];
    const myId = employeeState.employee.id;
    const slotAssignments = schedule?.slot_assignments || {};
    
    // Collect all hours, roles, and swap info this employee works on this day
    const hoursWorked = [];
    const hourRoles = {}; // Track roles for each hour
    const hourSwapInfo = {}; // Track swap info for each hour
    
    employeeState.hours.forEach(hour => {
        const key = `${dayIdx},${hour}`;
        const assignments = slotAssignments[key] || [];
        
        assignments.forEach(assignment => {
            if (assignment.employee_id === myId || assignment.employee_id == myId) {
                if (!hoursWorked.includes(hour)) {
                    hoursWorked.push(hour);
                }
                // Track the role for this hour (use first role found)
                if (!hourRoles[hour]) {
                    hourRoles[hour] = assignment.role_id;
                }
                // Track swap info
                if (assignment.via_swap) {
                    hourSwapInfo[hour] = {
                        viaSwap: true,
                        swappedFrom: assignment.swapped_from
                    };
                }
            }
        });
    });
    
    if (hoursWorked.length === 0) return shifts;
    
    // Sort hours and group into continuous work periods
    hoursWorked.sort((a, b) => a - b);
    
    let segmentStart = hoursWorked[0];
    let prevHour = hoursWorked[0];
    let segmentRole = hourRoles[hoursWorked[0]]; // Use first hour's role for the segment
    let segmentViaSwap = hourSwapInfo[hoursWorked[0]]?.viaSwap || false;
    let segmentSwappedFrom = hourSwapInfo[hoursWorked[0]]?.swappedFrom || null;
    
    for (let i = 1; i <= hoursWorked.length; i++) {
        const currentHour = hoursWorked[i];
        
        // If there's a gap or we're at the end, create a shift
        if (currentHour !== prevHour + 1 || i === hoursWorked.length) {
            shifts.push({
                employeeId: myId,
                start: segmentStart,
                end: prevHour + 1,
                role: segmentRole,
                viaSwap: segmentViaSwap,
                swappedFrom: segmentSwappedFrom
            });
            
            if (i < hoursWorked.length) {
                segmentStart = currentHour;
                segmentRole = hourRoles[currentHour];
                segmentViaSwap = hourSwapInfo[currentHour]?.viaSwap || false;
                segmentSwappedFrom = hourSwapInfo[currentHour]?.swappedFrom || null;
            }
        }
        // Track if any hour in segment was via swap
        if (hourSwapInfo[currentHour]?.viaSwap) {
            segmentViaSwap = true;
            segmentSwappedFrom = hourSwapInfo[currentHour]?.swappedFrom;
        }
        prevHour = currentHour;
    }
    
    return shifts;
}

// ==================== GRID VIEW ====================
function renderGridView() {
    const grid = document.getElementById('scheduleGrid');
    const gridBody = document.getElementById('scheduleGridBody');
    const eventsContainer = document.getElementById('scheduleEvents');
    if (!grid || !gridBody) return;
    
    const dates = getWeekDates(employeeState.weekOffset);
    const schedule = employeeState.schedule;
    const myId = employeeState.employee.id;
    const showEveryone = employeeState.filterMode === 'everyone';
    
    // Rebuild header with dates
    const thead = grid.querySelector('thead tr');
    if (thead) {
        thead.innerHTML = '<th class="time-col"></th>'; // Empty - time labels are in rows
        
        employeeState.daysOpen.forEach((dayIdx, colIndex) => {
            const th = document.createElement('th');
            th.className = 'day-col ' + (dayIdx % 2 === 0 ? 'day-even' : 'day-odd');
            const dayDate = dates[dayIdx];
            th.innerHTML = `
                <span class="day-name">${employeeState.days[dayIdx].substring(0, 3)}</span>
                <span class="day-date">${formatShortDate(dayDate)}</span>
            `;
            thead.appendChild(th);
        });
    }
    
    // Build grid body with time rows (include closing hour for label)
    let html = '';
    for (let hour = employeeState.startHour; hour <= employeeState.endHour; hour++) {
        const isClosingHour = hour === employeeState.endHour;
        html += `<tr class="${isClosingHour ? 'closing-hour-row' : ''}">`;
        html += `<td class="time-cell"><span>${formatTime(hour)}</span></td>`;
        
        if (!isClosingHour) {
            employeeState.daysOpen.forEach((dayIdx, colIndex) => {
                const cellClass = 'slot ' + (dayIdx % 2 === 0 ? 'day-even' : 'day-odd');
                html += `<td class="${cellClass}" data-day="${dayIdx}" data-hour="${hour}"></td>`;
            });
        } else {
            // Closing hour row - empty cells just for the time label
            employeeState.daysOpen.forEach(() => {
                html += `<td class="closing-hour-cell"></td>`;
            });
        }
        
        html += `</tr>`;
    }
    gridBody.innerHTML = html;
    
    // Clear and render shift blocks after DOM is updated
    if (eventsContainer) {
        eventsContainer.innerHTML = '';
        
        // Use setTimeout to ensure DOM is rendered before calculating positions
        setTimeout(() => {
            // Render shifts and PTO together so they can be properly positioned
            renderGridShiftsAndPTO(schedule, eventsContainer, dates, showEveryone);
        }, 0);
    }
}

function renderGridShiftsAndPTO(schedule, container, dates, showEveryone) {
    const myId = employeeState.employee.id;
    const slotAssignments = schedule?.slot_assignments || {};
    
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
    const totalRows = employeeState.endHour - employeeState.startHour;
    
    // Build all blocks (shifts + PTO) per day column
    const allBlocksByCol = {};
    employeeState.daysOpen.forEach((day, colIdx) => {
        allBlocksByCol[colIdx] = [];
    });
    
    // 1. Collect shift segments
    employeeState.daysOpen.forEach((day, colIdx) => {
        const empHours = {};
        
        employeeState.hours.forEach(hour => {
            const key = `${day},${hour}`;
            const assignments = slotAssignments[key] || [];
            
            assignments.forEach(assignment => {
                const empId = assignment.employee_id;
                if (!showEveryone && empId !== myId) return;
                
                if (!empHours[empId]) {
                    empHours[empId] = { hours: new Map(), viaSwap: false, swappedFrom: null };
                }
                if (!empHours[empId].hours.has(hour)) {
                    empHours[empId].hours.set(hour, new Set());
                }
                empHours[empId].hours.get(hour).add(assignment.role_id);
                if (assignment.via_swap) {
                    empHours[empId].viaSwap = true;
                    empHours[empId].swappedFrom = assignment.swapped_from;
                }
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
                    allBlocksByCol[colIdx].push({
                        type: 'shift',
                        employeeId,
                        roles: segmentRoles,
                        day,
                        colIdx,
                        startHour: segmentStart,
                        endHour: prevHour + 1,
                        viaSwap: data.viaSwap,
                        swappedFrom: data.swappedFrom
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
    
    // 2. Collect PTO blocks (treat them as full-day "shifts" for column assignment)
    employeeState.daysOpen.forEach((dayIdx, colIdx) => {
        const dayDate = dates[dayIdx];
        
        (employeeState.approvedPTO || []).forEach(pto => {
            if (!showEveryone && pto.employee_id !== myId) return;
            
            const ptoStart = new Date(pto.start_date + 'T00:00:00');
            const ptoEnd = new Date(pto.end_date + 'T00:00:00');
            
            if (dayDate >= ptoStart && dayDate <= ptoEnd) {
                allBlocksByCol[colIdx].push({
                    type: 'pto',
                    employeeId: pto.employee_id,
                    employeeName: pto.employee_name,
                    employeeColor: pto.employee_color,
                    ptoType: pto.pto_type,
                    day: dayIdx,
                    colIdx,
                    startHour: employeeState.startHour, // Full day
                    endHour: employeeState.endHour,
                    startDate: pto.start_date,
                    endDate: pto.end_date,
                    ptoId: pto.id
                });
            }
        });
    });
    
    // 3. Assign sub-columns for overlapping blocks (shifts AND PTO together)
    Object.entries(allBlocksByCol).forEach(([colIdx, blocks]) => {
        colIdx = parseInt(colIdx);
        blocks.sort((a, b) => a.startHour - b.startHour);
        
        const columns = [];
        blocks.forEach(block => {
            let placed = false;
            for (let subColIdx = 0; subColIdx < columns.length; subColIdx++) {
                const hasOverlap = columns[subColIdx].some(s => 
                    block.startHour < s.endHour && block.endHour > s.startHour
                );
                if (!hasOverlap) {
                    block.subColumn = subColIdx;
                    columns[subColIdx].push(block);
                    placed = true;
                    break;
                }
            }
            if (!placed) {
                block.subColumn = columns.length;
                columns.push([block]);
            }
        });
        
        const numSubColumns = columns.length || 1;
        blocks.forEach(b => b.totalSubColumns = numSubColumns);
    });
    
    // 4. Render all blocks
    const widthPadding = 6;
    const availableWidth = slotWidth - widthPadding;
    
    Object.values(allBlocksByCol).flat().forEach(block => {
        const blockWidth = block.totalSubColumns > 1 
            ? (availableWidth / block.totalSubColumns) - 1 
            : availableWidth;
        
        const leftPos = timeCellWidth + (block.colIdx * slotWidth) + (widthPadding / 2) + 
            ((block.subColumn || 0) * (blockWidth + 1));
        
        if (block.type === 'pto') {
            // Render PTO block
            const isMine = block.employeeId === myId;
            const emoji = getPTOTypeEmojiEmployee(block.ptoType);
            const typeLabel = capitalizeFirstEmployee(block.ptoType);
            const name = block.employeeName || 'Unknown';
            
            const ptoBlock = document.createElement('div');
            ptoBlock.className = `grid-pto-block ${isMine ? 'my-pto' : 'other-pto'}`;
            
            ptoBlock.style.left = `${leftPos}px`;
            ptoBlock.style.top = `${headerHeight + 2}px`;
            ptoBlock.style.width = `${blockWidth}px`;
            ptoBlock.style.height = `${totalRows * slotHeight - 4}px`;
            ptoBlock.style.zIndex = 10;
            ptoBlock.style.cursor = 'pointer';
            
            ptoBlock.innerHTML = `
                <span class="pto-name">${name}</span>
                <span class="pto-type">${emoji} ${typeLabel}</span>
            `;
            ptoBlock.title = `${name}'s Time Off: ${typeLabel}`;
            
            // Add click handler for PTO popover
            const ptoData = {
                employee_id: block.employeeId,
                employee_name: block.employeeName,
                pto_type: block.ptoType,
                start_date: block.startDate,
                end_date: block.endDate,
                id: block.ptoId
            };
            ptoBlock.addEventListener('click', (e) => showPTOPopover(e, ptoData, isMine));
            
            container.appendChild(ptoBlock);
        } else {
            // Render shift block
            const emp = employeeMap[block.employeeId];
            if (!emp) return;
            
            const isMine = block.employeeId == myId;
            const roleNames = Array.from(block.roles)
                .map(roleId => roleMap[roleId]?.name || roleId)
                .join(', ');
            
            const color = getShiftColor(block.employeeId, block.roles);
            
            const hourOffset = block.startHour - employeeState.hours[0];
            const duration = block.endHour - block.startHour;
            
            const el = document.createElement('div');
            el.className = isMine ? 'schedule-shift-block my-shift' : 'schedule-shift-block other-shift';
            if (block.viaSwap) {
                el.classList.add('via-swap');
            }
            el.style.backgroundColor = color;
            
            el.style.left = `${leftPos}px`;
            el.style.top = `${headerHeight + hourOffset * slotHeight + 2}px`;
            el.style.width = `${blockWidth}px`;
            el.style.height = `${duration * slotHeight - 4}px`;
            el.style.zIndex = 10 + (block.subColumn || 0);
            
            let tooltipText = `${emp.name}\nRoles: ${roleNames}\n${formatTime(block.startHour)} - ${formatTime(block.endHour)}`;
            let swapIndicator = '';
            if (block.viaSwap) {
                const swappedFromName = block.swappedFrom ? (employeeMap[block.swappedFrom]?.name || 'another employee') : 'another employee';
                tooltipText += `\n\n🔄 Obtained via shift swap from ${swappedFromName}`;
                swapIndicator = '<span class="swap-indicator">🔄</span>';
            }
            
            el.innerHTML = `<span class="shift-name">${emp.name}</span>${swapIndicator}`;
            el.title = tooltipText;
            
            // Attach click handler for popover
            const shiftData = {
                dayIdx: block.day,
                empId: block.employeeId,
                roleId: Array.from(block.roles)[0],
                startHour: block.startHour,
                endHour: block.endHour,
                viaSwap: block.viaSwap,
                swappedFrom: block.swappedFrom
            };
            el.addEventListener('click', (e) => showShiftPopover(e, shiftData));
            
            container.appendChild(el);
        }
    });
}

// Keep for backwards compatibility but not used in grid view anymore
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
    
    // Process each day - use colIdx for column position
    employeeState.daysOpen.forEach((day, colIdx) => {
        const empHours = {};
        
        employeeState.hours.forEach(hour => {
            const key = `${day},${hour}`;
            const assignments = slotAssignments[key] || [];
            
            assignments.forEach(assignment => {
                const empId = assignment.employee_id;
                
                // Filter by mine/everyone
                if (!showEveryone && empId !== myId) return;
                
                if (!empHours[empId]) {
                    empHours[empId] = { hours: new Map(), viaSwap: false, swappedFrom: null };
                }
                if (!empHours[empId].hours.has(hour)) {
                    empHours[empId].hours.set(hour, new Set());
                }
                empHours[empId].hours.get(hour).add(assignment.role_id);
                // Track swap info
                if (assignment.via_swap) {
                    empHours[empId].viaSwap = true;
                    empHours[empId].swappedFrom = assignment.swapped_from;
                }
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
                        colIdx, // Use column index for positioning
                        startHour: segmentStart,
                        endHour: prevHour + 1,
                        viaSwap: data.viaSwap,
                        swappedFrom: data.swappedFrom
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
    
    // Assign columns for overlapping shifts within each day column
    const blocksByCol = {};
    employeeState.daysOpen.forEach((day, colIdx) => {
        blocksByCol[colIdx] = shiftSegments.filter(s => s.colIdx === colIdx);
    });
    
    Object.entries(blocksByCol).forEach(([colIdx, blocks]) => {
        colIdx = parseInt(colIdx);
        blocks.sort((a, b) => a.startHour - b.startHour);
        
        const columns = [];
        blocks.forEach(block => {
            let placed = false;
            for (let subColIdx = 0; subColIdx < columns.length; subColIdx++) {
                const hasOverlap = columns[subColIdx].some(s => 
                    block.startHour < s.endHour && block.endHour > s.startHour
                );
                if (!hasOverlap) {
                    block.subColumn = subColIdx;
                    columns[subColIdx].push(block);
                    placed = true;
                    break;
                }
            }
            if (!placed) {
                block.subColumn = columns.length;
                columns.push([block]);
            }
        });
        
        const numSubColumns = columns.length || 1;
        blocks.forEach(b => b.totalSubColumns = numSubColumns);
    });
    
    // Render shift blocks
    shiftSegments.forEach(segment => {
        const emp = employeeMap[segment.employeeId];
        if (!emp) return;
        
        const isMine = segment.employeeId == myId;
        const roleNames = Array.from(segment.roles)
            .map(roleId => roleMap[roleId]?.name || roleId)
            .join(', ');
        
        // Get color based on color mode setting
        const color = getShiftColor(segment.employeeId, segment.roles);
        
        const hourOffset = segment.startHour - employeeState.hours[0];
        const duration = segment.endHour - segment.startHour;
        
        const widthPadding = 6;
        const availableWidth = slotWidth - widthPadding;
        const blockWidth = segment.totalSubColumns > 1 
            ? (availableWidth / segment.totalSubColumns) - 1 
            : availableWidth;
        
        const el = document.createElement('div');
        el.className = isMine ? 'schedule-shift-block my-shift' : 'schedule-shift-block other-shift';
        if (segment.viaSwap) {
            el.classList.add('via-swap');
        }
        el.style.backgroundColor = color;
        
        // Use colIdx for column position (not day number)
        const leftPos = timeCellWidth + (segment.colIdx * slotWidth) + (widthPadding / 2) + 
            ((segment.subColumn || 0) * (blockWidth + 1));
        el.style.left = `${leftPos}px`;
        el.style.top = `${headerHeight + hourOffset * slotHeight + 2}px`;
        el.style.width = `${blockWidth}px`;
        el.style.height = `${duration * slotHeight - 4}px`;
        el.style.zIndex = 10 + (segment.subColumn || 0);
        
        // Build tooltip
        let tooltipText = `${emp.name}\nRoles: ${roleNames}\n${formatTime(segment.startHour)} - ${formatTime(segment.endHour)}`;
        let swapIndicator = '';
        if (segment.viaSwap) {
            const swappedFromName = segment.swappedFrom ? (employeeMap[segment.swappedFrom]?.name || 'another employee') : 'another employee';
            tooltipText += `\n\n🔄 Obtained via shift swap from ${swappedFromName}`;
            swapIndicator = '<span class="swap-indicator">🔄</span>';
        }
        
        el.innerHTML = `<span class="shift-name">${emp.name}</span>${swapIndicator}`;
        el.title = tooltipText;
        
        // Attach click handler for popover
        const shiftData = {
            dayIdx: segment.day,
            empId: segment.employeeId,
            roleId: Array.from(segment.roles)[0],
            startHour: segment.startHour,
            endHour: segment.endHour,
            viaSwap: segment.viaSwap,
            swappedFrom: segment.swappedFrom
        };
        el.addEventListener('click', (e) => showShiftPopover(e, shiftData));
        
        container.appendChild(el);
    });
}

// ==================== TABLE VIEW ====================
function renderTableView() {
    const tbody = document.getElementById('simpleScheduleBody');
    const table = document.getElementById('simpleScheduleTable');
    if (!tbody || !table) return;
    
    const dates = getWeekDates(employeeState.weekOffset);
    const schedule = employeeState.schedule;
    const myId = employeeState.employee.id;
    const showEveryone = employeeState.filterMode === 'everyone';
    const slotAssignments = schedule?.slot_assignments || {};
    
    // Rebuild header with dates
    const thead = table.querySelector('thead tr');
    if (thead) {
        const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        
        thead.innerHTML = '<th class="name-col">Name</th>';
        
        // Add day columns with dates
        for (let i = 0; i < 7; i++) {
            const th = document.createElement('th');
            th.className = i % 2 === 0 ? 'day-even' : 'day-odd';
            th.innerHTML = `
                <span class="day-name">${dayNames[i]}</span>
                <span class="day-date">${formatShortDate(dates[i])}</span>
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
    
    // Build employee schedule data
    const employeeSchedules = {}; // { empId: { employee, days: { 0: [{start, end}], ... }, totalHours: 0 } }
    
    // Initialize for relevant employees
    const relevantEmployees = showEveryone ? employeeState.allEmployees : [employeeState.employee];
    relevantEmployees.forEach(emp => {
        employeeSchedules[emp.id] = {
            employee: emp,
            days: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] },
            totalHours: 0
        };
    });
    
    // Process slot assignments to build shift segments
    for (let day = 0; day < 7; day++) {
        const empHoursToday = {}; // { empId: [hours...] }
        
        employeeState.hours.forEach(hour => {
            const key = `${day},${hour}`;
            const assignments = slotAssignments[key] || [];
            
            assignments.forEach(assignment => {
                const empId = assignment.employee_id;
                
                // Filter by mine/everyone
                if (!showEveryone && empId !== myId) return;
                
                if (!empHoursToday[empId]) {
                    empHoursToday[empId] = [];
                }
                // Deduplicate: don't add same hour twice for same employee
                if (!empHoursToday[empId].includes(hour)) {
                    empHoursToday[empId].push(hour);
                }
            });
        });
        
        // Convert hours to shift segments
        Object.entries(empHoursToday).forEach(([empId, hours]) => {
            if (!employeeSchedules[empId]) {
                // Employee not in our list, add them
                const emp = employeeMap[empId];
                if (emp) {
                    employeeSchedules[empId] = {
                        employee: emp,
                        days: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] },
                        totalHours: 0
                    };
                } else {
                    return;
                }
            }
            
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
    
    // Build PTO data by employee for this week
    const ptoByEmployee = {};
    (employeeState.approvedPTO || []).forEach(pto => {
        const empKey = pto.employee_id;
        
        // Filter by mine/everyone
        if (!showEveryone && empKey !== myId) return;
        
        if (!ptoByEmployee[empKey]) {
            ptoByEmployee[empKey] = {
                employee_id: pto.employee_id,
                employee_name: pto.employee_name,
                employee_color: pto.employee_color,
                pto_type: pto.pto_type,
                days: {},
                dayPtoData: {} // Store full PTO info per day for popover
            };
        }
        
        // Mark which days have PTO
        const ptoStart = new Date(pto.start_date + 'T00:00:00');
        const ptoEnd = new Date(pto.end_date + 'T00:00:00');
        
        for (let day = 0; day < 7; day++) {
            const dayDate = dates[day];
            if (dayDate >= ptoStart && dayDate <= ptoEnd) {
                ptoByEmployee[empKey].days[day] = pto.pto_type;
                // Store full PTO data for this day
                ptoByEmployee[empKey].dayPtoData[day] = {
                    employee_id: pto.employee_id,
                    employee_name: pto.employee_name,
                    employee_color: pto.employee_color,
                    pto_type: pto.pto_type,
                    start_date: pto.start_date,
                    end_date: pto.end_date,
                    id: pto.id
                };
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
        
        let emp, totalHours, days;
        if (schedule) {
            emp = schedule.employee;
            totalHours = schedule.totalHours;
            days = schedule.days;
        } else {
            // Employee only has PTO, no scheduled shifts
            emp = employeeMap[empId] || {
                id: empId,
                name: pto.employee_name,
                color: pto.employee_color
            };
            totalHours = 0;
            days = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
        }
        
        const ptoDays = pto ? Object.keys(pto.days).length : 0;
        
        if (totalHours > 0 || ptoDays > 0) {
            combinedEmployeeData.push({
                emp,
                totalHours,
                days,
                pto: pto || null,
                ptoDays,
                isMine: empId === myId || empId == myId
            });
        }
    });
    
    // Sort: my row first, then by hours, then PTO-only
    combinedEmployeeData.sort((a, b) => {
        // My row always first
        if (a.isMine && !b.isMine) return -1;
        if (!a.isMine && b.isMine) return 1;
        // Both have hours - sort by hours
        if (a.totalHours > 0 && b.totalHours > 0) return b.totalHours - a.totalHours;
        // One has hours, one doesn't
        if (a.totalHours > 0) return -1;
        if (b.totalHours > 0) return 1;
        // Both PTO only - sort by name
        return a.emp.name.localeCompare(b.emp.name);
    });
    
    // Render employee rows (including PTO in same row)
    if (combinedEmployeeData.length > 0) {
        combinedEmployeeData.forEach(({ emp, totalHours, days, pto, isMine }) => {
            const row = document.createElement('tr');
            row.className = isMine ? 'my-row' : '';
            
            // Get color based on color mode setting
            const empRoles = emp.roles || [];
            const roleSet = empRoles.length > 0 ? new Set([empRoles[0]]) : new Set();
            const displayColor = getShiftColor(emp.id, roleSet);
            
            let html = `<td class="name-col"><div class="emp-name">
                <span class="emp-color" style="background: ${displayColor}"></span>
                <span>${emp.name}</span>
            </div></td>`;
            
            for (let day = 0; day < 7; day++) {
                const dayClass = day % 2 === 0 ? 'day-even' : 'day-odd';
                const hasPTO = pto && pto.days[day];
                const shifts = days[day] || [];
                
                if (hasPTO) {
                    // Show PTO badge for this day (clickable)
                    const emoji = getPTOTypeEmojiEmployee(pto.days[day]);
                    const ptoData = pto.dayPtoData[day];
                    const isMine = emp.id === myId;
                    html += `<td class="shift-times ${dayClass}">
                        <span class="table-pto-cell clickable-pto" 
                            data-pto-id="${ptoData.id}"
                            data-pto-type="${ptoData.pto_type}"
                            data-pto-start="${ptoData.start_date}"
                            data-pto-end="${ptoData.end_date}"
                            data-emp-id="${ptoData.employee_id}"
                            data-emp-name="${ptoData.employee_name}"
                            data-is-mine="${isMine}">
                            <span class="pto-emoji">${emoji}</span>${capitalizeFirstEmployee(pto.days[day])}
                        </span>
                    </td>`;
                } else if (shifts.length === 0) {
                    html += `<td class="shift-times ${dayClass}"><span class="no-shift">—</span></td>`;
                } else {
                    // Build shift blocks with tooltips
                    const roleNames = (emp.roles || []).map(rid => roleMap[rid]?.name || 'Staff').join(', ');
                    const shiftStrs = shifts.map(s => {
                        const duration = s.end - s.start;
                        const tooltip = `${emp.name}\nRoles: ${roleNames || 'Staff'}\n${formatTime(s.start)} - ${formatTime(s.end)}\n${duration} hours`;
                        const dataAttrs = `data-emp-id="${emp.id}" data-day="${day}" data-start="${s.start}" data-end="${s.end}"`;
                        return `<span class="shift-block table-shift-clickable" ${dataAttrs} title="${tooltip}">${formatTime(s.start)}-${formatTime(s.end)}</span>`;
                    }).join('');
                    html += `<td class="shift-times ${dayClass}">${shiftStrs}</td>`;
                }
            }
            
            const hoursDisplay = totalHours > 0 ? `${totalHours}h` : 'Off';
            html += `<td class="total-hours">${hoursDisplay}</td>`;
            row.innerHTML = html;
            tbody.appendChild(row);
        });
        
        // Add click handlers for table PTO cells
        tbody.querySelectorAll('.clickable-pto').forEach(cell => {
            cell.addEventListener('click', (e) => {
                const ptoData = {
                    id: cell.dataset.ptoId,
                    pto_type: cell.dataset.ptoType,
                    start_date: cell.dataset.ptoStart,
                    end_date: cell.dataset.ptoEnd,
                    employee_id: cell.dataset.empId,
                    employee_name: cell.dataset.empName
                };
                const isMine = cell.dataset.isMine === 'true';
                showPTOPopover(e, ptoData, isMine);
            });
        });
        
        // Add click handlers for table shift blocks (for popover)
        tbody.querySelectorAll('.table-shift-clickable').forEach(cell => {
            cell.addEventListener('click', (e) => {
                const shiftData = {
                    empId: cell.dataset.empId,
                    day: parseInt(cell.dataset.day),
                    startHour: parseInt(cell.dataset.start),
                    endHour: parseInt(cell.dataset.end)
                };
                showShiftPopover(e, shiftData);
            });
        });
    } else {
        // No shifts - show empty table structure with placeholder rows
        for (let r = 0; r < 3; r++) {
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
        }
    }
}

function updateHoursSummary() {
    const schedule = employeeState.schedule;
    const myId = employeeState.employee.id;
    const slotAssignments = schedule?.slot_assignments || {};
    
    let totalHours = 0;
    let shiftCount = 0;
    
    if (schedule) {
        // Count shifts by finding continuous work periods (regardless of role)
        employeeState.daysOpen.forEach(dayIdx => {
            // Collect all hours this employee works on this day
            const hoursWorked = [];
            
            employeeState.hours.forEach(hour => {
                const key = `${dayIdx},${hour}`;
                const assignments = slotAssignments[key] || [];
                
                // Check if employee is assigned to this hour (any role)
                if (assignments.some(a => a.employee_id === myId || a.employee_id == myId)) {
                    hoursWorked.push(hour);
                }
            });
            
            if (hoursWorked.length === 0) return;
            
            // Sort hours and count continuous work periods
            hoursWorked.sort((a, b) => a - b);
            
            let segmentStart = hoursWorked[0];
            let prevHour = hoursWorked[0];
            
            for (let i = 1; i <= hoursWorked.length; i++) {
                const currentHour = hoursWorked[i];
                
                // If there's a gap or we're at the end, count this as one shift
                if (currentHour !== prevHour + 1 || i === hoursWorked.length) {
                    totalHours += (prevHour + 1 - segmentStart);
                    shiftCount++; // One continuous work period = one shift
                    
                    if (i < hoursWorked.length) {
                        segmentStart = currentHour;
                    }
                }
                prevHour = currentHour;
            }
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
    
    const currentEmpId = employeeState.employee.id;
    const showEveryone = employeeState.filterMode === 'everyone';
    
    // Combined list of shifts and PTO, all sorted together by date
    const upcomingItems = [];
    
    // Add MY shifts
    if (schedule) {
        employeeState.daysOpen.forEach(dayIdx => {
            const date = dates[dayIdx];
            if (date >= today) {
                const shifts = getMyContinuousShiftsForDay(schedule, dayIdx);
                shifts.forEach(shift => {
                    upcomingItems.push({
                        type: 'shift',
                        ...shift,
                        date: date,
                        dayIdx: dayIdx,
                        isMyItem: true
                    });
                });
            }
        });
    }
    
    // Add PTO (my own, or everyone's if showEveryone)
    (employeeState.approvedPTO || []).forEach(pto => {
        const isMyPTO = pto.employee_id === currentEmpId;
        
        // Skip other people's PTO if not in "everyone" mode
        if (!isMyPTO && !showEveryone) return;
        
        const ptoStart = new Date(pto.start_date + 'T00:00:00');
        const ptoEnd = new Date(pto.end_date + 'T00:00:00');
        
        // Check each day in the week
        dates.forEach((date, dayIdx) => {
            if (date >= today && date >= ptoStart && date <= ptoEnd) {
                upcomingItems.push({
                    type: 'pto',
                    date: date,
                    dayIdx: dayIdx,
                    pto_type: pto.pto_type,
                    employee_id: pto.employee_id,
                    employee_name: pto.employee_name,
                    employee_color: pto.employee_color,
                    isMyItem: isMyPTO
                });
            }
        });
    });
    
    // Sort ALL items by date (shifts and PTO together)
    upcomingItems.sort((a, b) => {
        const dateDiff = a.date - b.date;
        if (dateDiff !== 0) return dateDiff;
        // If same date, put shifts before PTO
        if (a.type !== b.type) return a.type === 'shift' ? -1 : 1;
        // If both shifts on same day, sort by start time
        if (a.type === 'shift' && b.type === 'shift') return a.start - b.start;
        return 0;
    });
    
    // Take first 7 items (increased to show more context)
    const displayItems = upcomingItems.slice(0, 7);
    
    // Clear existing items
    listContainer.querySelectorAll('.upcoming-shift-item, .upcoming-pto-item').forEach(el => el.remove());
    
    if (displayItems.length === 0) {
        if (noShiftsMsg) noShiftsMsg.style.display = 'block';
        return;
    }
    
    if (noShiftsMsg) noShiftsMsg.style.display = 'none';
    
    let html = '';
    displayItems.forEach(item => {
        if (item.type === 'shift') {
            const role = roleMap[item.role] || {};
            const duration = item.end - item.start;
        
        // Create a unique shift identifier for the swap button
        const shiftData = JSON.stringify({
                dayIdx: item.dayIdx,
                start: item.start,
                end: item.end,
                role: item.role
        }).replace(/"/g, '&quot;');
        
        // Check if shift was obtained via swap
            const swapBadge = item.viaSwap 
                ? `<span class="swap-badge" title="Obtained via shift swap from ${employeeMap[item.swappedFrom]?.name || 'another employee'}">🔄 Swapped</span>` 
            : '';
        
        // Add data attributes for click handler
            const dataAttrs = `data-day="${item.dayIdx}" data-start="${item.start}" data-end="${item.end}" data-role="${item.role}" data-via-swap="${item.viaSwap || ''}" data-swapped-from="${item.swappedFrom || ''}"`;
        
            html += `<div class="upcoming-shift-item ${item.viaSwap ? 'via-swap' : ''}" ${dataAttrs}>
            <div class="shift-date-badge">
                    <span class="day-name">${SCHED_DAYS_SHORT[item.dayIdx]}</span>
                    <span class="day-num">${item.date.getDate()}</span>
            </div>
            <div class="shift-details shift-clickable" title="Click to view details">
                    <div class="shift-time">${formatTimeRange(item.start, item.end)} ${swapBadge}</div>
                <div class="shift-role">
                    <span class="shift-role-dot" style="background: ${role.color || '#6366f1'}"></span>
                    ${role.name || 'Shift'}
                </div>
            </div>
            <div class="shift-actions">
                <div class="shift-duration">${duration}h</div>
                <button class="shift-swap-btn" title="Request to swap this shift" onclick='showSwapModal(${shiftData})'>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="17 1 21 5 17 9"></polyline>
                        <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
                        <polyline points="7 23 3 19 7 15"></polyline>
                        <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
                    </svg>
                </button>
            </div>
        </div>`;
        } else {
            // PTO item
            const emoji = getPTOTypeEmojiEmployee(item.pto_type);
            const typeLabel = capitalizeFirstEmployee(item.pto_type);
            const isOtherPerson = !item.isMyItem;
            const personLabel = isOtherPerson ? item.employee_name : '';
            
            html += `<div class="upcoming-pto-item ${isOtherPerson ? 'other-pto' : ''}">
                <div class="pto-date-badge" style="${isOtherPerson ? `background: ${item.employee_color || '#8b5cf6'}` : ''}">
                    <span class="day-name">${SCHED_DAYS_SHORT[item.dayIdx]}</span>
                    <span class="day-num">${item.date.getDate()}</span>
            </div>
            <div class="pto-details">
                    <div class="pto-title">${emoji} Time Off${isOtherPerson ? ` - ${personLabel}` : ''}</div>
                <div class="pto-subtitle">${typeLabel}</div>
            </div>
        </div>`;
        }
    });
    
    // Insert before no-shifts message
    if (noShiftsMsg) {
        noShiftsMsg.insertAdjacentHTML('beforebegin', html);
    } else {
        listContainer.innerHTML = html;
    }
}

function getPTOTypeEmojiEmployee(type) {
    switch (type) {
        case 'vacation': return '🌴';
        case 'sick': return '🤒';
        case 'personal': return '👤';
        default: return '📋';
    }
}

function capitalizeFirstEmployee(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

// ==================== AVAILABILITY EDITOR ====================
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Day conversion: Backend uses Mon=0, Sun=6. Display uses Sun=0, Sat=6.
function dataToDisplayDay(dataDay) {
    // Mon(0)->1, Tue(1)->2, ..., Sat(5)->6, Sun(6)->0
    return (dataDay + 1) % 7;
}

function displayToDataDay(displayDay) {
    // Sun(0)->6, Mon(1)->0, Tue(2)->1, ..., Sat(6)->5
    return displayDay === 0 ? 6 : displayDay - 1;
}

function initAvailabilityEditor() {
    console.log('[EmployeeAvail] initAvailabilityEditor called');
    console.log('[EmployeeAvail] Raw EMPLOYEE_DATA.availability:', EMPLOYEE_DATA.availability);
    console.log('[EmployeeAvail] employeeState.availability before conversion:', JSON.stringify(employeeState.availability));
    
    // Convert from backend day format (Mon=0) to display format (Sun=0)
    if (employeeState.availability && typeof employeeState.availability === 'object') {
        const converted = {};
        Object.entries(employeeState.availability).forEach(([dataDay, ranges]) => {
            const displayDay = dataToDisplayDay(parseInt(dataDay));
            converted[displayDay] = ranges;
            console.log(`[EmployeeAvail] DataDay ${dataDay} -> DisplayDay ${displayDay}:`, ranges);
        });
        employeeState.availability = converted;
    }

    // Initialize with default "All Day" if no availability exists
    if (!employeeState.availability || Object.keys(employeeState.availability).length === 0) {
        console.log('[EmployeeAvail] No availability found, using defaults');
        employeeState.availability = {};
        for (let day = 0; day < 7; day++) {
            employeeState.availability[day] = [[employeeState.startHour, employeeState.endHour]];
        }
    }
    
    console.log('[EmployeeAvail] Final availability (display days):', JSON.stringify(employeeState.availability));
    renderAvailabilityTable();
    setupSaveButton();
    updateAvailabilityStats();
}

function renderAvailabilityTable() {
    const container = document.getElementById('availabilityCardsView');
    if (!container) return;
    
    const availability = employeeState.availability || {};
    
    let html = `<div class="availability-table">`;
    
    for (let day = 0; day < 7; day++) {
        // Handle both string and number keys just in case
        const dayRanges = availability[day] || availability[day.toString()] || [];
        const hasRanges = dayRanges.length > 0;
        
        html += `
            <div class="avail-day-row" data-day="${day}">
                <div class="avail-day-name">${DAY_NAMES_SHORT[day]}</div>
                <div class="avail-day-times">
        `;
        
        if (hasRanges) {
            dayRanges.forEach((range, idx) => {
                const [start, end] = range;
                const startParts = decimalToTimeParts(start);
                const endParts = decimalToTimeParts(end);
                
                html += `
                    <div class="avail-time-row" data-day="${day}" data-idx="${idx}">
                        <button class="avail-remove-row-btn" data-day="${day}" data-idx="${idx}" title="Remove">−</button>
                        ${renderTimeInput('start', day, idx, startParts)}
                        <span class="avail-time-sep">to</span>
                        ${renderTimeInput('end', day, idx, endParts)}
                    </div>
                `;
            });
        } else {
            html += `<div class="avail-not-set">Not available</div>`;
        }
        
        html += `
                </div>
                <button class="avail-add-btn" data-day="${day}" title="Add time range">+</button>
            </div>
        `;
    }
    
    html += `</div>`;
    container.innerHTML = html;
    
    // Setup event listeners
    setupAvailabilityTableListeners();
}

function renderTimeInput(type, day, idx, parts) {
    const hours = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const mins = ['00', '15', '30', '45'];
    const ampms = ['AM', 'PM'];
    
    return `
        <div class="time-input-group" data-type="${type}" data-day="${day}" data-idx="${idx}">
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
    const minutes = Math.round((decimal - hour24) * 60);
    
    let hour12 = hour24 % 12;
    if (hour12 === 0) hour12 = 12;
    
    const ampm = hour24 < 12 ? 'am' : 'pm';
    const min = minutes.toString().padStart(2, '0');
    
    return { hour: hour12, min, ampm };
}

function timePartsToDecimal(hour, min, ampm) {
    let hour24 = parseInt(hour);
    const minutes = parseInt(min);
    
    if (ampm === 'am') {
        if (hour24 === 12) hour24 = 0;
    } else {
        if (hour24 !== 12) hour24 += 12;
    }
    
    return hour24 + (minutes / 60);
}

function formatTime12(time) {
    const hour = Math.floor(time);
    const minutes = Math.round((time - hour) * 60);
    const minuteStr = minutes > 0 ? `:${minutes.toString().padStart(2, '0')}` : '';
    
    if (hour === 0) return `12${minuteStr}am`;
    if (hour === 12) return `12${minuteStr}pm`;
    if (hour < 12) return `${hour}${minuteStr}am`;
    return `${hour - 12}${minuteStr}pm`;
}

function setupAvailabilityTableListeners() {
    // Custom dropdown click handlers
    document.querySelectorAll('.custom-select').forEach(select => {
        const valueEl = select.querySelector('.custom-select-value');
        const dropdown = select.querySelector('.custom-select-dropdown');
        
        // Toggle dropdown on click
        valueEl.addEventListener('click', (e) => {
            e.stopPropagation();
            // Close all other dropdowns
            document.querySelectorAll('.custom-select.open').forEach(s => {
                if (s !== select) s.classList.remove('open');
            });
            select.classList.toggle('open');
        });
        
        // Option selection
        dropdown.querySelectorAll('.custom-select-option').forEach(option => {
            option.addEventListener('click', (e) => {
                e.stopPropagation();
                const value = option.dataset.value;
                select.dataset.value = value;
                valueEl.textContent = option.textContent;
                
                // Update selected state
                dropdown.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
                option.classList.add('selected');
                
                select.classList.remove('open');
                updateTimeFromCustomInputs(select.closest('.time-input-group'));
            });
        });
        
        // Keyboard support for AM/PM
        if (select.classList.contains('time-ampm-select')) {
            select.setAttribute('tabindex', '0');
            select.addEventListener('keydown', (e) => {
                if (e.key.toLowerCase() === 'a') {
                    selectCustomOption(select, 'am', 'AM');
                } else if (e.key.toLowerCase() === 'p') {
                    selectCustomOption(select, 'pm', 'PM');
                }
            });
        }
    });
    
    // Close dropdowns when clicking outside
    document.addEventListener('click', () => {
        document.querySelectorAll('.custom-select.open').forEach(s => s.classList.remove('open'));
    });
    
    // Add button
    document.querySelectorAll('.avail-add-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const day = parseInt(btn.dataset.day);
            if (!employeeState.availability[day]) {
                employeeState.availability[day] = [];
            }
            // Add default all-day range
            employeeState.availability[day].push([employeeState.startHour, employeeState.endHour]);
            renderAvailabilityTable();
            updateAvailabilityStats();
        });
    });
    
    // Remove individual row button
    document.querySelectorAll('.avail-remove-row-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const day = parseInt(btn.dataset.day);
            const idx = parseInt(btn.dataset.idx);
            if (employeeState.availability[day]) {
                employeeState.availability[day].splice(idx, 1);
                if (employeeState.availability[day].length === 0) {
                    delete employeeState.availability[day];
                }
                renderAvailabilityTable();
                updateAvailabilityStats();
            }
        });
    });
}

function selectCustomOption(select, value, display) {
    select.dataset.value = value;
    select.querySelector('.custom-select-value').textContent = display;
    select.querySelectorAll('.custom-select-option').forEach(o => {
        o.classList.toggle('selected', o.dataset.value === value);
    });
    select.classList.remove('open');
    updateTimeFromCustomInputs(select.closest('.time-input-group'));
}

function updateTimeFromCustomInputs(inputGroup) {
    const type = inputGroup.dataset.type;
    const day = parseInt(inputGroup.dataset.day);
    const idx = parseInt(inputGroup.dataset.idx);
    
    const hour = inputGroup.querySelector('[data-field="hour"]').dataset.value;
    const min = inputGroup.querySelector('[data-field="min"]').dataset.value;
    const ampm = inputGroup.querySelector('[data-field="ampm"]').dataset.value;
    
    const decimal = timePartsToDecimal(hour, min, ampm);
    
    // Ensure we check for both string and number keys
    let dayAvail = employeeState.availability[day] || employeeState.availability[day.toString()];
    if (!dayAvail) return;
    
    // Ensure it's stored under the numeric key for consistency
    employeeState.availability[day] = dayAvail;
    
    const isStart = type === 'start';
    if (isStart) {
        dayAvail[idx][0] = decimal;
    } else {
        dayAvail[idx][1] = decimal;
    }
    
    // Validate: end must be after start
    const [start, end] = dayAvail[idx];
    if (end <= start) {
        if (isStart) {
            employeeState.availability[day][idx][1] = Math.min(start + 0.25, employeeState.endHour);
        } else {
            employeeState.availability[day][idx][0] = Math.max(end - 0.25, employeeState.startHour);
        }
        renderAvailabilityTable();
    }
    
    updateAvailabilityStats();
}

function isHourAvailable(day, hour) {
    const availability = employeeState.availability || {};
    const dayAvail = availability[day];
    
    if (!dayAvail || !Array.isArray(dayAvail)) return false;
    
    // dayAvail is array of [start, end] tuples
    return dayAvail.some(([start, end]) => hour >= start && hour < end);
}

// Note: Old grid functions removed - now using cards view

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
    
    // Format hours nicely (e.g., 8.5 -> "8.5", 8 -> "8")
    const hoursDisplay = totalHours % 1 === 0 ? totalHours : totalHours.toFixed(1);
    
    if (hoursEl) hoursEl.textContent = hoursDisplay;
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
        // Convert display days (Sun=0) back to data days (Mon=0) for the backend
        const availabilityForBackend = {};
        Object.entries(employeeState.availability).forEach(([displayDay, ranges]) => {
            const dataDay = displayToDataDay(parseInt(displayDay));
            availabilityForBackend[dataDay] = ranges;
        });
        console.log('[EmployeeAvail] Saving availability, converted to backend format:', availabilityForBackend);
        
        const empId = employeeState.employee.db_id || employeeState.employee.id;
        const response = await fetch(`/api/employee/${empId}/availability`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                business_id: employeeState.business.id,
                availability: availabilityForBackend
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            // Update local state with returned availability (convert back to display days)
            if (data.availability) {
                const converted = {};
                Object.entries(data.availability).forEach(([dataDay, ranges]) => {
                    const displayDay = dataToDisplayDay(parseInt(dataDay));
                    converted[displayDay] = ranges;
                });
                employeeState.availability = converted;
            }
            
            if (status) {
                status.textContent = 'Saved!';
                status.className = 'save-status saved';
            }
            showToast('Availability saved successfully', 'success');
            renderAvailabilityTable(); // Re-render to ensure everything matches
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

// ==================== SHIFT SWAP FEATURE ====================

function initSwapFeature() {
    // Setup modal events
    setupSwapModals();
    // Setup notification bell
    initNotificationBell();
    // Load existing swap requests
    loadSwapRequests();
}

function setupSwapModals() {
    // Create Swap Request Modal
    const closeSwapModal = document.getElementById('closeSwapModal');
    const cancelSwapBtn = document.getElementById('cancelSwapBtn');
    const submitSwapBtn = document.getElementById('submitSwapBtn');
    
    if (closeSwapModal) {
        closeSwapModal.addEventListener('click', hideSwapModal);
    }
    if (cancelSwapBtn) {
        cancelSwapBtn.addEventListener('click', hideSwapModal);
    }
    if (submitSwapBtn) {
        submitSwapBtn.addEventListener('click', submitSwapRequest);
    }
    
    // Swap Response Modal
    const closeSwapResponseModal = document.getElementById('closeSwapResponseModal');
    const declineSwapBtn = document.getElementById('declineSwapBtn');
    const acceptSwapBtn = document.getElementById('acceptSwapBtn');
    
    if (closeSwapResponseModal) {
        closeSwapResponseModal.addEventListener('click', hideSwapResponseModal);
    }
    if (declineSwapBtn) {
        declineSwapBtn.addEventListener('click', declineSwapRequest);
    }
    if (acceptSwapBtn) {
        acceptSwapBtn.addEventListener('click', acceptSwapRequest);
    }
    
    // Counter-offer toggle
    const counterOfferToggle = document.getElementById('counterOfferToggle');
    if (counterOfferToggle) {
        counterOfferToggle.addEventListener('click', toggleCounterOffer);
    }
    
    // Close modals when clicking overlay
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.style.display = 'none';
            }
        });
    });
}

// Counter-offer functionality
function toggleCounterOffer() {
    const toggle = document.getElementById('counterOfferToggle');
    const shiftsContainer = document.getElementById('counterOfferShifts');
    const acceptBtn = document.getElementById('acceptSwapBtn');
    const request = employeeState.currentSwapRequest;
    
    if (!toggle || !shiftsContainer) return;
    
    // Don't allow collapse if swap is required
    if (request?.my_eligibility_type === 'swap_only') {
        return;
    }
    
    const isExpanded = toggle.classList.contains('active');
    
    if (isExpanded) {
        // Collapse - clear selection and revert to pickup mode
        toggle.classList.remove('active');
        shiftsContainer.style.display = 'none';
        employeeState.selectedSwapShift = null;
        if (acceptBtn) {
            acceptBtn.textContent = 'Accept Pickup';
            acceptBtn.disabled = false;
        }
    } else {
        // Expand and load shifts
        toggle.classList.add('active');
        shiftsContainer.style.display = 'block';
        loadMyShiftsForCounterOffer();
    }
}

function loadMyShiftsForCounterOffer() {
    const list = document.getElementById('myShiftsForSwap');
    if (!list) return;
    
    // Get current user's shifts from the schedule
    const myShifts = getMyUpcomingShifts();
    
    if (myShifts.length === 0) {
        list.innerHTML = '<div class="notification-empty">You have no upcoming shifts to offer</div>';
        return;
    }
    
    const dates = getWeekDates(employeeState.weekOffset);
    
    list.innerHTML = myShifts.map((shift, idx) => {
        const dayName = employeeState.days[shift.dayIdx];
        const shiftDate = dates[shift.dayIdx];
        const dateStr = shiftDate ? shiftDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        const timeStr = `${formatTime(shift.start)} - ${formatTime(shift.end)}`;
        const role = roleMap[shift.role]?.name || 'Staff';
        
        return `
            <label class="shift-option" data-shift-idx="${idx}">
                <input type="radio" name="counterOfferShift" value="${idx}" onchange="selectCounterOfferShift(${idx})">
                <div class="shift-option-details">
                    <div class="shift-option-date">${dayName}, ${dateStr}</div>
                    <div class="shift-option-time">${timeStr} • ${role}</div>
                </div>
            </label>
        `;
    }).join('');
    
    // Store shifts for later reference
    employeeState.myShiftsForCounterOffer = myShifts;
}

function selectCounterOfferShift(idx) {
    const shifts = employeeState.myShiftsForCounterOffer;
    if (!shifts || !shifts[idx]) return;
    
    employeeState.selectedSwapShift = shifts[idx];
    
    // Update visual selection
    document.querySelectorAll('.shift-option').forEach((opt, i) => {
        opt.classList.toggle('selected', i === idx);
    });
    
    // Update accept button - this is now a counter offer
    const acceptBtn = document.getElementById('acceptSwapBtn');
    if (acceptBtn) {
        acceptBtn.disabled = false;
        acceptBtn.textContent = 'Send Counter Offer';
    }
}

function getMyUpcomingShifts() {
    const schedule = employeeState.schedule;
    const myId = employeeState.employee.id;
    const shifts = [];
    
    if (!schedule || !schedule.slot_assignments) return shifts;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dates = getWeekDates(employeeState.weekOffset);
    
    // Get continuous shifts for each day
    employeeState.daysOpen.forEach(dayIdx => {
        const date = dates[dayIdx];
        if (date < today) return; // Only future shifts
        
        const dayShifts = getMyContinuousShiftsForDay(schedule, dayIdx);
        dayShifts.forEach(shift => {
            shifts.push({
                dayIdx,
                start: shift.start,
                end: shift.end,
                role: shift.role
            });
        });
    });
    
    return shifts;
}

async function loadSwapRequests() {
    try {
        const empId = employeeState.employee.db_id || employeeState.employee.id;
        const response = await fetch(`/api/employee/${employeeState.businessSlug}/${empId}/swap-requests`);
        const data = await response.json();
        
        if (data.success) {
            employeeState.swapRequests = {
                incoming: data.incoming || [],
                outgoing: data.outgoing || []
            };
            renderSwapRequests();
            updateNotificationBell();
        }
    } catch (error) {
        console.error('Failed to load swap requests:', error);
    }
}

// ==================== NOTIFICATION BELL ====================
function updateNotificationBell() {
    // Update the unified notification badge
    updateUnifiedNotificationBadge();
    
    // Always update dropdown content (shows empty message if no requests)
    updateNotificationDropdown();
}

function updateNotificationDropdown() {
    const list = document.getElementById('notificationList');
    if (!list) return;
    
    const pending = employeeState.swapRequests.incoming.filter(r => r.my_response === 'pending');
    
    // Update header text based on pending count
    const header = document.querySelector('.notification-header span');
    if (header) {
        header.textContent = pending.length > 0 
            ? `Pending Requests (${pending.length})`
            : 'No Pending Requests';
    }
    
    if (pending.length === 0) {
        list.innerHTML = '';
        return;
    }
    
    list.innerHTML = pending.map(req => {
        // Get requester name - look up from allEmployees if needed
        let requesterName = req.requester_name;
        if (!requesterName || requesterName === 'Unknown') {
            const requester = employeeState.allEmployees.find(e => 
                e.db_id == req.requester_employee_id || e.id == req.requester_employee_id
            );
            requesterName = requester ? requester.name : 'A coworker';
        }
        
        // Use correct field names from API (original_day, original_start_hour, original_end_hour)
        const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        const dayName = dayNames[req.original_day] || `Day ${req.original_day}`;
        const timeStr = `${formatTime(req.original_start_hour)} - ${formatTime(req.original_end_hour)}`;
        
        // Check if this is a counter offer
        const isCounterOffer = req.is_counter_offer;
        const title = isCounterOffer 
            ? `⇄ Counter offer from ${requesterName}`
            : `${requesterName} wants to swap`;
        const itemClass = isCounterOffer ? 'notification-item counter-offer' : 'notification-item';
        
        return `
            <div class="${itemClass}" onclick="showSwapResponseModal('${req.id}'); hideNotificationDropdown();">
                <div class="notification-item-title">${title}</div>
                <div class="notification-item-subtitle">${dayName}, ${timeStr}</div>
            </div>
        `;
    }).join('');
}

function toggleNotificationDropdown() {
    const dropdown = document.getElementById('unifiedNotificationDropdown');
    if (dropdown) {
        dropdown.classList.toggle('visible');
    }
}

function hideNotificationDropdown() {
    const dropdown = document.getElementById('unifiedNotificationDropdown');
    if (dropdown) {
        dropdown.classList.remove('visible');
    }
}

// Unified Notification Bell
function initUnifiedNotificationBell() {
    const bell = document.getElementById('unifiedNotificationBell');
    const dropdown = document.getElementById('unifiedNotificationDropdown');
    const mobileClose = document.getElementById('closeNotificationsMobile');
    
    if (!bell || !dropdown) return;
    
    // Toggle dropdown on bell click
    bell.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.toggle('visible');
    });
    
    // Mobile close button
    if (mobileClose) {
        mobileClose.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.classList.remove('visible');
        });
    }
    
    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!dropdown.contains(e.target) && !bell.contains(e.target)) {
            dropdown.classList.remove('visible');
        }
    });
}

function updateUnifiedNotificationBadge() {
    const badge = document.getElementById('unifiedNotificationBadge');
    
    // Get PTO count
    const ptoCount = (employeeState.ptoNotifications || []).filter(req => !seenPTOUpdates.has(req.id)).length;
    
    // Get incoming swap count
    const swapCount = employeeState.swapRequests.incoming.filter(r => r.my_response === 'pending').length;
    
    // Get outgoing swap update count (accepted/declined/all-recipients-declined that haven't been seen)
    const swapUpdateCount = (employeeState.swapRequests.outgoing || []).filter(r => {
        if (seenSwapUpdates.has(r.id) || seenSwapUpdates.has(String(r.id))) return false;
        if (r.status === 'accepted' || r.status === 'declined') return true;
        // Also count pending requests where all recipients declined
        if (r.recipients && r.recipients.length > 0 && r.recipients.every(rec => rec.response === 'declined')) return true;
        return false;
    }).length;
    
    const totalCount = ptoCount + swapCount + swapUpdateCount;
    
    // Update main badge
    if (badge) {
        if (totalCount > 0) {
            badge.textContent = totalCount;
            document.getElementById('unifiedNotificationBell')?.classList.add('has-notifications');
        } else {
            badge.textContent = '';
            document.getElementById('unifiedNotificationBell')?.classList.remove('has-notifications');
        }
    }
    
    // Also render the unified list
    renderUnifiedNotificationList();
}

function renderUnifiedNotificationList() {
    const list = document.getElementById('unifiedNotificationList');
    if (!list) return;
    
    list.innerHTML = '';
    
    const notifications = [];
    
    // Add PTO notifications (only unseen ones)
    (employeeState.ptoNotifications || []).forEach(pto => {
        // Skip if already seen
        if (seenPTOUpdates.has(pto.id) || seenPTOUpdates.has(String(pto.id))) {
            return;
        }
        
        notifications.push({
            type: 'pto',
            id: pto.id,
            title: `Time Off ${pto.status === 'approved' ? 'Approved' : 'Denied'}`,
            subtitle: `${capitalizeFirstEmployee(pto.pto_type)} • ${formatPTODateRange(pto.start_date, pto.end_date)}`,
            status: pto.status,
            date: new Date(pto.updated_at || pto.created_at),
            pto: pto // Store full PTO data for navigation
        });
    });
    
    // Add swap notifications (pending incoming requests)
    const dayNamesShort = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const monthsShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    employeeState.swapRequests.incoming.filter(r => r.my_response === 'pending').forEach(swap => {
        const requesterName = swap.requester_name || 'Someone';
        const dayName = dayNamesShort[swap.original_day] || '?';
        const timeRange = `${formatTime(swap.original_start_hour)}-${formatTime(swap.original_end_hour)}`;
        const notePreview = swap.note ? swap.note.substring(0, 50) + (swap.note.length > 50 ? '...' : '') : '';
        const actionType = swap.my_eligibility_type === 'pickup' ? 'give away' : 'swap';
        
        // Compute the actual date (e.g. "Mon Feb 16")
        let shiftDateStr = dayName;
        if (swap.week_start_date) {
            const ws = new Date(swap.week_start_date + 'T00:00:00');
            const shiftDate = new Date(ws);
            shiftDate.setDate(ws.getDate() + swap.original_day);
            shiftDateStr = `${dayName} ${monthsShort[shiftDate.getMonth()]} ${shiftDate.getDate()}`;
        }
        
        notifications.push({
            type: 'swap',
            id: swap.id,
            title: `${requesterName}`,
            subtitle: `Wants to ${actionType}: ${shiftDateStr} ${timeRange}`,
            notePreview: notePreview,
            date: new Date(swap.created_at),
            swap: swap,
            seen: false
        });
    });
    
    // Add outgoing swap updates (accepted/declined) as notifications for the requester
    (employeeState.swapRequests.outgoing || []).forEach(swap => {
        // Check if it's resolved (accepted/declined) OR if all recipients declined but status wasn't updated
        const isAccepted = swap.status === 'accepted';
        const isDeclined = swap.status === 'declined';
        const allRecipientsDeclined = swap.recipients && swap.recipients.length > 0 && 
            swap.recipients.every(r => r.response === 'declined');
        
        if (!isAccepted && !isDeclined && !allRecipientsDeclined) return;
        // Skip if already seen
        if (seenSwapUpdates.has(swap.id) || seenSwapUpdates.has(String(swap.id))) return;
        
        const dayName = dayNamesShort[swap.original_day] || '?';
        const timeRange = `${formatTime(swap.original_start_hour)}-${formatTime(swap.original_end_hour)}`;
        
        let shiftDateStr = dayName;
        if (swap.week_start_date) {
            const ws = new Date(swap.week_start_date + 'T00:00:00');
            const shiftDate = new Date(ws);
            shiftDate.setDate(ws.getDate() + swap.original_day);
            shiftDateStr = `${dayName} ${monthsShort[shiftDate.getMonth()]} ${shiftDate.getDate()}`;
        }
        
        // Find who responded
        let responderName = 'Someone';
        if (isAccepted && swap.recipients) {
            const accepter = swap.recipients.find(r => r.response === 'accepted');
            if (accepter) responderName = accepter.employee_name || 'Someone';
        } else if ((isDeclined || allRecipientsDeclined) && swap.recipients) {
            if (swap.recipients.length === 1) {
                responderName = swap.recipients[0].employee_name || 'Someone';
            } else {
                responderName = 'All recipients';
            }
        }
        
        const effectivelyAccepted = isAccepted;
        
        notifications.push({
            type: 'swap_update',
            id: swap.id,
            title: effectivelyAccepted ? 'Swap Accepted!' : 'Swap Declined',
            subtitle: `${shiftDateStr} ${timeRange}`,
            detail: effectivelyAccepted 
                ? `${responderName} accepted your swap request`
                : `${responderName} declined your swap request`,
            isAccepted: effectivelyAccepted,
            date: new Date(swap.resolved_at || swap.created_at),
            swap: swap,
        });
    });
    
    // Sort by date (newest first)
    notifications.sort((a, b) => b.date - a.date);
    
    if (notifications.length === 0) {
        list.innerHTML = '<div class="empty-notifications">No notifications</div>';
        return;
    }
    
    notifications.forEach(notif => {
        const item = document.createElement('div');
        item.className = 'unified-notification-item';
        
        if (notif.type === 'pto') {
            const statusIcon = notif.status === 'approved' ? '✓' : '✗';
            const statusColor = notif.status === 'approved' ? 'color: #10b981' : 'color: #ef4444';
            item.innerHTML = `
                <div class="notif-icon pto-icon">📅</div>
                <div class="notif-content">
                    <div class="notif-title">${notif.title} <span style="${statusColor}">${statusIcon}</span></div>
                    <div class="notif-subtitle">${notif.subtitle}</div>
                </div>
            `;
            item.style.cursor = 'pointer';
            item.dataset.ptoId = notif.id;
            
            // Click to view on schedule and mark as seen
            item.addEventListener('click', () => {
                // Mark as seen
                markPTOAsSeen(notif.id);
                
                // Close dropdown
                document.getElementById('unifiedNotificationDropdown')?.classList.remove('visible');
                
                // Scroll to and highlight the PTO on the schedule
                scrollToAndHighlightPTO(notif.pto);
                
                // Update the notification list
                updateUnifiedNotificationBadge();
            });
        } else if (notif.type === 'swap') {
            item.innerHTML = `
                <div class="notif-icon swap-icon">🔄</div>
                <div class="notif-content">
                    <div class="notif-title">${notif.title}</div>
                    <div class="notif-subtitle">${notif.subtitle}</div>
                    ${notif.notePreview ? `<div class="notif-note">"${notif.notePreview}"</div>` : ''}
                    <div class="notif-actions">
                        <button class="notif-btn notif-btn-decline">Decline</button>
                        <button class="notif-btn notif-btn-accept">Accept</button>
                    </div>
                </div>
                <div class="notif-chevron">›</div>
            `;
            item.style.cursor = 'pointer';
            
            item.querySelector('.notif-btn-accept').addEventListener('click', (e) => {
                e.stopPropagation();
                document.getElementById('unifiedNotificationDropdown')?.classList.remove('visible');
                handleSwapFromNotification(notif.swap.id, 'accept');
            });
            item.querySelector('.notif-btn-decline').addEventListener('click', (e) => {
                e.stopPropagation();
                document.getElementById('unifiedNotificationDropdown')?.classList.remove('visible');
                handleSwapFromNotification(notif.swap.id, 'decline');
            });
            // Clicking anywhere else on the notification navigates to schedule
            item.addEventListener('click', () => {
                document.getElementById('unifiedNotificationDropdown')?.classList.remove('visible');
                navigateToSwapOnSchedule(notif.swap);
            });
        } else if (notif.type === 'swap_update') {
            const icon = notif.isAccepted ? '✅' : '❌';
            const statusClass = notif.isAccepted ? 'accepted' : 'declined';
            item.classList.add(`swap-update-${statusClass}`);
            item.innerHTML = `
                <div class="notif-icon swap-update-icon ${statusClass}">${icon}</div>
                <div class="notif-content">
                    <div class="notif-title">${notif.title}</div>
                    <div class="notif-subtitle">${notif.subtitle}</div>
                    <div class="notif-detail">${notif.detail}</div>
                </div>
            `;
            item.style.cursor = 'pointer';
            
            // Click to dismiss
            item.addEventListener('click', () => {
                markSwapUpdateSeen(notif.id);
                updateUnifiedNotificationBadge();
                renderUnifiedNotificationList();
            });
        }
        
        list.appendChild(item);
    });
}

function navigateToSwapOnSchedule(swap) {
    // Calculate the week offset for this swap
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayOfWeek = today.getDay();
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const currentMonday = new Date(today);
    currentMonday.setDate(today.getDate() - daysToMonday);
    
    let targetWeekOffset = 0;
    if (swap.week_start_date) {
        const swapMonday = new Date(swap.week_start_date + 'T00:00:00');
        targetWeekOffset = Math.round((swapMonday - currentMonday) / (7 * 24 * 60 * 60 * 1000));
    }
    
    const needsWeekChange = targetWeekOffset !== employeeState.weekOffset;
    if (needsWeekChange) {
        employeeState.weekOffset = targetWeekOffset;
        updateURLWeek(employeeState.weekOffset);
        updateWeekDisplay();
    }
    
    const afterLoad = () => {
        highlightScheduleDay(swap.original_day);
        showStickySwapAction(swap);
        
        setTimeout(() => {
            const scheduleSection = document.getElementById('scheduleSection') || document.querySelector('.schedule-container');
            if (scheduleSection) {
                scheduleSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }, 100);
    };
    
    if (needsWeekChange) {
        loadScheduleData().then(afterLoad);
    } else {
        afterLoad();
    }
}

function showSwapNotificationDetail(swap) {
    const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const requesterName = swap.requester_name || 'Someone';
    const dayName = dayNames[swap.original_day] || 'Unknown';
    const timeRange = `${formatTime(swap.original_start_hour)} – ${formatTime(swap.original_end_hour)}`;
    const actionType = swap.my_eligibility_type === 'pickup' ? 'give away' : 'swap';
    const isCounterOffer = swap.is_counter_offer;
    
    // Compute the week date for the "View Schedule" link
    let weekDateStr = '';
    if (swap.week_start_date) {
        const ws = new Date(swap.week_start_date + 'T00:00:00');
        const shiftDate = new Date(ws);
        shiftDate.setDate(ws.getDate() + swap.original_day);
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        weekDateStr = `${months[shiftDate.getMonth()]} ${shiftDate.getDate()}`;
    }
    
    // Calculate the week offset needed to view this shift
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayOfWeek = today.getDay();
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const currentMonday = new Date(today);
    currentMonday.setDate(today.getDate() - daysToMonday);
    
    let targetWeekOffset = 0;
    if (swap.week_start_date) {
        const swapMonday = new Date(swap.week_start_date + 'T00:00:00');
        targetWeekOffset = Math.round((swapMonday - currentMonday) / (7 * 24 * 60 * 60 * 1000));
    }
    
    // Remove existing detail popup if any
    document.getElementById('swapNotifDetailPopup')?.remove();
    
    const popup = document.createElement('div');
    popup.id = 'swapNotifDetailPopup';
    popup.className = 'modal-overlay';
    popup.style.display = 'flex';
    popup.innerHTML = `
        <div class="modal-content swap-notif-detail-modal">
            <div class="modal-header">
                <h2>${isCounterOffer ? 'Counter Offer' : 'Shift Swap Request'}</h2>
                <button class="modal-close" id="closeSwapNotifDetail">&times;</button>
            </div>
            <div class="modal-body">
                <div class="swap-detail-card">
                    <div class="swap-detail-from">
                        <span class="swap-detail-label">From</span>
                        <span class="swap-detail-value">${requesterName}</span>
                    </div>
                    <div class="swap-detail-shift">
                        <span class="swap-detail-label">${isCounterOffer ? 'Offering their shift' : `Wants to ${actionType}`}</span>
                        <div class="swap-detail-day">${dayName}${weekDateStr ? ` · ${weekDateStr}` : ''}</div>
                        <div class="swap-detail-time">${timeRange}</div>
                        ${swap.original_role_id ? `<div class="swap-detail-role">${swap.original_role_id}</div>` : ''}
                    </div>
                    ${swap.note ? `
                        <div class="swap-detail-note">
                            <span class="swap-detail-label">Note</span>
                            <p>${swap.note}</p>
                        </div>
                    ` : ''}
                    ${swap.my_eligibility_type === 'swap_only' ? `
                        <div class="swap-detail-info">
                            <span class="swap-info-badge">⚠ You'll need to offer one of your shifts in exchange</span>
                        </div>
                    ` : `
                        <div class="swap-detail-info">
                            <span class="swap-info-badge pickup">✓ You can pick this up without swapping</span>
                        </div>
                    `}
                </div>
            </div>
            <div class="modal-footer swap-detail-footer">
                <button class="btn btn-outline" id="swapDetailViewSchedule">View My Schedule</button>
                <div class="swap-detail-actions">
                    <button class="btn btn-secondary" id="swapDetailDecline">Decline</button>
                    <button class="btn btn-success" id="swapDetailAccept">Accept</button>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(popup);
    
    // Close button
    popup.querySelector('#closeSwapNotifDetail').addEventListener('click', () => popup.remove());
    popup.addEventListener('click', (e) => {
        if (e.target === popup) popup.remove();
    });
    
    // View Schedule button - navigate, highlight the day, show sticky mini-popup
    popup.querySelector('#swapDetailViewSchedule').addEventListener('click', () => {
        popup.remove();
        
        const needsWeekChange = targetWeekOffset !== employeeState.weekOffset;
        if (needsWeekChange) {
            employeeState.weekOffset = targetWeekOffset;
            updateURLWeek(employeeState.weekOffset);
            updateWeekDisplay();
        }
        
        // Load schedule then highlight + show sticky popup
        const afterLoad = () => {
            // Highlight the day column on the schedule
            highlightScheduleDay(swap.original_day);
            
            // Show sticky mini-popup for accept/decline
            showStickySwapAction(swap);
            
            // Scroll to the schedule section
            setTimeout(() => {
                const scheduleSection = document.getElementById('scheduleSection') || document.querySelector('.schedule-container');
                if (scheduleSection) {
                    scheduleSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }, 100);
        };
        
        if (needsWeekChange) {
            loadScheduleData().then(afterLoad);
        } else {
            afterLoad();
        }
    });
    
    // Accept button
    popup.querySelector('#swapDetailAccept').addEventListener('click', () => {
        popup.remove();
        handleSwapFromNotification(swap.id, 'accept');
    });
    
    // Decline button
    popup.querySelector('#swapDetailDecline').addEventListener('click', () => {
        popup.remove();
        handleSwapFromNotification(swap.id, 'decline');
    });
}

function highlightScheduleDay(dayIdx) {
    // Remove any existing highlights
    document.querySelectorAll('.schedule-day-highlight').forEach(el => el.classList.remove('schedule-day-highlight'));
    
    // Highlight in table view - find the column for this day
    const table = document.querySelector('.simple-schedule-table');
    if (table) {
        // Header cells (skip first which is the name column)
        const headerCells = table.querySelectorAll('thead th');
        const daysOpen = employeeState.daysOpen || [0, 1, 2, 3, 4, 5, 6];
        const colIndex = daysOpen.indexOf(dayIdx);
        if (colIndex >= 0 && headerCells[colIndex + 1]) {
            headerCells[colIndex + 1].classList.add('schedule-day-highlight');
        }
        // Body cells in that column
        const bodyRows = table.querySelectorAll('tbody tr');
        bodyRows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells[colIndex + 1]) {
                cells[colIndex + 1].classList.add('schedule-day-highlight');
            }
        });
    }
    
    // Highlight in timeline view
    const timelineDays = document.querySelectorAll('.timeline-day');
    timelineDays.forEach(day => {
        if (parseInt(day.dataset?.dayIdx) === dayIdx) {
            day.classList.add('schedule-day-highlight');
        }
    });
    
    // Highlight in grid view
    const gridSlots = document.querySelectorAll(`.slot[data-day="${dayIdx}"]`);
    gridSlots.forEach(slot => slot.classList.add('schedule-day-highlight'));
    
    // Highlight in upcoming shifts
    const upcomingItems = document.querySelectorAll('.upcoming-shift-item');
    upcomingItems.forEach(item => {
        if (parseInt(item.dataset?.day) === dayIdx) {
            item.classList.add('schedule-day-highlight');
        }
    });
    
    // Auto-clear after 8 seconds
    setTimeout(() => {
        document.querySelectorAll('.schedule-day-highlight').forEach(el => el.classList.remove('schedule-day-highlight'));
    }, 8000);
}

function showStickySwapAction(swap) {
    // Remove any existing sticky popup
    document.getElementById('stickySwapAction')?.remove();
    
    const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const monthsShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const requesterName = swap.requester_name || 'Someone';
    const dayName = dayNames[swap.original_day] || '?';
    const timeRange = `${formatTime(swap.original_start_hour)} – ${formatTime(swap.original_end_hour)}`;
    const actionType = swap.my_eligibility_type === 'pickup' ? 'give away' : 'swap';
    const isCounterOffer = swap.is_counter_offer;
    
    // Build the date string
    let dateStr = '';
    if (swap.week_start_date) {
        const ws = new Date(swap.week_start_date + 'T00:00:00');
        const shiftDate = new Date(ws);
        shiftDate.setDate(ws.getDate() + swap.original_day);
        dateStr = `${monthsShort[shiftDate.getMonth()]} ${shiftDate.getDate()}`;
    }
    
    // Eligibility info
    let eligibilityHtml = '';
    if (swap.my_eligibility_type === 'swap_only') {
        eligibilityHtml = '<div class="sticky-swap-elig swap-only">⚠ Must offer a shift in exchange</div>';
    } else {
        eligibilityHtml = '<div class="sticky-swap-elig pickup">✓ Can pick up without swapping</div>';
    }
    
    // Note
    const noteHtml = swap.note 
        ? `<div class="sticky-swap-note">"${swap.note}"</div>` 
        : '';
    
    // Short eligibility label
    const eligLabel = swap.my_eligibility_type === 'swap_only' 
        ? '<span class="sticky-elig-tag swap-only">⚠ Must swap</span>'
        : '<span class="sticky-elig-tag pickup">✓ Pickup OK</span>';
    
    // Truncate note for inline display
    let noteSnippet = '';
    if (swap.note) {
        noteSnippet = swap.note.length > 60 ? swap.note.substring(0, 60) + '…' : swap.note;
    }
    
    const sticky = document.createElement('div');
    sticky.id = 'stickySwapAction';
    sticky.innerHTML = `
        <div class="sticky-swap-row">
            <div class="sticky-swap-info">
                <span class="sticky-swap-who"><strong>${requesterName}</strong> · ${actionType}</span>
                <span class="sticky-swap-sep">│</span>
                <span class="sticky-swap-when">${dayName}${dateStr ? ' ' + dateStr : ''} · ${timeRange}</span>
                ${eligLabel}
                ${noteSnippet ? `<span class="sticky-swap-note">"${noteSnippet}"</span>` : ''}
            </div>
            <div class="sticky-swap-btns">
                <button class="sticky-swap-btn decline" id="stickyDecline">Decline</button>
                <button class="sticky-swap-btn accept" id="stickyAccept">Accept</button>
            </div>
            <button class="sticky-swap-dismiss" id="stickyDismiss">✕</button>
        </div>
    `;
    
    document.body.appendChild(sticky);
    
    // Slide in
    requestAnimationFrame(() => {
        sticky.classList.add('visible');
    });
    
    const cleanup = () => {
        sticky.classList.remove('visible');
        setTimeout(() => sticky.remove(), 300);
        document.querySelectorAll('.schedule-day-highlight').forEach(el => el.classList.remove('schedule-day-highlight'));
    };
    
    sticky.querySelector('#stickyAccept').addEventListener('click', () => {
        cleanup();
        handleSwapFromNotification(swap.id, 'accept');
    });
    
    sticky.querySelector('#stickyDecline').addEventListener('click', () => {
        cleanup();
        handleSwapFromNotification(swap.id, 'decline');
    });
    
    sticky.querySelector('#stickyDismiss').addEventListener('click', cleanup);
}

function formatPTODateRange(start, end) {
    const startDate = new Date(start + 'T00:00:00');
    const endDate = new Date(end + 'T00:00:00');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    if (start === end) {
        return `${months[startDate.getMonth()]} ${startDate.getDate()}`;
    }
    return `${months[startDate.getMonth()]} ${startDate.getDate()} - ${months[endDate.getMonth()]} ${endDate.getDate()}`;
}

function markPTOAsSeen(ptoId) {
    // Add both string and number versions to be safe
    seenPTOUpdates.add(ptoId);
    seenPTOUpdates.add(String(ptoId));
    if (typeof ptoId === 'string') {
        seenPTOUpdates.add(parseInt(ptoId, 10));
    }
    localStorage.setItem('seenPTOUpdates', JSON.stringify([...seenPTOUpdates]));
}

// PTO Block Popover
function showPTOPopover(e, pto, isMine) {
    e.stopPropagation();
    
    // Hide any existing popover
    hidePTOPopover();
    
    // Create popover
    const popover = document.createElement('div');
    popover.id = 'ptoPopover';
    popover.className = 'pto-popover';
    
    const emoji = getPTOTypeEmojiEmployee(pto.pto_type);
    const typeLabel = capitalizeFirstEmployee(pto.pto_type);
    const name = isMine ? 'You' : (pto.employee_name || 'Unknown');
    const dateRange = formatPTODateRange(pto.start_date, pto.end_date);
    
    popover.innerHTML = `
        <div class="pto-popover-header">
            <span class="pto-popover-emoji">${emoji}</span>
            <div class="pto-popover-title">
                <strong>${typeLabel}</strong>
                <span class="pto-popover-name">${name}</span>
            </div>
        </div>
        <div class="pto-popover-dates">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="16" y1="2" x2="16" y2="6"></line>
                <line x1="8" y1="2" x2="8" y2="6"></line>
                <line x1="3" y1="10" x2="21" y2="10"></line>
            </svg>
            ${dateRange}
        </div>
        ${isMine && pto.id ? `
            <div class="pto-popover-actions">
                <button class="btn btn-sm btn-danger-outline" onclick="cancelPTOFromPopover('${pto.id}', '${pto.pto_type}', '${dateRange}')">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                    Cancel Request
                </button>
            </div>
        ` : ''}
    `;
    
    document.body.appendChild(popover);
    
    // Position the popover
    const rect = e.target.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    
    let top = rect.bottom + window.scrollY + 8;
    let left = rect.left + window.scrollX + (rect.width / 2) - (popoverRect.width / 2);
    
    // Keep within viewport
    if (left < 10) left = 10;
    if (left + popoverRect.width > window.innerWidth - 10) {
        left = window.innerWidth - popoverRect.width - 10;
    }
    if (top + popoverRect.height > window.innerHeight + window.scrollY - 10) {
        top = rect.top + window.scrollY - popoverRect.height - 8;
    }
    
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
    
    // Show with animation
    requestAnimationFrame(() => {
        popover.classList.add('visible');
    });
    
    // Close on click outside
    setTimeout(() => {
        document.addEventListener('click', hidePTOPopoverOnClickOutside);
    }, 0);
}

function hidePTOPopover() {
    const popover = document.getElementById('ptoPopover');
    if (popover) {
        popover.remove();
    }
    document.removeEventListener('click', hidePTOPopoverOnClickOutside);
}

function hidePTOPopoverOnClickOutside(e) {
    const popover = document.getElementById('ptoPopover');
    if (popover && !popover.contains(e.target)) {
        hidePTOPopover();
    }
}

function cancelPTOFromPopover(ptoId, ptoType, dateRange) {
    hidePTOPopover();
    showCancelPTOConfirm(ptoId, ptoType, dateRange);
}

function scrollToAndHighlightPTO(pto) {
    if (!pto) return;
    
    // Navigate to the week containing this PTO
    const ptoStart = new Date(pto.start_date + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Calculate week offset for the PTO start date
    const currentMonday = new Date(today);
    currentMonday.setDate(today.getDate() - today.getDay() + 1);
    
    const ptoMonday = new Date(ptoStart);
    ptoMonday.setDate(ptoStart.getDate() - ptoStart.getDay() + 1);
    
    const weekDiff = Math.round((ptoMonday - currentMonday) / (7 * 24 * 60 * 60 * 1000));
    
    // If we need to change weeks, navigate there
    if (weekDiff !== employeeState.weekOffset) {
        employeeState.weekOffset = weekDiff;
        updateURLWeek(employeeState.weekOffset);
        updateWeekDisplay();
        loadScheduleData().then(() => {
            highlightPTOElement(pto);
        });
    } else {
        highlightPTOElement(pto);
    }
}

function highlightPTOElement(pto) {
    // Wait a moment for render
    setTimeout(() => {
        // Look for the PTO item in the Upcoming Shifts section
        const upcomingItems = document.querySelectorAll('.upcoming-pto-item');
        let targetElement = null;
        
        // Find the matching PTO item by checking the content
        upcomingItems.forEach(item => {
            const text = item.textContent.toLowerCase();
            if (text.includes(pto.pto_type.toLowerCase())) {
                targetElement = item;
            }
        });
        
        // Fallback: just use the first upcoming PTO item
        if (!targetElement && upcomingItems.length > 0) {
            targetElement = upcomingItems[0];
        }
        
        if (targetElement) {
            // Scroll into view
            targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
            
            // Add highlight animation
            targetElement.classList.add('highlight-pulse');
            setTimeout(() => {
                targetElement.classList.remove('highlight-pulse');
            }, 2500);
        } else {
            // Scroll to upcoming shifts section at least
            const upcomingSection = document.querySelector('.upcoming-shifts-card');
            if (upcomingSection) {
                upcomingSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }
        
        showToast(`Viewing time off: ${capitalizeFirstEmployee(pto.pto_type)}`, 'info');
    }, 300);
}

async function handleSwapFromNotification(swapId, action) {
    const swap = employeeState.swapRequests.incoming.find(r => r.id === swapId);
    if (!swap) return;
    
    // For swap-only requests, need to open the modal to select a shift
    if (action === 'accept' && swap.my_eligibility_type === 'swap_only') {
        employeeState.currentSwapRequest = swap;
        document.getElementById('unifiedNotificationDropdown')?.classList.remove('visible');
        showSwapResponseModal(swap.id);
        return;
    }
    
    // Close dropdown immediately
    document.getElementById('unifiedNotificationDropdown')?.classList.remove('visible');
    
    // Direct accept/decline via API
    try {
        const empId = employeeState.employee.db_id || employeeState.employee.id;
        const response = await fetch(
            `/api/employee/${employeeState.businessSlug}/${empId}/swap-request/${swapId}/respond`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ response: action === 'accept' ? 'accept' : 'decline' })
            }
        );
        
        const data = await response.json();
        
        if (data.success) {
            showToast(action === 'accept' ? 'Swap request accepted!' : 'Swap request declined', action === 'accept' ? 'success' : 'info');
            // Reload swap requests and schedule
            await loadSwapRequests();
            updateUnifiedNotificationBadge();
            
            if (action === 'accept') {
                // Reload schedule to show the updated shifts
                await loadScheduleData();
                // Navigate to and highlight the accepted shift on the schedule
                scrollToAndHighlightSwappedShift(swap);
            }
        } else {
            showToast(data.message || 'Failed to respond to swap request', 'error');
        }
    } catch (error) {
        console.error('Error responding to swap:', error);
        showToast('Failed to respond to swap request', 'error');
    }
}

function scrollToAndHighlightSwappedShift(swap) {
    if (!swap) return;
    
    // Just highlight the day on the schedule so the user can see it was added
    setTimeout(() => {
        highlightScheduleDay(swap.original_day);
    }, 400);
}

function initNotificationBell() {
    // Initialize unified notification bell
    initUnifiedNotificationBell();
}

function renderSwapRequests() {
    renderIncomingSwapRequests();
    renderOutgoingSwapRequests();
}

function renderIncomingSwapRequests() {
    const card = document.getElementById('incomingSwapsCard');
    const list = document.getElementById('incomingSwapsList');
    const countBadge = document.getElementById('swapRequestCount');
    
    if (!card || !list) return;
    
    const incoming = employeeState.swapRequests.incoming.filter(r => r.my_response === 'pending');
    
    if (incoming.length === 0) {
        card.style.display = 'none';
        return;
    }
    
    card.style.display = 'block';
    if (countBadge) countBadge.textContent = incoming.length;
    
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    
    list.innerHTML = incoming.map(req => {
        const shiftTime = `${dayNames[req.original_day]} ${formatTime(req.original_start_hour)}-${formatTime(req.original_end_hour)}`;
        const isCounterOffer = req.is_counter_offer;
        
        // Different badge for counter offers vs regular requests
        let statusBadge;
        if (isCounterOffer) {
            statusBadge = '<span class="swap-eligibility-badge counter-offer">⇄ Counter Offer</span>';
        } else if (req.my_eligibility_type === 'pickup') {
            statusBadge = '<span class="swap-eligibility-badge pickup">Can Pick Up</span>';
        } else {
            statusBadge = '<span class="swap-eligibility-badge swap-only">Swap Required</span>';
        }
        
        const itemClass = isCounterOffer ? 'swap-request-item incoming counter-offer' : 'swap-request-item incoming';
        const actionText = isCounterOffer ? 'offers' : 'wants to swap';
        
        return `
            <div class="${itemClass}" data-request-id="${req.id}">
                <div class="swap-request-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="17 1 21 5 17 9"></polyline>
                        <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
                        <polyline points="7 23 3 19 7 15"></polyline>
                        <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
                    </svg>
                </div>
                <div class="swap-request-info">
                    <div class="swap-request-header">
                        <span class="swap-request-from">${req.requester_name}</span>
                        ${statusBadge}
                    </div>
                    <div class="swap-request-shift">
                        ${isCounterOffer ? 'Offering' : 'Wants to swap'}: <strong>${shiftTime}</strong>
                    </div>
                    ${req.note ? `<div class="swap-request-note">"${req.note}"</div>` : ''}
                    <div class="swap-request-actions">
                        <button class="btn btn-success btn-sm" onclick="showSwapResponseModal('${req.id}')">
                            ${isCounterOffer ? 'View Offer' : 'Respond'}
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function renderOutgoingSwapRequests() {
    const card = document.getElementById('outgoingSwapsCard');
    const list = document.getElementById('outgoingSwapsList');
    
    if (!card || !list) return;
    
    const outgoing = employeeState.swapRequests.outgoing;
    
    if (outgoing.length === 0) {
        card.style.display = 'none';
        return;
    }
    
    card.style.display = 'block';
    
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    
    list.innerHTML = outgoing.slice(0, 5).map(req => {
        const shiftTime = `${dayNames[req.original_day]} ${formatTime(req.original_start_hour)}-${formatTime(req.original_end_hour)}`;
        
        const statusBadges = {
            'pending': '<span class="swap-status-badge pending">Pending</span>',
            'accepted': '<span class="swap-status-badge accepted">Accepted</span>',
            'declined': '<span class="swap-status-badge declined">Declined</span>',
            'cancelled': '<span class="swap-status-badge cancelled">Cancelled</span>',
            'expired': '<span class="swap-status-badge cancelled">Expired</span>'
        };
        
        const recipientCount = req.recipients?.length || 0;
        const respondedCount = req.recipients?.filter(r => r.response !== 'pending').length || 0;
        
        return `
            <div class="swap-request-item outgoing ${req.status}" data-request-id="${req.id}">
                <div class="swap-request-info">
                    <div class="swap-request-header">
                        <span class="swap-request-shift"><strong>${shiftTime}</strong></span>
                        ${statusBadges[req.status] || ''}
                    </div>
                    <div class="swap-request-time">
                        Sent to ${recipientCount} staff • ${respondedCount} responded
                    </div>
                    ${req.status === 'pending' ? `
                        <div class="swap-request-actions" style="margin-top: 0.5rem;">
                            <button class="btn btn-secondary btn-sm" onclick="cancelMySwapRequest('${req.id}')">
                                Cancel Request
                            </button>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');
}

function showSwapModal(shift) {
    employeeState.currentSwapShift = shift;
    employeeState.selectedRecipients = [];
    
    const modal = document.getElementById('swapModal');
    const shiftDetails = document.getElementById('swapShiftDetails');
    const eligibleList = document.getElementById('eligibleStaffList');
    const submitBtn = document.getElementById('submitSwapBtn');
    const noteField = document.getElementById('swapNote');
    
    if (!modal) return;
    
    // Clear previous state
    if (noteField) noteField.value = '';
    if (submitBtn) submitBtn.disabled = true;
    
    // Show shift details
    const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const role = roleMap[shift.role] || {};
    
    if (shiftDetails) {
        shiftDetails.innerHTML = `
            <div class="shift-day">${dayNames[shift.dayIdx]}</div>
            <div class="shift-time">${formatTime(shift.start)} - ${formatTime(shift.end)}</div>
            ${role.name ? `<div class="shift-role"><span style="background: ${role.color || '#666'}; width: 10px; height: 10px; border-radius: 50%; display: inline-block;"></span> ${role.name}</div>` : ''}
        `;
    }
    
    // Show loading in eligible list
    if (eligibleList) {
        eligibleList.innerHTML = '<div class="loading-spinner">Checking eligible staff...</div>';
    }
    
    modal.style.display = 'flex';
    
    // Fetch eligible staff
    loadEligibleStaff(shift);
}

async function loadEligibleStaff(shift) {
    const eligibleList = document.getElementById('eligibleStaffList');
    const submitBtn = document.getElementById('submitSwapBtn');
    
    try {
        const dates = getWeekDates(employeeState.weekOffset);
        const weekStart = formatDateLocal(dates[0]);
        
        const params = new URLSearchParams({
            day: shift.dayIdx,
            start_hour: shift.start,
            end_hour: shift.end,
            role_id: shift.role || '',
            week_start: weekStart
        });
        
        const empId = employeeState.employee.db_id || employeeState.employee.id;
        const response = await fetch(
            `/api/employee/${employeeState.businessSlug}/${empId}/eligible-for-swap?${params}`
        );
        const data = await response.json();
        
        if (data.success && data.eligible.length > 0) {
            employeeState.eligibleStaff = data.eligible;
            
            // Count pickups vs swaps
            const pickupCount = data.eligible.filter(e => e.eligibility_type === 'pickup').length;
            const swapCount = data.eligible.filter(e => e.eligibility_type !== 'pickup').length;
            
            // Build quick select buttons
            let quickSelectButtons = '<div class="quick-select-buttons">';
            if (pickupCount > 0) {
                quickSelectButtons += `<button type="button" class="btn btn-sm btn-quick-select pickup" onclick="selectAllByType('pickup')">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    All Pickups (${pickupCount})
                </button>`;
            }
            if (swapCount > 0) {
                quickSelectButtons += `<button type="button" class="btn btn-sm btn-quick-select swap" onclick="selectAllByType('swap_only')">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3l4 4-4 4"></path><path d="M20 7H4"></path><path d="M8 21l-4-4 4-4"></path><path d="M4 17h16"></path></svg>
                    All Swaps (${swapCount})
                </button>`;
            }
            quickSelectButtons += `<button type="button" class="btn btn-sm btn-quick-select clear" onclick="clearAllRecipients()">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                Clear
            </button>`;
            quickSelectButtons += '</div>';
            
            // Build staff list
            const staffList = data.eligible.map(emp => {
                const statusText = emp.eligibility_type === 'pickup' 
                    ? 'Can pick up' 
                    : `Needs to swap (${emp.current_hours}h scheduled)`;
                const badgeClass = emp.eligibility_type === 'pickup' ? 'pickup' : 'swap-only';
                
                return `
                    <label class="eligible-item" data-emp-id="${emp.employee_id}" data-type="${emp.eligibility_type}">
                        <input type="checkbox" onchange="toggleRecipient('${emp.employee_id}')">
                        <div class="eligible-avatar" style="background: ${employeeMap[emp.employee_id]?.color || '#666'}">
                            ${emp.employee_name.charAt(0).toUpperCase()}
                        </div>
                        <div class="eligible-info">
                            <div class="eligible-name">${emp.employee_name}</div>
                            <div class="eligible-status">${statusText}</div>
                        </div>
                        <span class="swap-eligibility-badge ${badgeClass}">${emp.eligibility_type === 'pickup' ? 'Pickup' : 'Swap'}</span>
                    </label>
                `;
            }).join('');
            
            eligibleList.innerHTML = quickSelectButtons + staffList;
            
            if (submitBtn) submitBtn.disabled = false;
        } else {
            eligibleList.innerHTML = '<div class="loading-spinner">No eligible staff found for this shift.</div>';
        }
    } catch (error) {
        console.error('Failed to load eligible staff:', error);
        eligibleList.innerHTML = '<div class="loading-spinner">Failed to load eligible staff.</div>';
    }
}

function toggleRecipient(empId) {
    const idx = employeeState.selectedRecipients.indexOf(empId);
    if (idx === -1) {
        employeeState.selectedRecipients.push(empId);
    } else {
        employeeState.selectedRecipients.splice(idx, 1);
    }
    
    // Update visual state
    const item = document.querySelector(`.eligible-item[data-emp-id="${empId}"]`);
    if (item) {
        item.classList.toggle('selected', idx === -1);
        const checkbox = item.querySelector('input[type="checkbox"]');
        if (checkbox) checkbox.checked = idx === -1;
    }
}

function selectAllByType(type) {
    // Get all employees of this type
    const empsOfType = employeeState.eligibleStaff.filter(e => e.eligibility_type === type);
    
    // Add them to selected if not already
    empsOfType.forEach(emp => {
        if (!employeeState.selectedRecipients.includes(emp.employee_id)) {
            employeeState.selectedRecipients.push(emp.employee_id);
        }
        // Update visual state
        const item = document.querySelector(`.eligible-item[data-emp-id="${emp.employee_id}"]`);
        if (item) {
            item.classList.add('selected');
            const checkbox = item.querySelector('input[type="checkbox"]');
            if (checkbox) checkbox.checked = true;
        }
    });
}

function clearAllRecipients() {
    // Clear all selections
    employeeState.selectedRecipients = [];
    
    // Update visual state for all items
    document.querySelectorAll('.eligible-item').forEach(item => {
        item.classList.remove('selected');
        const checkbox = item.querySelector('input[type="checkbox"]');
        if (checkbox) checkbox.checked = false;
    });
}

function hideSwapModal() {
    const modal = document.getElementById('swapModal');
    if (modal) modal.style.display = 'none';
    employeeState.currentSwapShift = null;
    employeeState.eligibleStaff = [];
    employeeState.selectedRecipients = [];
}

// ==================== SHIFT DETAILS POPOVER ====================
let popoverState = {
    visible: false,
    activeElement: null,
    shiftData: null
};

function showShiftPopover(event, shiftData) {
    event.stopPropagation();
    
    const popover = document.getElementById('shiftPopover');
    if (!popover) return;
    
    // Store state
    popoverState.shiftData = shiftData;
    
    // Remove active class from previous element
    if (popoverState.activeElement) {
        popoverState.activeElement.classList.remove('popover-active');
    }
    
    // Add active class to clicked element
    const clickedEl = event.currentTarget;
    clickedEl.classList.add('popover-active');
    popoverState.activeElement = clickedEl;
    
    // Get shift details
    const myId = employeeState.employee.id;
    const isMine = shiftData.employeeId === myId || shiftData.empId === myId;
    const empId = shiftData.employeeId || shiftData.empId;
    const emp = employeeMap[empId];
    
    // Format date
    const dates = getWeekDates(employeeState.weekOffset);
    const dayIdx = shiftData.dayIdx !== undefined ? shiftData.dayIdx : shiftData.day;
    const shiftDate = dates[dayIdx];
    const dateStr = shiftDate ? shiftDate.toLocaleDateString('en-US', { 
        weekday: 'long', 
        month: 'short', 
        day: 'numeric' 
    }) : employeeState.days[dayIdx];
    
    // Get role info
    const roleId = shiftData.role || shiftData.roleId;
    const role = roleMap[roleId];
    const roleName = role?.name || roleId || 'Staff';
    
    // Calculate duration
    const startHour = shiftData.start || shiftData.startHour;
    const endHour = shiftData.end || shiftData.endHour;
    const duration = endHour - startHour;
    
    // Update popover content
    document.getElementById('popoverDate').textContent = dateStr;
    document.getElementById('popoverTime').textContent = `${formatTime(startHour)} - ${formatTime(endHour)}`;
    document.getElementById('popoverRole').textContent = roleName;
    document.getElementById('popoverDuration').textContent = `${duration} hour${duration !== 1 ? 's' : ''}`;
    
    // Show/hide employee info (for other people's shifts)
    const employeeSection = document.getElementById('popoverEmployee');
    if (!isMine && emp) {
        employeeSection.style.display = 'flex';
        document.getElementById('popoverAvatar').textContent = emp.name.charAt(0).toUpperCase();
        document.getElementById('popoverAvatar').style.background = emp.color || '#6366f1';
        document.getElementById('popoverName').textContent = emp.name;
    } else {
        employeeSection.style.display = 'none';
    }
    
    // Show/hide swap info
    const swapInfoSection = document.getElementById('popoverSwapInfo');
    if (shiftData.viaSwap) {
        swapInfoSection.style.display = 'block';
        const swappedFromName = shiftData.swappedFrom ? 
            (employeeMap[shiftData.swappedFrom]?.name || 'another employee') : 
            'another employee';
        document.getElementById('popoverSwapFrom').textContent = `Picked up from ${swappedFromName}`;
    } else {
        swapInfoSection.style.display = 'none';
    }
    
    // Show/hide swap button (only for own shifts)
    const footer = document.getElementById('popoverFooter');
    if (isMine) {
        footer.style.display = 'block';
    } else {
        footer.style.display = 'none';
    }
    
    // Position the popover
    positionPopover(clickedEl, popover);
    
    // Show popover
    popover.classList.add('visible');
    popoverState.visible = true;
}

function positionPopover(targetEl, popover) {
    const targetRect = targetEl.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const arrow = popover.querySelector('.popover-arrow');
    
    // Get scroll position to convert viewport coords to document coords
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const scrollLeft = window.scrollX || document.documentElement.scrollLeft;
    
    // Calculate initial position (below target) - use document-relative coords
    let top = targetRect.bottom + scrollTop + 10;
    let left = targetRect.left + scrollLeft + (targetRect.width / 2) - 140; // Center popover
    
    // Check if popover would go off the right edge
    const viewportWidth = window.innerWidth;
    if (left + 280 > viewportWidth + scrollLeft - 20) {
        left = viewportWidth + scrollLeft - 280 - 20;
    }
    
    // Check if popover would go off the left edge
    if (left < scrollLeft + 20) {
        left = scrollLeft + 20;
    }
    
    // Check if popover would go off the bottom of viewport
    const viewportHeight = window.innerHeight;
    const popoverHeight = 280; // Approximate height
    
    if (targetRect.bottom + popoverHeight > viewportHeight - 20) {
        // Position above instead
        top = targetRect.top + scrollTop - popoverHeight - 10;
        popover.classList.add('arrow-bottom');
    } else {
        popover.classList.remove('arrow-bottom');
    }
    
    // Position arrow relative to target center
    const arrowLeft = targetRect.left + scrollLeft + (targetRect.width / 2) - left - 6;
    arrow.style.left = `${Math.max(16, Math.min(arrowLeft, 260))}px`;
    
    // Apply position
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
}

function hideShiftPopover() {
    const popover = document.getElementById('shiftPopover');
    if (popover) {
        popover.classList.remove('visible');
    }
    
    if (popoverState.activeElement) {
        popoverState.activeElement.classList.remove('popover-active');
        popoverState.activeElement = null;
    }
    
    popoverState.visible = false;
    popoverState.shiftData = null;
}

function openSwapFromPopover() {
    const shiftData = popoverState.shiftData;
    if (!shiftData) return;
    
    // Hide the popover first
    hideShiftPopover();
    
    // Convert to the format expected by showSwapModal
    const dayIdx = shiftData.dayIdx !== undefined ? shiftData.dayIdx : shiftData.day;
    const swapShiftData = {
        dayIdx: dayIdx,
        start: shiftData.start || shiftData.startHour,
        end: shiftData.end || shiftData.endHour,
        role: shiftData.role || shiftData.roleId
    };
    
    // Open the swap modal
    showSwapModal(swapShiftData);
}

// Initialize popover event listeners
function initShiftPopover() {
    const popover = document.getElementById('shiftPopover');
    if (!popover) return;
    
    // Close button
    const closeBtn = document.getElementById('popoverClose');
    if (closeBtn) {
        closeBtn.addEventListener('click', hideShiftPopover);
    }
    
    // Swap button
    const swapBtn = document.getElementById('popoverSwapBtn');
    if (swapBtn) {
        swapBtn.addEventListener('click', openSwapFromPopover);
    }
    
    // Close on click outside
    document.addEventListener('click', (e) => {
        if (!popoverState.visible) return;
        
        const popover = document.getElementById('shiftPopover');
        if (!popover.contains(e.target) && !e.target.closest('.timeline-shift-block') && 
            !e.target.closest('.schedule-shift-block') && !e.target.closest('.shift-block')) {
            hideShiftPopover();
        }
    });
    
    // Close on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && popoverState.visible) {
            hideShiftPopover();
        }
    });
    
    // Event delegation for table view shift blocks
    const tableBody = document.getElementById('simpleScheduleBody');
    if (tableBody) {
        tableBody.addEventListener('click', (e) => {
            const shiftBlock = e.target.closest('.shift-block');
            if (shiftBlock) {
                const empId = shiftBlock.dataset.empId;
                const day = parseInt(shiftBlock.dataset.day);
                const start = parseInt(shiftBlock.dataset.start);
                const end = parseInt(shiftBlock.dataset.end);
                
                const shiftData = {
                    dayIdx: day,
                    empId: empId,
                    startHour: start,
                    endHour: end
                };
                
                showShiftPopover(e, shiftData);
            }
        });
    }
    
    // Event delegation for upcoming shifts
    const upcomingShiftsContainer = document.getElementById('upcomingShiftsList');
    if (upcomingShiftsContainer) {
        upcomingShiftsContainer.addEventListener('click', (e) => {
            // Don't trigger if clicking the swap button
            if (e.target.closest('.shift-swap-btn')) return;
            
            const clickable = e.target.closest('.shift-clickable');
            const shiftItem = e.target.closest('.upcoming-shift-item');
            if (clickable && shiftItem) {
                const day = parseInt(shiftItem.dataset.day);
                const start = parseInt(shiftItem.dataset.start);
                const end = parseInt(shiftItem.dataset.end);
                const role = shiftItem.dataset.role;
                const viaSwap = shiftItem.dataset.viaSwap === 'true';
                const swappedFrom = shiftItem.dataset.swappedFrom || null;
                
                const shiftData = {
                    dayIdx: day,
                    empId: employeeState.employee.id,
                    roleId: role,
                    startHour: start,
                    endHour: end,
                    viaSwap: viaSwap,
                    swappedFrom: swappedFrom
                };
                
                showShiftPopover(e, shiftData);
            }
        });
    }
}

// Helper to attach click handlers to shift blocks
function attachShiftClickHandler(element, shiftData) {
    element.addEventListener('click', (e) => showShiftPopover(e, shiftData));
    element.style.cursor = 'pointer';
}

async function submitSwapRequest() {
    const shift = employeeState.currentSwapShift;
    if (!shift) return;
    
    const noteField = document.getElementById('swapNote');
    const submitBtn = document.getElementById('submitSwapBtn');
    
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Sending...';
    }
    
    try {
        const dates = getWeekDates(employeeState.weekOffset);
        const weekStart = formatDateLocal(dates[0]);
        
        const empId = employeeState.employee.db_id || employeeState.employee.id;
        const response = await fetch(
            `/api/employee/${employeeState.businessSlug}/${empId}/swap-request`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    day: shift.dayIdx,
                    start_hour: shift.start,
                    end_hour: shift.end,
                    role_id: shift.role,
                    week_start: weekStart,
                    note: noteField?.value || '',
                    recipients: employeeState.selectedRecipients.length > 0 
                        ? employeeState.selectedRecipients 
                        : undefined
                })
            }
        );
        
        const data = await response.json();
        
        if (data.success) {
            const count = data.eligible_count || 0;
            showToast(`Swap request sent to ${count} staff member${count !== 1 ? 's' : ''}!`, 'success');
            hideSwapModal();
            loadSwapRequests();
        } else {
            showToast(data.message || 'Failed to create swap request', 'error');
        }
    } catch (error) {
        console.error('Failed to submit swap request:', error);
        showToast('Failed to send swap request', 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Send Request';
        }
    }
}

function showSwapResponseModal(requestId) {
    const request = employeeState.swapRequests.incoming.find(r => r.id === requestId);
    if (!request) return;
    
    employeeState.currentSwapRequest = request;
    employeeState.selectedSwapShift = null;
    employeeState.myShiftsForCounterOffer = [];
    
    const modal = document.getElementById('swapResponseModal');
    const modalHeader = modal?.querySelector('.modal-header h2');
    const details = document.getElementById('swapRequestDetails');
    const counterOfferSection = document.getElementById('counterOfferSection');
    const counterOfferToggle = document.getElementById('counterOfferToggle');
    const counterOfferShifts = document.getElementById('counterOfferShifts');
    const acceptBtn = document.getElementById('acceptSwapBtn');
    
    if (!modal) return;
    
    const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const isCounterOffer = request.is_counter_offer;
    
    // Update modal title for counter offers
    if (modalHeader) {
        modalHeader.textContent = isCounterOffer ? 'Counter Offer Received' : 'Respond to Swap Request';
    }
    
    // Show request details - different text for counter offers
    if (details) {
        if (isCounterOffer) {
            details.innerHTML = `
                <div class="swap-shift-details counter-offer-details">
                    <div class="counter-offer-badge">⇄ Counter Offer</div>
                    <p style="margin: 0.5rem 0;"><strong>${request.requester_name}</strong> responded to your swap request with a counter offer:</p>
                    <p style="margin: 0.25rem 0; color: var(--text-secondary);">They're offering their shift:</p>
                    <div class="shift-day">${dayNames[request.original_day]}</div>
                    <div class="shift-time">${formatTime(request.original_start_hour)} - ${formatTime(request.original_end_hour)}</div>
                    ${request.note ? `<p style="margin: 0.75rem 0 0; font-style: italic; color: var(--text-muted);">"${request.note}"</p>` : ''}
                </div>
            `;
        } else {
            const requestType = request.my_eligibility_type === 'pickup' ? 'give away' : 'swap';
            details.innerHTML = `
                <div class="swap-shift-details">
                    <p style="margin: 0 0 0.5rem 0;"><strong>${request.requester_name}</strong> wants to ${requestType}:</p>
                    <div class="shift-day">${dayNames[request.original_day]}</div>
                    <div class="shift-time">${formatTime(request.original_start_hour)} - ${formatTime(request.original_end_hour)}</div>
                    ${request.note ? `<p style="margin: 0.75rem 0 0; font-style: italic; color: var(--text-muted);">"${request.note}"</p>` : ''}
                </div>
            `;
        }
    }
    
    // Reset counter-offer section
    if (counterOfferToggle) counterOfferToggle.classList.remove('active');
    if (counterOfferShifts) counterOfferShifts.style.display = 'none';
    
    // For counter offers received, hide the counter-offer section (they just accept or decline)
    if (isCounterOffer) {
        if (counterOfferSection) counterOfferSection.style.display = 'none';
        if (acceptBtn) {
            acceptBtn.disabled = false;
            acceptBtn.textContent = 'Accept Swap';
        }
    }
    // Handle based on eligibility type
    else if (request.my_eligibility_type === 'swap_only') {
        // Must offer a swap - expand counter-offer automatically
        if (counterOfferSection) counterOfferSection.style.display = 'block';
        if (counterOfferToggle) {
            counterOfferToggle.classList.add('active');
            counterOfferToggle.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="17 1 21 5 17 9"></polyline>
                    <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
                    <polyline points="7 23 3 19 7 15"></polyline>
                    <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
                </svg>
                You must offer a shift in exchange
                <span class="toggle-arrow" style="transform: rotate(90deg);">›</span>
            `;
        }
        if (counterOfferShifts) counterOfferShifts.style.display = 'block';
        loadMyShiftsForCounterOffer();
        if (acceptBtn) {
            acceptBtn.disabled = true;
            acceptBtn.textContent = 'Select a Shift';
        }
    } else {
        // Can pickup without swap - show counter-offer as optional
        if (counterOfferSection) counterOfferSection.style.display = 'block';
        if (counterOfferToggle) {
            counterOfferToggle.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="17 1 21 5 17 9"></polyline>
                    <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
                    <polyline points="7 23 3 19 7 15"></polyline>
                    <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
                </svg>
                Counter with my own shift
                <span class="toggle-arrow">›</span>
            `;
        }
        if (acceptBtn) {
            acceptBtn.disabled = false;
            acceptBtn.textContent = 'Accept Pickup';
        }
    }
    
    modal.style.display = 'flex';
}

function getMyShiftsForWeek() {
    const shifts = [];
    const schedule = employeeState.schedule;
    const dates = getWeekDates(employeeState.weekOffset);
    
    if (!schedule) return shifts;
    
    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
        const dayShifts = getMyContinuousShiftsForDay(schedule, dayIdx);
        dayShifts.forEach(shift => {
            shifts.push({
                ...shift,
                dayIdx,
                date: dates[dayIdx]
            });
        });
    }
    
    return shifts;
}

function selectSwapShift(idx) {
    const myShifts = getMyShiftsForWeek();
    employeeState.selectedSwapShift = myShifts[idx];
    
    // Update visual state
    document.querySelectorAll('.my-shift-option').forEach((el, i) => {
        el.classList.toggle('selected', i === idx);
    });
    
    // Enable accept button
    const acceptBtn = document.getElementById('acceptSwapBtn');
    if (acceptBtn) acceptBtn.disabled = false;
}

function hideSwapResponseModal() {
    const modal = document.getElementById('swapResponseModal');
    if (modal) modal.style.display = 'none';
    employeeState.currentSwapRequest = null;
    employeeState.selectedSwapShift = null;
    employeeState.myShiftsForCounterOffer = [];
    
    // Reset counter-offer UI
    const toggle = document.getElementById('counterOfferToggle');
    const shiftsContainer = document.getElementById('counterOfferShifts');
    if (toggle) toggle.classList.remove('active');
    if (shiftsContainer) shiftsContainer.style.display = 'none';
}

async function acceptSwapRequest() {
    const request = employeeState.currentSwapRequest;
    if (!request) return;
    
    // If swap-only and no shift selected, error
    if (request.my_eligibility_type === 'swap_only' && !employeeState.selectedSwapShift) {
        showToast('Please select a shift to offer in exchange', 'error');
        return;
    }
    
    const acceptBtn = document.getElementById('acceptSwapBtn');
    const isCounterOffer = !!employeeState.selectedSwapShift;
    
    if (acceptBtn) {
        acceptBtn.disabled = true;
        acceptBtn.textContent = isCounterOffer ? 'Sending...' : 'Accepting...';
    }
    
    try {
        const body = {
            // If they selected a shift, it's a counter offer, not a direct accept
            response: isCounterOffer ? 'counter_offer' : 'accept'
        };
        
        if (employeeState.selectedSwapShift) {
            body.swap_shift = {
                day: employeeState.selectedSwapShift.dayIdx,
                start_hour: employeeState.selectedSwapShift.start,
                end_hour: employeeState.selectedSwapShift.end,
                role_id: employeeState.selectedSwapShift.role
            };
        }
        
        const empId = employeeState.employee.db_id || employeeState.employee.id;
        const response = await fetch(
            `/api/employee/${employeeState.businessSlug}/${empId}/swap-request/${request.id}/respond`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }
        );
        
        const data = await response.json();
        
        if (data.success) {
            const message = isCounterOffer 
                ? 'Counter offer sent! Waiting for their response.' 
                : 'Swap accepted! The schedule has been updated.';
            showToast(message, 'success');
            const swapRequest = employeeState.currentSwapRequest;
            hideSwapResponseModal();
            loadSwapRequests();
            if (!isCounterOffer) {
                await loadScheduleData();
                scrollToAndHighlightSwappedShift(swapRequest);
            }
        } else {
            showToast(data.message || 'Failed to process request', 'error');
        }
    } catch (error) {
        console.error('Failed to accept swap:', error);
        showToast('Failed to accept swap request', 'error');
    } finally {
        if (acceptBtn) {
            acceptBtn.disabled = false;
            acceptBtn.textContent = 'Accept';
        }
    }
}

async function declineSwapRequest() {
    const request = employeeState.currentSwapRequest;
    if (!request) return;
    
    const declineBtn = document.getElementById('declineSwapBtn');
    if (declineBtn) {
        declineBtn.disabled = true;
        declineBtn.textContent = 'Declining...';
    }
    
    try {
        const empId = employeeState.employee.db_id || employeeState.employee.id;
        const response = await fetch(
            `/api/employee/${employeeState.businessSlug}/${empId}/swap-request/${request.id}/respond`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ response: 'decline' })
            }
        );
        
        const data = await response.json();
        
        if (data.success) {
            showToast('Swap request declined', 'info');
            hideSwapResponseModal();
            loadSwapRequests();
        } else {
            showToast(data.message || 'Failed to decline swap', 'error');
        }
    } catch (error) {
        console.error('Failed to decline swap:', error);
        showToast('Failed to decline swap request', 'error');
    } finally {
        if (declineBtn) {
            declineBtn.disabled = false;
            declineBtn.textContent = 'Decline';
        }
    }
}

async function cancelMySwapRequest(requestId) {
    if (!confirm('Are you sure you want to cancel this swap request?')) return;
    
    try {
        const empId = employeeState.employee.db_id || employeeState.employee.id;
        const response = await fetch(
            `/api/employee/${employeeState.businessSlug}/${empId}/swap-request/${requestId}/cancel`,
            { method: 'POST' }
        );
        
        const data = await response.json();
        
        if (data.success) {
            showToast('Swap request cancelled', 'info');
            loadSwapRequests();
        } else {
            showToast(data.message || 'Failed to cancel swap request', 'error');
        }
    } catch (error) {
        console.error('Failed to cancel swap request:', error);
        showToast('Failed to cancel swap request', 'error');
    }
}

// ==================== PTO REQUEST MANAGEMENT ====================
const ptoState = {
    requests: []
};

function initPTORequests() {
    const ptoRequestsList = document.getElementById('ptoRequestsList');
    if (!ptoRequestsList) return;
    
    // Setup modal controls
    const newPtoBtn = document.getElementById('newPtoRequestBtn');
    const ptoModal = document.getElementById('ptoRequestModal');
    const closePtoModal = document.getElementById('closePtoModal');
    const cancelPtoBtn = document.getElementById('cancelPtoBtn');
    const submitPtoBtn = document.getElementById('submitPtoBtn');
    
    if (newPtoBtn) {
        newPtoBtn.addEventListener('click', openPTORequestModal);
    }
    if (closePtoModal) {
        closePtoModal.addEventListener('click', closePTOModal);
    }
    if (cancelPtoBtn) {
        cancelPtoBtn.addEventListener('click', closePTOModal);
    }
    if (submitPtoBtn) {
        submitPtoBtn.addEventListener('click', submitPTORequest);
    }
    
    // Click outside modal to close
    if (ptoModal) {
        ptoModal.addEventListener('click', (e) => {
            if (e.target === ptoModal) {
                closePTOModal();
            }
        });
    }
    
    // Set minimum date to today
    const startDateInput = document.getElementById('ptoStartDate');
    const endDateInput = document.getElementById('ptoEndDate');
    if (startDateInput) {
        const today = new Date().toISOString().split('T')[0];
        startDateInput.min = today;
        startDateInput.addEventListener('change', () => {
            if (endDateInput) {
                endDateInput.min = startDateInput.value;
            }
        });
    }
    
    // Load existing requests
    loadPTORequests();
}

function openPTORequestModal() {
    const modal = document.getElementById('ptoRequestModal');
    if (!modal) return;
    
    // Reset form
    document.getElementById('ptoStartDate').value = '';
    document.getElementById('ptoEndDate').value = '';
    document.getElementById('ptoType').value = 'vacation';
    document.getElementById('ptoNote').value = '';
    
    modal.classList.add('active');
}

function closePTOModal() {
    const modal = document.getElementById('ptoRequestModal');
    if (modal) {
        modal.classList.remove('active');
    }
}

async function loadPTORequests() {
    try {
        const response = await fetch(`/api/employee/${employeeState.businessSlug}/${employeeState.employee.db_id}/pto`);
        const data = await response.json();
        
        if (data.success) {
            ptoState.requests = data.pto_requests;
            renderPTORequestsList();
        }
    } catch (error) {
        console.error('Error loading PTO requests:', error);
    }
}

async function submitPTORequest() {
    const startDate = document.getElementById('ptoStartDate').value;
    const endDate = document.getElementById('ptoEndDate').value || startDate;
    const ptoType = document.getElementById('ptoType').value;
    const note = document.getElementById('ptoNote').value;
    
    if (!startDate) {
        showToast('Please select a start date', 'error');
        return;
    }
    
    try {
        const response = await fetch(`/api/employee/${employeeState.businessSlug}/${employeeState.employee.db_id}/pto`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                start_date: startDate,
                end_date: endDate,
                pto_type: ptoType,
                note: note
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast('Time off request submitted', 'success');
            closePTOModal();
            loadPTORequests();
        } else {
            showToast(data.error || 'Failed to submit request', 'error');
        }
    } catch (error) {
        console.error('Error submitting PTO request:', error);
        showToast('Failed to submit request', 'error');
    }
}

// Store pending cancel request
let pendingCancelPTO = null;

function showCancelPTOConfirm(requestId, ptoType, dateRange) {
    pendingCancelPTO = requestId;
    
    // Create or get the confirmation popup
    let popup = document.getElementById('cancelPTOPopup');
    if (!popup) {
        popup = document.createElement('div');
        popup.id = 'cancelPTOPopup';
        popup.className = 'cancel-pto-popup';
        popup.innerHTML = `
            <div class="cancel-pto-popup-content">
                <div class="cancel-pto-popup-header">
                    <span class="cancel-pto-icon">🗑️</span>
                    <h3>Cancel Time Off?</h3>
                </div>
                <p class="cancel-pto-message">
                    Are you sure you want to cancel this <strong id="cancelPTOType"></strong> request for <strong id="cancelPTODates"></strong>?
                </p>
                <div class="cancel-pto-actions">
                    <button class="btn btn-ghost" onclick="hideCancelPTOPopup()">Keep It</button>
                    <button class="btn btn-danger" onclick="confirmCancelPTO()">Cancel Request</button>
                </div>
            </div>
        `;
        document.body.appendChild(popup);
    }
    
    // Update the message
    document.getElementById('cancelPTOType').textContent = ptoType;
    document.getElementById('cancelPTODates').textContent = dateRange;
    
    // Show the popup
    popup.classList.add('visible');
}

function hideCancelPTOPopup() {
    const popup = document.getElementById('cancelPTOPopup');
    if (popup) {
        popup.classList.remove('visible');
    }
    pendingCancelPTO = null;
}

async function confirmCancelPTO() {
    if (!pendingCancelPTO) return;
    
    const requestId = pendingCancelPTO;
    hideCancelPTOPopup();
    
    try {
        const response = await fetch(`/api/employee/${employeeState.businessSlug}/${employeeState.employee.db_id}/pto/${requestId}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast('Time off request cancelled', 'success');
            loadPTORequests();
            // Also refresh schedule if on schedule page
            if (typeof loadScheduleData === 'function') {
                loadScheduleData();
            }
        } else {
            showToast(data.error || 'Failed to cancel request', 'error');
        }
    } catch (error) {
        console.error('Error cancelling PTO request:', error);
        showToast('Failed to cancel request', 'error');
    }
}

// Keep old function for backwards compatibility
async function cancelPTORequest(requestId) {
    showCancelPTOConfirm(requestId, 'time off', 'these dates');
}

function renderPTORequestsList() {
    const container = document.getElementById('ptoRequestsList');
    const emptyState = document.getElementById('ptoEmptyState');
    if (!container) return;
    
    // Filter out cancelled requests for cleaner display
    const visibleRequests = ptoState.requests.filter(req => req.status !== 'cancelled');
    
    if (visibleRequests.length === 0) {
        if (emptyState) emptyState.style.display = 'flex';
        // Remove any existing request items but keep empty state
        container.querySelectorAll('.pto-request-item').forEach(el => el.remove());
        return;
    }
    
    if (emptyState) emptyState.style.display = 'none';
    
    // Build HTML
    let html = '';
    visibleRequests.forEach(req => {
        const statusClass = req.status;
        const statusIcon = getStatusIcon(req.status);
        const typeEmoji = getPTOTypeEmoji(req.pto_type);
        const dateRange = formatPTODateRange(req.start_date, req.end_date);
        const canCancel = req.status === 'pending' || req.status === 'approved';
        
        html += `
            <div class="pto-request-item ${statusClass}" id="pto-request-${req.id}">
                <div class="pto-request-icon">${statusIcon}</div>
                <div class="pto-request-info">
                    <div class="pto-request-dates">${dateRange}</div>
                    <div class="pto-request-meta">
                        <span class="pto-type">${typeEmoji} ${capitalizeFirst(req.pto_type)}</span>
                        <span class="pto-status-badge ${statusClass}">${capitalizeFirst(req.status)}</span>
                    </div>
                    ${req.employee_note ? `<div class="pto-request-note">"${req.employee_note}"</div>` : ''}
                    ${req.manager_note ? `<div class="pto-manager-note">Manager: "${req.manager_note}"</div>` : ''}
                </div>
                ${canCancel ? `
                    <button class="pto-delete-btn" onclick="showCancelPTOConfirm('${req.id}', '${req.pto_type}', '${dateRange}')" title="Cancel request">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>
                ` : ''}
            </div>
        `;
    });
    
    // Keep empty state element, remove old items, add new
    container.querySelectorAll('.pto-request-item').forEach(el => el.remove());
    container.insertAdjacentHTML('beforeend', html);
    
    // Check if we need to scroll to a specific request (from notification click)
    scrollToPTORequestFromHash();
}

function scrollToPTORequestFromHash() {
    const hash = window.location.hash;
    if (hash && hash.startsWith('#pto-request-')) {
        const element = document.querySelector(hash);
        if (element) {
            // Wait a moment for the page to settle
            setTimeout(() => {
                element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                // Add highlight effect
                element.classList.add('pto-highlight');
                setTimeout(() => {
                    element.classList.remove('pto-highlight');
                }, 3000);
            }, 300);
            
            // Clear the hash so refreshing doesn't re-scroll
            history.replaceState(null, '', window.location.pathname);
        }
    }
}

function getStatusIcon(status) {
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
        // Single day
        return `${months[start.getMonth()]} ${start.getDate()}, ${start.getFullYear()}`;
    } else if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
        // Same month
        return `${months[start.getMonth()]} ${start.getDate()}-${end.getDate()}, ${start.getFullYear()}`;
    } else {
        // Different months
        return `${months[start.getMonth()]} ${start.getDate()} - ${months[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
    }
}

function capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

// ==================== PTO NOTIFICATIONS (EMPLOYEE PORTAL) ====================

// Track PTO requests the employee has seen
const seenPTOUpdates = new Set(JSON.parse(localStorage.getItem('seenPTOUpdates') || '[]'));

// Track swap request updates (accepted/declined) the requester has seen
const seenSwapUpdates = new Set(JSON.parse(localStorage.getItem('seenSwapUpdates') || '[]'));

function markSwapUpdateSeen(swapId) {
    seenSwapUpdates.add(swapId);
    seenSwapUpdates.add(String(swapId));
    localStorage.setItem('seenSwapUpdates', JSON.stringify([...seenSwapUpdates]));
}

function initPTONotifications() {
    // Load PTO notifications
    loadPTONotifications();
    
    const bell = document.getElementById('ptoNotificationBell');
    const dropdown = document.getElementById('ptoNotificationDropdown');
    const closeBtn = document.getElementById('closePTONotificationsMobile');
    
    if (bell && dropdown) {
        bell.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.classList.toggle('visible');
        });
        
        if (closeBtn) {
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                dropdown.classList.remove('visible');
            });
        }
        
        document.addEventListener('click', (e) => {
            if (!dropdown.contains(e.target) && !bell.contains(e.target)) {
                dropdown.classList.remove('visible');
            }
        });
    }
}

async function loadPTONotifications() {
    try {
        const empId = employeeState.employee.db_id || employeeState.employee.id;
        const response = await fetch(`/api/employee/${employeeState.businessSlug}/${empId}/pto`);
        const data = await response.json();
        
        if (data.success) {
            // Filter for approved or denied requests (decisions made)
            const decidedRequests = (data.pto_requests || []).filter(req => 
                req.status === 'approved' || req.status === 'denied'
            );
            
            // Store in state for unified badge
            employeeState.ptoNotifications = decidedRequests;
            
            renderPTONotificationDropdown(decidedRequests);
            updateUnifiedNotificationBadge();
        }
    } catch (error) {
        console.warn('Could not load PTO notifications:', error);
    }
}

function updatePTONotificationBadge(count) {
    // Now handled by updateUnifiedNotificationBadge()
    updateUnifiedNotificationBadge();
}

function renderPTONotificationDropdown(requests) {
    const list = document.getElementById('ptoNotificationList');
    if (!list) return;
    
    // Filter out already-seen notifications
    const unseenRequests = requests.filter(req => !seenPTOUpdates.has(req.id));
    
    if (unseenRequests.length === 0) {
        list.innerHTML = `
            <div class="notification-empty">
                <p>No time off updates</p>
            </div>
        `;
        return;
    }
    
    list.innerHTML = unseenRequests.map(req => {
        const isApproved = req.status === 'approved';
        const statusClass = isApproved ? 'pto-approved' : 'pto-denied';
        const statusIcon = isApproved ? '✓' : '✕';
        const statusText = isApproved ? 'Approved' : 'Denied';
        
        // Format dates - use existing function with string dates
        const dateRange = formatPTODateRange(req.start_date, req.end_date);
        
        // PTO type - use existing function
        const typeEmoji = getPTOTypeEmoji(req.pto_type);
        const typeName = capitalizeFirst(req.pto_type || 'time off');
        
        return `
            <div class="notification-item ${statusClass}" 
                 data-request-id="${req.id}"
                 onclick="handlePTONotificationClick('${req.id}')">
                <div class="pto-notification-content">
                    <span class="pto-status-icon">${statusIcon}</span>
                    <div class="pto-notification-text">
                        <div class="pto-notification-title">${statusText}</div>
                        <div class="pto-notification-dates">${dateRange}</div>
                        <div class="pto-notification-type">${typeEmoji} ${typeName}</div>
                        <div class="pto-view-link">
                            View details →
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function markAllPTONotificationsAsSeen() {
    // Get all notification items and mark them as seen
    const notificationItems = document.querySelectorAll('#ptoNotificationList .notification-item');
    notificationItems.forEach(item => {
        const requestId = item.dataset.requestId;
        if (requestId) {
            seenPTOUpdates.add(requestId);
            item.classList.remove('unseen');
        }
    });
    
    // Save to localStorage
    localStorage.setItem('seenPTOUpdates', JSON.stringify([...seenPTOUpdates]));
    
    // Clear the badge
    updatePTONotificationBadge(0);
}

function handlePTONotificationClick(requestId) {
    // Mark as seen
    seenPTOUpdates.add(requestId);
    localStorage.setItem('seenPTOUpdates', JSON.stringify([...seenPTOUpdates]));
    
    // Remove the notification item from the dropdown immediately
    const notificationItem = document.querySelector(`.notification-item[data-request-id="${requestId}"]`);
    if (notificationItem) {
        notificationItem.remove();
    }
    
    // Update badge count
    const badge = document.getElementById('ptoNotificationBadge');
    if (badge && badge.textContent) {
        const currentCount = parseInt(badge.textContent) || 0;
        if (currentCount > 0) {
            updatePTONotificationBadge(currentCount - 1);
        }
    }
    
    // Check if dropdown is now empty
    const list = document.getElementById('ptoNotificationList');
    const remainingItems = list ? list.querySelectorAll('.notification-item').length : 0;
    if (remainingItems === 0 && list) {
        list.innerHTML = `
            <div class="notification-empty">
                <p>No time off updates</p>
            </div>
        `;
    }
    
    // Close dropdown
    const dropdown = document.getElementById('ptoNotificationDropdown');
    if (dropdown) dropdown.classList.remove('visible');
    
    // Check if we're already on the availability page
    const availabilityTable = document.getElementById('availabilityTable');
    if (availabilityTable) {
        // We're on availability page - just scroll to the request
        const element = document.getElementById(`pto-request-${requestId}`);
        if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            element.classList.add('pto-highlight');
            setTimeout(() => element.classList.remove('pto-highlight'), 3000);
        }
    } else {
        // Navigate to availability page with the request ID as a hash
        const availabilityUrl = `/employee/${employeeState.businessSlug}/${employeeState.employee.db_id || employeeState.employee.id}/availability#pto-request-${requestId}`;
        window.location.href = availabilityUrl;
    }
}

// ==================== HAMBURGER MENU ====================
function initHamburgerMenu() {
    const hamburgerBtn = document.getElementById('hamburgerMenuBtn');
    const slideMenu = document.getElementById('slideMenu');
    const slideOverlay = document.getElementById('slideMenuOverlay');
    const closeBtn = document.getElementById('slideMenuClose');
    let scrollY = 0;
    
    if (!hamburgerBtn || !slideMenu) return;
    
    // Open menu
    hamburgerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        scrollY = window.scrollY || window.pageYOffset || 0;
        slideMenu.classList.add('visible');
        slideOverlay.classList.add('visible');
        document.body.classList.add('menu-open');
        document.body.style.top = `-${scrollY}px`;
    });
    
    // Close menu
    function closeMenu() {
        slideMenu.classList.remove('visible');
        slideOverlay.classList.remove('visible');
        document.body.classList.remove('menu-open');
        document.body.style.top = '';
        window.scrollTo(0, scrollY);
    }
    
    if (closeBtn) {
        closeBtn.addEventListener('click', closeMenu);
    }
    
    if (slideOverlay) {
        slideOverlay.addEventListener('click', closeMenu);
    }

    // Close if clicking anywhere outside the menu
    document.addEventListener('click', (e) => {
        if (slideMenu.classList.contains('visible')) {
            const clickedInside = slideMenu.contains(e.target) || hamburgerBtn.contains(e.target);
            if (!clickedInside) {
                closeMenu();
            }
        }
    });
    
    // Close on escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && slideMenu.classList.contains('visible')) {
            closeMenu();
        }
    });
}

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', () => {
    // Initialize hamburger menu on all employee pages
    initHamburgerMenu();
    
    // Determine which page we're on
    const scheduleView = document.getElementById('scheduleViewTimeline');
    const availabilityCardsView = document.getElementById('availabilityCardsView');
    
    if (scheduleView) {
        initScheduleView();
        initShiftPopover();
    }
    
    if (availabilityCardsView) {
        initAvailabilityEditor();
        initPTORequests();
        initPTONotifications(); // Also show PTO notifications on availability page
    }
});
