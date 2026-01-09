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
    selectionMode: null, // 'add' or 'remove'
    // Swap request state
    swapRequests: { incoming: [], outgoing: [] },
    currentSwapShift: null,
    eligibleStaff: [],
    selectedRecipients: [],
    currentSwapRequest: null,
    selectedSwapShift: null
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
function initScheduleView() {
    setupViewToggle();
    setupFilterToggle();
    setupWeekNavigation();
    updateWeekDisplay();
    loadScheduleData();
    renderScheduleView();
    initSwapFeature();
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
                dayAssignments[empId].hours.push(hour);
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
        
        // Create row containers and render shifts
        const numShiftRows = shiftRows.length || 1; // At least 1 empty row
        
        for (let rowIdx = 0; rowIdx < numShiftRows; rowIdx++) {
            const rowContainer = document.createElement('div');
            rowContainer.className = 'timeline-slots-row';
            
            // Add shifts for this row
            const rowShifts = shiftRows[rowIdx] || [];
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
                
                // Color based on role
                const role = roleMap[shift.roleId];
                const blockColor = role?.color || shift.emp.color || '#6366f1';
                block.style.background = blockColor;
                
                // Tooltip
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
                
                rowContainer.appendChild(block);
            });
            
            slotsDiv.appendChild(rowContainer);
        }
        
        // Ensure at least one empty row if no shifts
        if (numShiftRows === 0) {
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
        thead.innerHTML = '<th class="time-col">Time</th>';
        
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
    
    // Build grid body with time rows
    let html = '';
    for (let hour = employeeState.startHour; hour < employeeState.endHour; hour++) {
        html += `<tr>`;
        html += `<td class="time-cell">${formatTime(hour)}</td>`;
        
        employeeState.daysOpen.forEach((dayIdx, colIndex) => {
            const cellClass = 'slot ' + (dayIdx % 2 === 0 ? 'day-even' : 'day-odd');
            html += `<td class="${cellClass}" data-day="${dayIdx}" data-hour="${hour}"></td>`;
        });
        
        html += `</tr>`;
    }
    gridBody.innerHTML = html;
    
    // Clear and render shift blocks after DOM is updated
    if (eventsContainer) {
        eventsContainer.innerHTML = '';
        
        // Use setTimeout to ensure DOM is rendered before calculating positions
        setTimeout(() => {
            if (schedule && schedule.slot_assignments) {
                renderGridShifts(schedule, eventsContainer, showEveryone);
            }
        }, 0);
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
        
        // Get color from role
        let color = emp.color || '#666';
        if (segment.roles.size > 0) {
            const firstRoleId = Array.from(segment.roles)[0];
            color = roleMap[firstRoleId]?.color || emp.color || '#666';
        }
        
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
                empHoursToday[empId].push(hour);
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
    
    // Get employees with shifts
    const employeesWithShifts = Object.values(employeeSchedules)
        .filter(es => es.totalHours > 0)
        .sort((a, b) => b.totalHours - a.totalHours);
    
    // If we have employees with shifts, render them
    if (employeesWithShifts.length > 0) {
        employeesWithShifts.forEach(empSchedule => {
            const emp = empSchedule.employee;
            const isMine = emp.id === myId || emp.id == myId;
            const row = document.createElement('tr');
            row.className = isMine ? 'my-row' : '';
            
            // Get role color for this employee
            const empRoles = emp.roles || [];
            const firstRoleId = empRoles[0];
            const roleColor = roleMap[firstRoleId]?.color || emp.color || '#666';
            
            let html = `<td class="name-col"><div class="emp-name">
                <span class="emp-color" style="background: ${roleColor}"></span>
                <span>${emp.name}</span>
            </div></td>`;
            
            for (let day = 0; day < 7; day++) {
                const dayClass = day % 2 === 0 ? 'day-even' : 'day-odd';
                const shifts = empSchedule.days[day];
                if (shifts.length === 0) {
                    html += `<td class="shift-times ${dayClass}"><span class="no-shift">—</span></td>`;
                } else {
                    const shiftStrs = shifts.map(s => `<span class="shift-block">${formatTime(s.start)}-${formatTime(s.end)}</span>`).join('');
                    html += `<td class="shift-times ${dayClass}">${shiftStrs}</td>`;
                }
            }
            
            html += `<td class="total-hours">${empSchedule.totalHours}h</td>`;
            row.innerHTML = html;
            tbody.appendChild(row);
        });
    } else {
        // No shifts - show empty table structure with placeholder rows
        // Add a few empty placeholder rows to maintain table appearance
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
    
    const upcomingShifts = [];
    
    if (schedule) {
        employeeState.daysOpen.forEach(dayIdx => {
            const date = dates[dayIdx];
            if (date >= today) {
                // Only show MY upcoming shifts - use continuous shifts to merge work periods
                const shifts = getMyContinuousShiftsForDay(schedule, dayIdx);
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
    displayShifts.forEach((shift, idx) => {
        const role = roleMap[shift.role] || {};
        const duration = shift.end - shift.start;
        
        // Create a unique shift identifier for the swap button
        const shiftData = JSON.stringify({
            dayIdx: shift.dayIdx,
            start: shift.start,
            end: shift.end,
            role: shift.role
        }).replace(/"/g, '&quot;');
        
        // Check if shift was obtained via swap
        const swapBadge = shift.viaSwap 
            ? `<span class="swap-badge" title="Obtained via shift swap from ${employeeMap[shift.swappedFrom]?.name || 'another employee'}">🔄 Swapped</span>` 
            : '';
        
        html += `<div class="upcoming-shift-item ${shift.viaSwap ? 'via-swap' : ''}">
            <div class="shift-date-badge">
                <span class="day-name">${DAYS_SHORT[shift.dayIdx]}</span>
                <span class="day-num">${shift.date.getDate()}</span>
            </div>
            <div class="shift-details">
                <div class="shift-time">${formatTimeRange(shift.start, shift.end)} ${swapBadge}</div>
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

// ==================== SHIFT SWAP FEATURE ====================

function initSwapFeature() {
    // Setup modal events
    setupSwapModals();
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
    
    // Close modals when clicking overlay
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.style.display = 'none';
            }
        });
    });
}

async function loadSwapRequests() {
    try {
        const response = await fetch(`/api/employee/${employeeState.businessSlug}/${employeeState.employee.id}/swap-requests`);
        const data = await response.json();
        
        if (data.success) {
            employeeState.swapRequests = {
                incoming: data.incoming || [],
                outgoing: data.outgoing || []
            };
            renderSwapRequests();
        }
    } catch (error) {
        console.error('Failed to load swap requests:', error);
    }
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
        const eligibilityBadge = req.my_eligibility_type === 'pickup' 
            ? '<span class="swap-eligibility-badge pickup">Can Pick Up</span>'
            : '<span class="swap-eligibility-badge swap-only">Swap Required</span>';
        
        return `
            <div class="swap-request-item incoming" data-request-id="${req.id}">
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
                        ${eligibilityBadge}
                    </div>
                    <div class="swap-request-shift">
                        Wants to swap: <strong>${shiftTime}</strong>
                    </div>
                    ${req.note ? `<div class="swap-request-note">"${req.note}"</div>` : ''}
                    <div class="swap-request-actions">
                        <button class="btn btn-success btn-sm" onclick="showSwapResponseModal('${req.id}')">
                            Respond
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
        const weekStart = dates[0].toISOString().split('T')[0];
        
        const params = new URLSearchParams({
            day: shift.dayIdx,
            start_hour: shift.start,
            end_hour: shift.end,
            role_id: shift.role || '',
            week_start: weekStart
        });
        
        const response = await fetch(
            `/api/employee/${employeeState.businessSlug}/${employeeState.employee.id}/eligible-for-swap?${params}`
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
        const weekStart = dates[0].toISOString().split('T')[0];
        
        const response = await fetch(
            `/api/employee/${employeeState.businessSlug}/${employeeState.employee.id}/swap-request`,
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
            showToast(`Swap request sent! ${data.notifications_sent} notification(s) sent.`, 'success');
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
    
    const modal = document.getElementById('swapResponseModal');
    const details = document.getElementById('swapRequestDetails');
    const swapOfferSection = document.getElementById('swapOfferSection');
    const myShiftsList = document.getElementById('myShiftsForSwap');
    const acceptBtn = document.getElementById('acceptSwapBtn');
    
    if (!modal) return;
    
    // Show request details
    const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    
    if (details) {
        details.innerHTML = `
            <div class="swap-shift-details">
                <p style="margin: 0 0 0.5rem 0;"><strong>${request.requester_name}</strong> wants to swap:</p>
                <div class="shift-day">${dayNames[request.original_day]}</div>
                <div class="shift-time">${formatTime(request.original_start_hour)} - ${formatTime(request.original_end_hour)}</div>
                ${request.note ? `<p style="margin: 0.75rem 0 0; font-style: italic; color: var(--text-muted);">"${request.note}"</p>` : ''}
            </div>
        `;
    }
    
    // Show swap offer section if needed
    if (request.my_eligibility_type === 'swap_only') {
        if (swapOfferSection) swapOfferSection.style.display = 'block';
        if (acceptBtn) acceptBtn.disabled = true;
        
        // Get my shifts for this week
        const myShifts = getMyShiftsForWeek();
        
        if (myShiftsList) {
            if (myShifts.length === 0) {
                myShiftsList.innerHTML = '<p>You have no shifts to offer in exchange.</p>';
            } else {
                myShiftsList.innerHTML = myShifts.map((shift, idx) => `
                    <label class="my-shift-option" data-shift-idx="${idx}">
                        <input type="radio" name="swapShift" onchange="selectSwapShift(${idx})">
                        <div style="flex: 1;">
                            <strong>${dayNames[shift.dayIdx]}</strong> ${formatTime(shift.start)} - ${formatTime(shift.end)}
                        </div>
                    </label>
                `).join('');
            }
        }
    } else {
        if (swapOfferSection) swapOfferSection.style.display = 'none';
        if (acceptBtn) acceptBtn.disabled = false;
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
    if (acceptBtn) {
        acceptBtn.disabled = true;
        acceptBtn.textContent = 'Accepting...';
    }
    
    try {
        const body = {
            response: 'accept'
        };
        
        if (employeeState.selectedSwapShift) {
            body.swap_shift = {
                day: employeeState.selectedSwapShift.dayIdx,
                start_hour: employeeState.selectedSwapShift.start,
                end_hour: employeeState.selectedSwapShift.end,
                role_id: employeeState.selectedSwapShift.role
            };
        }
        
        const response = await fetch(
            `/api/employee/${employeeState.businessSlug}/${employeeState.employee.id}/swap-request/${request.id}/respond`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }
        );
        
        const data = await response.json();
        
        if (data.success) {
            showToast('Swap accepted! The schedule has been updated.', 'success');
            hideSwapResponseModal();
            loadSwapRequests();
            loadScheduleData(); // Reload schedule to show updated shifts
        } else {
            showToast(data.message || 'Failed to accept swap', 'error');
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
        const response = await fetch(
            `/api/employee/${employeeState.businessSlug}/${employeeState.employee.id}/swap-request/${request.id}/respond`,
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
        const response = await fetch(
            `/api/employee/${employeeState.businessSlug}/${employeeState.employee.id}/swap-request/${requestId}/cancel`,
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
