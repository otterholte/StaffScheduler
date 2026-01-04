/**
 * Staff Scheduler Pro - Main Application
 * Professional UI/UX with full CRUD operations
 */

// ==================== URL ROUTING HELPERS ====================
const PAGE_SLUGS = INITIAL_DATA.pageSlugs || {
    'schedule': 'schedule',
    'staff': 'employees', 
    'availability': 'settings',
    'requirements': 'help'
};

const TAB_TO_SLUG = INITIAL_DATA.tabToSlug || {
    'schedule': 'schedule',
    'employees': 'staff',
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
    // Get from state or URL
    const businessData = state.businesses.find(b => b.id === state.business.id);
    return businessData?.slug || state.business.slug || slugify(state.business.name);
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
    peakPeriods: INITIAL_DATA.business.peak_periods || [],
    roleCoverageConfigs: INITIAL_DATA.business.role_coverage_configs || [],
    // Coverage mode state
    coverageMode: INITIAL_DATA.business.coverage_mode || 'shifts',
    shiftTemplates: INITIAL_DATA.business.shift_templates || [],
    hasCompletedSetup: INITIAL_DATA.business.has_completed_setup !== false,
    editingShift: null,
    // Schedule view state
    scheduleViewMode: 'timeline', // 'grid', 'timeline', or 'table'
    scheduleColorMode: 'role', // 'role' or 'employee'
    // Week navigation state
    weekOffset: 0, // 0 = current week, -1 = last week, 1 = next week, etc.
    // Publish state tracking per week (keyed by week start date string)
    publishedWeeks: {}, // { 'YYYY-MM-DD': { published: true/false, editCount: 0 } }
    currentWeekHasSchedule: false,
    currentWeekEditCount: 0
};

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
function navigateWeek(direction) {
    state.weekOffset += direction;
    
    // Update the week navigation bar
    updateWeekNavigationBar();
    
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
    
    // Update week type label with status suffix
    if (dom.weekTypeLabel) {
        const baseLabel = getWeekTypeLabel(state.weekOffset);
        if (weekState.hasSchedule) {
            const statusSuffix = weekState.published ? ' · PUBLISHED' : ' · DRAFT';
            dom.weekTypeLabel.textContent = baseLabel + statusSuffix;
        } else {
            dom.weekTypeLabel.textContent = baseLabel;
        }
    }
    
    // Update date range
    if (dom.weekDateRange) {
        dom.weekDateRange.textContent = getWeekRangeString(state.weekOffset);
    }
    
    // Update publish status line and bar color
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
 * Update the publish status display (status line and bar color)
 */
function updatePublishStatusDisplay(weekState) {
    const bar = dom.weekNavigationBar;
    const statusEl = dom.weekPublishStatus;
    
    if (!bar || !statusEl) return;
    
    let status, icon, text;
    
    if (!weekState.hasSchedule) {
        status = 'none';
        icon = '○';
        text = 'No schedule generated';
    } else if (weekState.published) {
        status = 'published';
        icon = '✓';
        text = 'Published';
    } else {
        status = 'draft';
        icon = '⚠';
        const editCount = weekState.editCount || 0;
        if (editCount > 0) {
            text = `${editCount} edit${editCount !== 1 ? 's' : ''} need to be published`;
        } else {
            text = 'Unpublished changes';
        }
    }
    
    bar.setAttribute('data-publish-status', status);
    statusEl.innerHTML = `
        <span class="status-icon">${icon}</span>
        <span class="status-text">${text}</span>
    `;
    
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
    weekTypeLabel: document.getElementById('weekTypeLabel'),
    weekDateRange: document.getElementById('weekDateRange'),
    weekNavigationBar: document.getElementById('weekNavigationBar'),
    weekPublishStatus: document.getElementById('weekPublishStatus'),
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
    saveSettingsBtn: document.getElementById('saveSettingsBtn'),
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
    setupKeyboardShortcuts();
    setupAdvancedTab();
    initTimelineAddShiftModal();
    initAvailabilityFilters();
    
    // Initial render
    renderEmployeesGrid();
    renderRolesList();
    renderCoverageUI();
    
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
function showLoading(message = 'Loading...') {
    dom.loadingOverlay.querySelector('.loading-text').textContent = message;
    dom.loadingOverlay.classList.add('active');
}

function hideLoading() {
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
    
    // Availability save
    document.getElementById('saveAvailabilityBtn').addEventListener('click', saveAvailability);
    
    // Availability helpers
    document.getElementById('clearAvailability').addEventListener('click', () => fillAvailability('clear'));
    document.getElementById('fillWeekdays').addEventListener('click', () => fillAvailability('weekdays'));
    document.getElementById('fillAll').addEventListener('click', () => fillAvailability('all'));
    
    // Slot save
    document.getElementById('saveSlotBtn').addEventListener('click', saveSlotAssignment);
    
    // Shift edit (save and delete)
    const saveShiftEditBtn = document.getElementById('saveShiftEditBtn');
    const deleteShiftBtn = document.getElementById('deleteShiftBtn');
    if (saveShiftEditBtn) {
        saveShiftEditBtn.addEventListener('click', saveShiftEdit);
    }
    if (deleteShiftBtn) {
        deleteShiftBtn.addEventListener('click', deleteShift);
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
            
            // Update slug in state if this is the current business
            if (result.slug && idInput.value === state.business.id) {
                state.business.slug = result.slug;
                // Update URL to reflect new slug
                updateUrl(false);
                // Navigate to new URL to keep it in sync
                const newPath = getCurrentUrlPath();
                history.replaceState({ tab: state.currentTab, businessId: state.business.id }, '', newPath);
            }
            
            // Refresh business list
            await refreshBusinessList();
            
            // If this was a new business, switch to it
            if (!idInput.value && result.business_id) {
                await switchBusiness(result.business_id);
            }
        } else {
            showToast(result.error || 'Failed to save location', 'error');
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
            
            // Refresh business list and switch to first business if needed
            await refreshBusinessList();
        } else {
            showToast(result.error || 'Failed to delete location', 'error');
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
            renderEmployeesGrid();
            renderRolesList();
            renderCoverageUI();
            
            state.currentSchedule = null;
            updateScheduleStatus('Ready to generate', '');
            dom.alternativeBtn.disabled = true;
            dom.exportBtn.disabled = true;
            
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

function renderEmployeeHoursList() {
    if (!dom.employeeHoursList) return;
    dom.employeeHoursList.innerHTML = '';
    
    state.employees.forEach(emp => {
        const row = document.createElement('div');
        row.className = 'emp-hours-row';
        row.dataset.id = emp.id;
        
        let badges = getBadgesHTML(emp);
        
        row.innerHTML = `
            <div class="emp-hours-info">
                <span class="emp-color-dot" style="background: ${emp.color}" data-tooltip="${emp.name}"></span>
                <span class="emp-name" data-tooltip="${emp.name}">${emp.name}</span>
                <div class="emp-badges">${badges}</div>
            </div>
            <div class="emp-hours-stats">
                <span class="emp-hours" data-tooltip="Hours scheduled this week">—h</span>
                <span class="emp-range" data-tooltip="Required hours range (min-max)">(${emp.min_hours}-${emp.max_hours})</span>
                <span class="emp-status" data-tooltip="Schedule status">—</span>
            </div>
        `;
        
        dom.employeeHoursList.appendChild(row);
    });
}

// Helper function to generate badge HTML with tooltips
// fullText = true uses longer labels for desktop, false uses abbreviations
function getBadgesHTML(emp, fullText = false) {
    let badges = '';
    if (emp.classification === 'full_time') {
        badges += `<span class="badge badge-ft" data-tooltip="Full-Time Employee">${fullText ? 'Full-time' : 'FT'}</span>`;
    } else {
        badges += `<span class="badge badge-pt" data-tooltip="Part-Time Employee">${fullText ? 'Part-time' : 'PT'}</span>`;
    }
    if (emp.needs_supervision) {
        badges += `<span class="badge badge-new" data-tooltip="New Employee - Needs Supervision">${fullText ? 'New' : 'NEW'}</span>`;
    }
    if (emp.can_supervise) {
        badges += `<span class="badge badge-sup" data-tooltip="Supervisor - Can train others">${fullText ? 'Supervisor' : 'SUP'}</span>`;
    }
    if (emp.overtime_allowed) {
        badges += `<span class="badge badge-ot" data-tooltip="Overtime Allowed">${fullText ? 'Overtime' : 'OT'}</span>`;
    }
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

async function generateSchedule() {
    dom.generateBtn.disabled = true;
    dom.alternativeBtn.disabled = true;
    showLoading('Generating optimal schedule...');
    updateScheduleStatus('Generating...', 'loading');
    
    // Get all current policies from settings
    const policies = getAllPolicies();
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minute timeout
        
        const response = await fetch('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ policies }),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        const data = await response.json();
        
        if (data.success) {
            state.currentSchedule = data.schedule;
            if (data.employees) {
                state.employees = data.employees;
                buildLookups();
            }
            
            // Mark week as having a generated schedule (draft state)
            markWeekAsGenerated(state.weekOffset, 1);
            
            // Render based on current view mode
            if (state.scheduleViewMode === 'table') {
                renderSimpleTableView(data.schedule);
            } else if (state.scheduleViewMode === 'timeline') {
                renderTimelineView(data.schedule);
            } else {
                renderSchedule(data.schedule);
            }
            updateMetrics(data.schedule);
            updateEmployeeHours(data.schedule);
            
            const coverage = data.schedule.coverage_percentage;
            if (coverage >= 100) {
                updateScheduleStatus(`100% Coverage - Solution #${data.schedule.solution_index}`, 'success');
            } else {
                updateScheduleStatus(`${coverage}% Coverage - ${data.schedule.metrics.total_hours_still_needed}h needed`, 'warning');
            }
            
            dom.alternativeBtn.disabled = false;
            dom.exportBtn.disabled = false;
            showToast(data.message, 'success');
        } else {
            updateScheduleStatus('No feasible schedule found', 'error');
            showToast(data.message || 'Failed to generate schedule', 'error');
            clearScheduleGrid();
        }
    } catch (error) {
        updateScheduleStatus('Error generating schedule', 'error');
        showToast('Error generating schedule', 'error');
    } finally {
        dom.generateBtn.disabled = false;
        hideLoading();
    }
}

async function findAlternative() {
    dom.generateBtn.disabled = true;
    dom.alternativeBtn.disabled = true;
    showLoading('Finding alternative schedule...');
    updateScheduleStatus('Searching...', 'loading');
    
    // Get all current policies from settings
    const policies = getAllPolicies();
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minute timeout
        
        const response = await fetch('/api/alternative', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ policies }),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        const data = await response.json();
        
        if (data.success) {
            state.currentSchedule = data.schedule;
            
            // Mark week as having a generated schedule (draft state)
            markWeekAsGenerated(state.weekOffset, 1);
            
            // Render based on current view mode
            if (state.scheduleViewMode === 'table') {
                renderSimpleTableView(data.schedule);
            } else if (state.scheduleViewMode === 'timeline') {
                renderTimelineView(data.schedule);
            } else {
                renderSchedule(data.schedule);
            }
            updateMetrics(data.schedule);
            updateEmployeeHours(data.schedule);
            
            const coverage = data.schedule.coverage_percentage;
            updateScheduleStatus(`${coverage}% Coverage - Solution #${data.schedule.solution_index}`, coverage >= 100 ? 'success' : 'warning');
            
            dom.alternativeBtn.disabled = false;
            showToast(data.message, 'success');
        } else {
            updateScheduleStatus('No more alternatives', 'warning');
            showToast(data.message || 'No more alternatives found', 'warning');
        }
    } catch (error) {
        updateScheduleStatus('Error finding alternative', 'error');
        showToast('Error finding alternative', 'error');
    } finally {
        dom.generateBtn.disabled = false;
        hideLoading();
    }
}

async function resetSchedule() {
    try {
        await fetch('/api/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        clearScheduleGrid();
        clearMetrics();
        state.currentSchedule = { slot_assignments: {} };
        dom.alternativeBtn.disabled = true;
        dom.exportBtn.disabled = true;
        
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

function publishSchedule() {
    if (!state.currentSchedule || !state.currentSchedule.slot_assignments) {
        showToast('No schedule to publish', 'warning');
        return;
    }
    
    // Get the week range for the confirmation message
    const weekRange = getWeekRangeString(state.weekOffset);
    
    // Mark the week as published
    markWeekAsPublished(state.weekOffset);
    
    // Show success toast with week info
    showToast(`Schedule published for ${weekRange}`, 'success');
    
    // Visual feedback - briefly highlight the publish button
    if (dom.publishBtn) {
        dom.publishBtn.classList.add('published');
        setTimeout(() => {
            dom.publishBtn.classList.remove('published');
        }, 1500);
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
        
        el.innerHTML = `<span class="gap-label">+${gap.needed}</span>`;
        el.title = `Need ${gap.needed} more ${role?.name || 'staff'}\nClick to see available employees`;
        
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
            totalHours: 0
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
    
    // Render gap row first if there are gaps (only when schedule exists)
    if (gaps.totalHours > 0) {
        const row = document.createElement('tr');
        row.className = 'gap-row';
        
        let html = `<td class="name-col"><div class="emp-name"><span>⚠ Still Needed</span></div></td>`;
        
        for (let day = 0; day < 7; day++) {
            const dayClass = day % 2 === 0 ? 'day-even' : 'day-odd';
            const shifts = gaps.days[day];
            if (shifts.length === 0) {
                html += `<td class="shift-times ${dayClass}"><span class="no-shift">—</span></td>`;
            } else {
                const shiftStrs = shifts.map(s => `<span class="shift-block">${formatHour(s.start)}-${formatHour(s.end)}</span>`).join('');
                html += `<td class="shift-times ${dayClass}">${shiftStrs}</td>`;
            }
        }
        
        html += `<td class="total-hours">${gaps.totalHours}h</td>`;
        row.innerHTML = html;
        tbody.appendChild(row);
    }
    
    // Render employee rows
    Object.values(employeeSchedules)
        .filter(es => es.totalHours > 0)
        .sort((a, b) => b.totalHours - a.totalHours) // Sort by hours descending
        .forEach(empSchedule => {
            const emp = empSchedule.employee;
            const row = document.createElement('tr');
            
            let html = `<td class="name-col"><div class="emp-name">
                <span class="emp-color" style="background: ${emp.color || '#666'}"></span>
                <span>${emp.name}</span>
            </div></td>`;
            
            for (let day = 0; day < 7; day++) {
                const dayClass = day % 2 === 0 ? 'day-even' : 'day-odd';
                const shifts = empSchedule.days[day];
                if (shifts.length === 0) {
                    html += `<td class="shift-times ${dayClass}"><span class="no-shift">—</span></td>`;
                } else {
                    const shiftStrs = shifts.map(s => `<span class="shift-block">${formatHour(s.start)}-${formatHour(s.end)}</span>`).join('');
                    html += `<td class="shift-times ${dayClass}">${shiftStrs}</td>`;
                }
            }
            
            html += `<td class="total-hours">${empSchedule.totalHours}h</td>`;
            row.innerHTML = html;
            tbody.appendChild(row);
        });
    
    // If no employees have hours, show a message
    if (tbody.children.length === 0) {
        const row = document.createElement('tr');
        row.innerHTML = `<td colspan="9" style="text-align: center; color: var(--text-muted); padding: 2rem;">
            No schedule generated yet. Click "Generate Schedule" to create one.
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
function moveShift(empId, roleId, fromDayIdx, fromStart, fromEnd, toDayIdx, toStart) {
    if (!state.currentSchedule) return false;
    
    const slotAssignments = state.currentSchedule.slot_assignments;
    const duration = fromEnd - fromStart;
    
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
                role_id: roleId
            });
        }
    }
    
    // Re-render timeline
    renderTimelineView(state.currentSchedule);
    
    // Mark as having unpublished edits
    incrementWeekEditCount(state.weekOffset);
    
    const emp = employeeMap[empId];
    const dayName = state.days[toDayIdx];
    showToast(`${emp?.name}'s shift moved to ${dayName} ${formatHour(toStartHour)}-${formatHour(toEndHour)}`, 'success');
    
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
    
    // Re-render timeline
    renderTimelineView(state.currentSchedule);
    
    // Mark as having unpublished edits
    incrementWeekEditCount(state.weekOffset);
    
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
    
    // Re-render timeline
    renderTimelineView(state.currentSchedule);
    
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
    const slotsContainer = block.closest('.timeline-slots');
    
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

function renderTimelineView(schedule) {
    const container = document.getElementById('timelineGrid');
    if (!container) return;
    
    container.innerHTML = '';
    
    // Make sure state is initialized
    if (!state.hours || state.hours.length === 0 || !state.daysOpen || state.daysOpen.length === 0) {
        container.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 2rem;">
            Loading schedule data...
        </div>`;
        return;
    }
    
    const slotAssignments = schedule?.slot_assignments || {};
    
    // Calculate weekly stats for each employee (hours worked, days worked)
    const employeeWeeklyStats = {}; // { empId: { hoursWorked: number, daysWorked: Set } }
    
    for (let day = 0; day < 7; day++) {
        state.hours.forEach(hour => {
            const key = `${day},${hour}`;
            const assignments = slotAssignments[key] || [];
            assignments.forEach(assignment => {
                const empId = assignment.employee_id;
                if (!employeeWeeklyStats[empId]) {
                    employeeWeeklyStats[empId] = { hoursWorked: 0, daysWorked: new Set() };
                }
                employeeWeeklyStats[empId].hoursWorked += 1; // Each slot is 1 hour
                employeeWeeklyStats[empId].daysWorked.add(day);
            });
        });
    }
    
    // Get week dates based on current offset
    const weekDates = getWeekDates(state.weekOffset);
    
    // Build header row with hours
    const headerDiv = document.createElement('div');
    headerDiv.className = 'timeline-header';
    
    // Day column header (simple label, week nav is now in the bar above)
    const dayLabelHeader = document.createElement('div');
    dayLabelHeader.className = 'timeline-header-day';
    dayLabelHeader.textContent = 'Day';
    headerDiv.appendChild(dayLabelHeader);
    
    const hoursHeader = document.createElement('div');
    hoursHeader.className = 'timeline-header-hours';
    
    state.hours.forEach(hour => {
        const hourLabel = document.createElement('div');
        hourLabel.className = 'timeline-hour-label';
        hourLabel.textContent = formatHour(hour);
        hoursHeader.appendChild(hourLabel);
    });
    
    // Add the closing hour label (e.g., 6pm for a 6am-6pm business)
    const closingLabel = document.createElement('div');
    closingLabel.className = 'timeline-hour-label timeline-closing-hour';
    closingLabel.textContent = formatHour(state.endHour);
    hoursHeader.appendChild(closingLabel);
    
    headerDiv.appendChild(hoursHeader);
    container.appendChild(headerDiv);
    
    // Build a row for each day
    state.daysOpen.forEach(dayIdx => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'timeline-row ' + (dayIdx % 2 === 0 ? 'day-even' : 'day-odd');
        rowDiv.dataset.dayIdx = dayIdx;
        
        // Day label with date
        const dayLabel = document.createElement('div');
        dayLabel.className = 'timeline-day-label';
        const dayDate = weekDates[dayIdx];
        dayLabel.innerHTML = `
            <span class="day-name">${state.days[dayIdx].substring(0, 3)}</span>
            <span class="day-date">${formatShortDate(dayDate)}</span>
        `;
        rowDiv.appendChild(dayLabel);
        
        // Slots container
        const slotsDiv = document.createElement('div');
        slotsDiv.className = 'timeline-slots';
        slotsDiv.dataset.dayIdx = dayIdx;
        
        // Create drop zone row (hidden by default, shown during drag)
        const dropZone = document.createElement('div');
        dropZone.className = 'timeline-drop-zone timeline-slots-row';
        dropZone.dataset.dayIdx = dayIdx;
        
        // Add hour markers to drop zone for visual guidance
        state.hours.forEach((hour, idx) => {
            const marker = document.createElement('div');
            marker.className = 'drop-zone-hour-marker';
            marker.style.left = `${(idx / state.hours.length) * 100}%`;
            marker.style.width = `${100 / state.hours.length}%`;
            marker.dataset.hour = hour;
            dropZone.appendChild(marker);
        });
        
        // Drop zone event handlers
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            
            if (!timelineDragState.activeShift) return;
            
            dropZone.classList.add('drag-over');
            
            // Calculate target hour from mouse position (this is where center of shift should go)
            const mouseHour = getTimelineHourFromPosition(e.clientX, dropZone);
            const shift = timelineDragState.activeShift;
            const duration = shift.endHour - shift.startHour;
            
            // Center the shift on mouse position
            const centeredStartHour = Math.round(mouseHour - duration / 2);
            // Clamp to valid range
            const clampedStartHour = Math.max(state.startHour, Math.min(centeredStartHour, state.endHour - duration));
            
            timelineDragState.currentTargetDay = dayIdx;
            timelineDragState.currentTargetHour = clampedStartHour;
            
            // Update ghost preview
            const existingGhost = dropZone.querySelector('.timeline-ghost-preview');
            if (existingGhost) existingGhost.remove();
            
            const ghost = createGhostPreview(shift, clampedStartHour, dropZone);
            if (ghost) {
                dropZone.appendChild(ghost);
            }
        });
        
        dropZone.addEventListener('dragleave', (e) => {
            // Only remove if leaving the drop zone entirely
            if (!dropZone.contains(e.relatedTarget)) {
                dropZone.classList.remove('drag-over');
                const ghost = dropZone.querySelector('.timeline-ghost-preview');
                if (ghost) ghost.remove();
            }
        });
        
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('drag-over');
            
            if (!timelineDragState.activeShift) return;
            
            const shift = timelineDragState.activeShift;
            const mouseHour = getTimelineHourFromPosition(e.clientX, dropZone);
            const duration = shift.endHour - shift.startHour;
            
            // Center the shift on mouse position
            const centeredStartHour = Math.round(mouseHour - duration / 2);
            // Clamp to valid range
            const targetStartHour = Math.max(state.startHour, Math.min(centeredStartHour, state.endHour - duration));
            const targetDayIdx = dayIdx;
            
            // Move the shift
            moveShift(
                shift.empId,
                shift.roleId,
                timelineDragState.originalDayIdx,
                timelineDragState.originalStartHour,
                timelineDragState.originalEndHour,
                targetDayIdx,
                targetStartHour
            );
            
            // Reset drag state
            timelineDragState.isDragging = false;
            timelineDragState.activeShift = null;
            hideTimelineDropZones();
        });
        
        slotsDiv.appendChild(dropZone);
        
        // Build shift blocks for this day
        const dayAssignments = {};
        
        // Gather all assignments for this day (use integer hours for compatibility)
        state.hours.forEach(hour => {
            const key = `${dayIdx},${hour}`;
            const assignments = slotAssignments[key] || [];
            assignments.forEach(assignment => {
                const empId = assignment.employee_id;
                if (!dayAssignments[empId]) {
                    dayAssignments[empId] = { hours: [], roleId: assignment.role_id };
                }
                dayAssignments[empId].hours.push(hour);
            });
        });
        
        // Convert to shift segments (each employee can have multiple segments if split shift)
        const allShifts = [];
        Object.entries(dayAssignments).forEach(([empId, data]) => {
            const emp = employeeMap[empId];
            if (!emp) return;
            
            const hours = data.hours.sort((a, b) => a - b);
            
            // Find continuous segments (consecutive hours)
            let segStart = hours[0];
            let prevHour = hours[0];
            
            for (let i = 1; i <= hours.length; i++) {
                const currentHour = hours[i];
                
                // Check if continuous (consecutive hours)
                const isGap = currentHour === undefined || currentHour !== prevHour + 1;
                
                if (isGap || i === hours.length) {
                    allShifts.push({
                        empId,
                        emp,
                        roleId: data.roleId,
                        startHour: segStart,
                        endHour: prevHour + 1
                    });
                    
                    if (i < hours.length) {
                        segStart = currentHour;
                    }
                }
                prevHour = currentHour;
            }
        });
        
        // Assign shifts to rows (greedy algorithm - place each shift in first row where it fits)
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
        
        // Add gap indicators (only if a schedule has been generated with actual data)
        const gapShifts = [];
        const hasSchedule = Object.keys(slotAssignments).length > 0 && 
            Object.values(slotAssignments).some(arr => arr && arr.length > 0);
        
        if (hasSchedule) {
            // Use unfilled_slots from schedule metrics if available
            const unfilledSlots = schedule?.metrics?.unfilled_slots || [];
            // Use parseInt to handle potential type mismatches from JSON
            const dayUnfilled = unfilledSlots.filter(s => parseInt(s.day) === parseInt(dayIdx));
            
            if (dayUnfilled.length > 0) {
                // Group by hour (ensure integers) and track role/needed info
                const hourData = {};
                dayUnfilled.forEach(slot => {
                    const hour = parseInt(slot.hour);
                    if (!hourData[hour]) {
                        hourData[hour] = { needed: 0, roleId: slot.role_id };
                    }
                    hourData[hour].needed += slot.needed || 1;
                    hourData[hour].roleId = slot.role_id;
                });
                
                const gapHours = Object.keys(hourData).map(h => parseInt(h)).sort((a, b) => a - b);
                
                // Convert to segments
                if (gapHours.length > 0) {
                    let segStart = gapHours[0];
                    let prevHour = gapHours[0];
                    let maxNeeded = hourData[gapHours[0]].needed;
                    let roleId = hourData[gapHours[0]].roleId;
                    
                    for (let i = 1; i <= gapHours.length; i++) {
                        const currentHour = gapHours[i];
                        
                        if (currentHour !== prevHour + 1 || i === gapHours.length) {
                            gapShifts.push({
                                isGap: true,
                                day: dayIdx,
                                dayIdx: state.daysOpen.indexOf(dayIdx),
                                roleId: roleId,
                                startHour: segStart,
                                endHour: prevHour + 1,
                                needed: maxNeeded
                            });
                            
                            if (i < gapHours.length) {
                                segStart = currentHour;
                                maxNeeded = hourData[currentHour].needed;
                                roleId = hourData[currentHour].roleId;
                            }
                        } else {
                            maxNeeded = Math.max(maxNeeded, hourData[currentHour].needed);
                        }
                        prevHour = currentHour;
                    }
                }
            } else {
                // Fallback to shift templates
                const shiftTemplates = state.shiftTemplates || [];
                const hourData = {}; // { hour: { needed, roleId } }
                
                state.hours.forEach(hour => {
                    const key = `${dayIdx},${hour}`;
                    const assignments = slotAssignments[key] || [];
                    
                    const assignedByRole = {};
                    assignments.forEach(a => {
                        assignedByRole[a.role_id] = (assignedByRole[a.role_id] || 0) + 1;
                    });
                    
                    let totalGap = 0;
                    let gapRoleId = null;
                    shiftTemplates.forEach(shift => {
                        if (!shift.days || !shift.days.includes(dayIdx)) return;
                        if (hour < shift.start_hour || hour >= shift.end_hour) return;
                        
                        (shift.roles || []).forEach(roleReq => {
                            const needed = roleReq.count || 0;
                            const assigned = assignedByRole[roleReq.role_id] || 0;
                            if (needed > assigned) {
                                totalGap += (needed - assigned);
                                gapRoleId = roleReq.role_id;
                            }
                        });
                    });
                    
                    if (totalGap > 0) {
                        hourData[hour] = { needed: totalGap, roleId: gapRoleId };
                    }
                });
                
                // Convert to segments
                const gapHours = Object.keys(hourData).map(h => parseInt(h)).sort((a, b) => a - b);
                
                if (gapHours.length > 0) {
                    let segStart = gapHours[0];
                    let prevHour = gapHours[0];
                    let maxNeeded = hourData[gapHours[0]].needed;
                    let roleId = hourData[gapHours[0]].roleId;
                    
                    for (let i = 1; i <= gapHours.length; i++) {
                        const currentHour = gapHours[i];
                        
                        if (currentHour !== prevHour + 1 || i === gapHours.length) {
                            gapShifts.push({
                                isGap: true,
                                day: dayIdx,
                                dayIdx: state.daysOpen.indexOf(dayIdx),
                                roleId: roleId,
                                startHour: segStart,
                                endHour: prevHour + 1,
                                needed: maxNeeded
                            });
                            
                            if (i < gapHours.length) {
                                segStart = currentHour;
                                maxNeeded = hourData[currentHour].needed;
                                roleId = hourData[currentHour].roleId;
                            }
                        } else {
                            maxNeeded = Math.max(maxNeeded, hourData[currentHour].needed);
                        }
                        prevHour = currentHour;
                    }
                }
            }
        }
        
        // Create row containers and render shifts using percentage positioning
        const totalHours = state.hours.length;
        const blockPadding = 2; // Small padding in pixels for visual spacing (applied via CSS)
        
        // Add gap row FIRST (at the top) if there are gaps
        if (gapShifts.length > 0) {
            const gapRowContainer = document.createElement('div');
            gapRowContainer.className = 'timeline-slots-row timeline-gap-row';
            
            gapShifts.forEach(gap => {
                const startIdx = state.hours.indexOf(gap.startHour);
                const duration = gap.endHour - gap.startHour;
                
                const gapBlock = document.createElement('div');
                gapBlock.className = 'timeline-gap-block';
                
                // Calculate percentage positions - align exactly with hour columns
                const leftPercent = (startIdx / totalHours) * 100;
                const widthPercent = (duration / totalHours) * 100;
                gapBlock.style.left = `${leftPercent}%`;
                gapBlock.style.width = `${widthPercent}%`;
                gapBlock.innerHTML = `<span class="gap-label">+${duration}h</span>`;
                gapBlock.title = `Click to see available employees`;
                
                // Add click handler to show available employees
                gapBlock.addEventListener('click', () => {
                    openGapModal(gap);
                });
                
                gapRowContainer.appendChild(gapBlock);
            });
            
            slotsDiv.appendChild(gapRowContainer);
        }
        
        // Add employee shift rows
        const numShiftRows = shiftRows.length;
        
        for (let rowIdx = 0; rowIdx < numShiftRows; rowIdx++) {
            const rowContainer = document.createElement('div');
            rowContainer.className = 'timeline-slots-row';
            rowContainer.dataset.dayIdx = dayIdx;
            
            // Add click handler to create shift in blank space
            rowContainer.addEventListener('click', (e) => handleTimelineRowClick(e, dayIdx, slotsDiv));
            rowContainer.addEventListener('mousedown', (e) => handleTimelineRowMouseDown(e, dayIdx, slotsDiv));
            
            // Add shifts for this row
            const rowShifts = shiftRows[rowIdx] || [];
            rowShifts.forEach(shift => {
                // Check for precise times in shift_times
                const shiftKey = `${shift.empId}_${dayIdx}`;
                const preciseTimes = schedule?.shift_times?.[shiftKey];
                
                // Use precise times if available, otherwise use hourly slot times
                const displayStart = preciseTimes ? preciseTimes.start : shift.startHour;
                const displayEnd = preciseTimes ? preciseTimes.end : shift.endHour;
                const duration = displayEnd - displayStart;
                
                const block = document.createElement('div');
                block.className = 'timeline-shift-block';
                block.draggable = true;
                
                // Add data attributes for drag/drop identification
                block.dataset.empId = shift.empId;
                block.dataset.roleId = shift.roleId;
                block.dataset.dayIdx = dayIdx;
                block.dataset.startHour = displayStart;
                block.dataset.endHour = displayEnd;
                
                // Calculate percentage positions using precise times
                const leftPercent = ((displayStart - state.startHour) / totalHours) * 100;
                const widthPercent = (duration / totalHours) * 100;
                block.style.left = `${leftPercent}%`;
                block.style.width = `${widthPercent}%`;
                
                // Color based on mode
                const role = roleMap[shift.roleId];
                const blockColor = state.scheduleColorMode === 'employee' 
                    ? (shift.emp.color || '#666') 
                    : (role?.color || '#666');
                block.style.background = blockColor;
                
                // Better tooltip with name, hours, and role
                const roleName = role?.name || 'Staff';
                
                // Get employee weekly stats
                const empStats = employeeWeeklyStats[shift.empId] || { hoursWorked: 0, daysWorked: new Set() };
                const hoursWorked = empStats.hoursWorked;
                const daysWorked = empStats.daysWorked.size;
                const minHours = shift.emp.min_hours || 0;
                const maxHours = shift.emp.max_hours || shift.emp.maxHours || 40;
                const empType = shift.emp.classification === 'full_time' ? 'Full-Time' : 'Part-Time';
                
                // Create inner content with resize handles
                block.innerHTML = `
                    <div class="shift-resize-handle left" data-edge="left"></div>
                    <span class="shift-name">${shift.emp.name}</span>
                    <div class="shift-resize-handle right" data-edge="right"></div>
                `;
                const timeDisplay = preciseTimes 
                    ? `${formatHourMinute(displayStart)} - ${formatHourMinute(displayEnd)}`
                    : `${formatHour(shift.startHour)} - ${formatHour(shift.endHour)}`;
                block.title = `${shift.emp.name} (${empType})\nRole: ${roleName}\n${timeDisplay}\n\nWeekly: ${hoursWorked}h / ${minHours}-${maxHours}h range\nDays this week: ${daysWorked}\n\nDrag to move · Drag edges to resize`;
                
                // Add day info to shift for the editor
                shift.day = state.days[dayIdx];
                shift.dayIdx = dayIdx;
                
                // Store shift reference for drag operations (use precise times)
                block._shiftData = { 
                    ...shift,
                    startHour: displayStart,
                    endHour: displayEnd
                };
                
                // Click handler to edit shift (only if not dragging/resizing)
                block.addEventListener('click', (e) => {
                    // Don't open editor if clicking on resize handles or during drag
                    if (e.target.classList.contains('shift-resize-handle') || timelineDragState.isDragging || timelineDragState.isResizing) {
                        return;
                    }
                    openShiftEditor(shift);
                });
                
                // Drag start handler
                block.addEventListener('dragstart', (e) => {
                    // Don't allow drag if starting from resize handle
                    if (e.target.classList.contains('shift-resize-handle')) {
                        e.preventDefault();
                        return;
                    }
                    
                    timelineDragState.isDragging = true;
                    timelineDragState.activeShift = block._shiftData;
                    timelineDragState.originalDayIdx = dayIdx;
                    timelineDragState.originalStartHour = shift.startHour;
                    timelineDragState.originalEndHour = shift.endHour;
                    
                    block.classList.add('dragging');
                    
                    // Set drag data
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', JSON.stringify(block._shiftData));
                    
                    // Show drop zones
                    setTimeout(() => showTimelineDropZones(), 0);
                });
                
                block.addEventListener('dragend', (e) => {
                    block.classList.remove('dragging');
                    timelineDragState.isDragging = false;
                    timelineDragState.activeShift = null;
                    hideTimelineDropZones();
                });
                
                // Resize handle events
                const leftHandle = block.querySelector('.shift-resize-handle.left');
                const rightHandle = block.querySelector('.shift-resize-handle.right');
                
                if (leftHandle) {
                    leftHandle.addEventListener('mousedown', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        startResize(e, block, 'left', dayIdx, shift);
                    });
                }
                
                if (rightHandle) {
                    rightHandle.addEventListener('mousedown', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        startResize(e, block, 'right', dayIdx, shift);
                    });
                }
                
                rowContainer.appendChild(block);
            });
            
            slotsDiv.appendChild(rowContainer);
        }
        
        // If no shifts and no gaps, add an empty row
        if (numShiftRows === 0 && gapShifts.length === 0) {
            const emptyRow = document.createElement('div');
            emptyRow.className = 'timeline-slots-row timeline-empty-row';
            emptyRow.dataset.dayIdx = dayIdx;
            emptyRow.style.minHeight = '40px';
            emptyRow.title = 'Click or drag to add a shift';
            
            // Add click handler to create shift
            emptyRow.addEventListener('click', (e) => handleTimelineRowClick(e, dayIdx, slotsDiv));
            emptyRow.addEventListener('mousedown', (e) => handleTimelineRowMouseDown(e, dayIdx, slotsDiv));
            
            slotsDiv.appendChild(emptyRow);
        }
        
        rowDiv.appendChild(slotsDiv);
        container.appendChild(rowDiv);
    });
    
    renderScheduleLegend();
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
}

function clearMetrics() {
    dom.coveragePercent.textContent = '—%';
    dom.slotsFilled.textContent = '—/—';
    dom.hoursStillNeeded.textContent = '—';
    dom.laborCost.textContent = '$—';
    dom.solveTime.textContent = '—s';
    dom.overtimeHours.textContent = '—';
    if (dom.gapsCard) dom.gapsCard.style.display = 'none';
    
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
    
    // Close modal and refresh
    const modal = document.getElementById('timelineAddShiftModal');
    modal.classList.remove('active');
    
    // Re-render timeline
    renderTimelineView(state.currentSchedule);
    
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
    
    // Re-render the schedule
    renderSchedule(state.currentSchedule);
    closeAllModals();
}

function deleteShift() {
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
    
    // Update unfilled slots (add the deleted shift as gaps)
    if (!state.currentSchedule.metrics) {
        state.currentSchedule.metrics = { unfilled_slots: [] };
    }
    if (!state.currentSchedule.metrics.unfilled_slots) {
        state.currentSchedule.metrics.unfilled_slots = [];
    }
    
    // Add each hour as an unfilled slot
    hoursToDelete.forEach(hour => {
        state.currentSchedule.metrics.unfilled_slots.push({
            day: shiftData.dayIdx,
            hour: hour,
            role_id: shiftData.roleId,
            needed: 1
        });
    });
    
    showToast('Shift deleted', 'success');
    
    // Re-render the schedule based on current view mode
    if (state.scheduleViewMode === 'timeline') {
        renderTimelineView(state.currentSchedule);
    } else if (state.scheduleViewMode === 'table') {
        renderSimpleTableView(state.currentSchedule);
    } else {
        renderSchedule(state.currentSchedule);
    }
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
    dom.addEmployeeBtn.addEventListener('click', () => openEmployeeForm());
    dom.employeeSearch.addEventListener('input', renderEmployeesGrid);
    
    // Filter dropdown toggle
    dom.employeeFilterBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dom.employeeFilterMenu.classList.toggle('open');
        // Populate role filter options when menu opens
        populateRoleFilterOptions();
    });
    
    // Filter option selection (for static options)
    dom.employeeFilterMenu.querySelectorAll('.filter-option').forEach(option => {
        option.addEventListener('click', (e) => {
            e.stopPropagation();
            selectFilterOption(option);
        });
    });
    
    // Close menu when clicking outside
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
    renderEmployeesGrid();
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
        
        // Full text badges for desktop, abbreviated for mobile (CSS handles visibility)
        let badgesFull = getBadgesHTML(emp, true);
        let badgesShort = getBadgesHTML(emp, false);
        
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
            openAvailabilityEditor(emp.id);
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
    
    openModal('employeeModal');
}

async function handleEmployeeSubmit(e) {
    e.preventDefault();
    
    const empId = document.getElementById('empId').value;
    const isNew = !empId;
    
    const roles = [];
    document.getElementById('empRoles').querySelectorAll('input:checked').forEach(cb => {
        roles.push(cb.value);
    });
    
    const employeeData = {
        name: document.getElementById('empName').value,
        color: document.getElementById('empColor').value,
        classification: document.getElementById('empClassification').value,
        hourly_rate: parseFloat(document.getElementById('empHourlyRate').value),
        min_hours: parseInt(document.getElementById('empMinHours').value),
        max_hours: parseInt(document.getElementById('empMaxHours').value),
        roles: roles,
        can_supervise: document.getElementById('empCanSupervise').checked,
        needs_supervision: document.getElementById('empNeedsSupervision').checked,
        overtime_allowed: document.getElementById('empOvertimeAllowed').checked
    };
    
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
            renderEmployeesGrid();
            renderEmployeeHoursList();
            closeAllModals();
            showToast(isNew ? 'Employee added' : 'Employee updated', 'success');
        } else {
            showToast(data.message || 'Failed to save employee', 'error');
        }
    } catch (error) {
        showToast('Error saving employee', 'error');
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
            renderEmployeesGrid();
            renderEmployeeHoursList();
            showToast('Employee removed', 'success');
        } else {
            showToast(data.message || 'Failed to delete employee', 'error');
        }
    } catch (error) {
        showToast('Error deleting employee', 'error');
    }
}

// ==================== AVAILABILITY EDITOR ====================
function openAvailabilityEditor(empId) {
    const emp = employeeMap[empId];
    if (!emp) return;
    
    state.editingAvailability = empId;
    document.getElementById('availEmpName').textContent = emp.name;
    
    // Build grid
    const tbody = document.getElementById('availabilityBody');
    tbody.innerHTML = '';
    
    for (let h = state.startHour; h < state.endHour; h++) {
        const tr = document.createElement('tr');
        
        const timeCell = document.createElement('td');
        timeCell.textContent = `${h.toString().padStart(2, '0')}:00`;
        tr.appendChild(timeCell);
        
        for (let d = 0; d < 7; d++) {
            const td = document.createElement('td');
            td.className = 'avail-cell';
            td.dataset.day = d;
            td.dataset.hour = h;
            
            // Check current state
            const isAvailable = emp.availability.some(s => s.day === d && s.hour === h);
            const isPreferred = emp.preferences.some(s => s.day === d && s.hour === h);
            const isTimeOff = emp.time_off.some(s => s.day === d && s.hour === h);
            
            if (isTimeOff) {
                td.classList.add('time-off');
            } else if (isPreferred) {
                td.classList.add('preferred');
            } else if (isAvailable) {
                td.classList.add('available');
            }
            
            // Click handlers
            td.addEventListener('click', (e) => toggleAvailability(e.target, 'click'));
            td.addEventListener('dblclick', (e) => toggleAvailability(e.target, 'dblclick'));
            td.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                toggleAvailability(e.target, 'rightclick');
            });
            
            tr.appendChild(td);
        }
        
        tbody.appendChild(tr);
    }
    
    openModal('availabilityModal');
}

function toggleAvailability(cell, action) {
    cell.classList.remove('available', 'preferred', 'time-off');
    
    if (action === 'click') {
        if (!cell.classList.contains('available')) {
            cell.classList.add('available');
        }
    } else if (action === 'dblclick') {
        cell.classList.add('preferred');
    } else if (action === 'rightclick') {
        cell.classList.add('time-off');
    }
}

function fillAvailability(mode) {
    const cells = document.querySelectorAll('#availabilityBody .avail-cell');
    
    cells.forEach(cell => {
        const day = parseInt(cell.dataset.day);
        cell.classList.remove('available', 'preferred', 'time-off');
        
        if (mode === 'clear') {
            // Leave empty
        } else if (mode === 'weekdays' && day < 5) {
            cell.classList.add('available');
        } else if (mode === 'all') {
            cell.classList.add('available');
        }
    });
}

async function saveAvailability() {
    const empId = state.editingAvailability;
    if (!empId) return;
    
    const availability = [];
    const preferences = [];
    const timeOff = [];
    
    document.querySelectorAll('#availabilityBody .avail-cell').forEach(cell => {
        const day = parseInt(cell.dataset.day);
        const hour = parseInt(cell.dataset.hour);
        
        if (cell.classList.contains('time-off')) {
            timeOff.push({ day, hour });
        } else if (cell.classList.contains('preferred')) {
            availability.push({ day, hour });
            preferences.push({ day, hour });
        } else if (cell.classList.contains('available')) {
            availability.push({ day, hour });
        }
    });
    
    try {
        const response = await fetch(`/api/employees/${empId}/availability`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ availability, preferences, time_off: timeOff })
        });
        
        const data = await response.json();
        
        if (data.success) {
            // Update local state
            const emp = employeeMap[empId];
            if (emp) {
                emp.availability = availability;
                emp.preferences = preferences;
                emp.time_off = timeOff;
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
        item.innerHTML = `
            <div class="avail-staff-avatar" style="background: ${emp.color || '#467df6'}">${initials}</div>
            <div class="avail-staff-info">
                <div class="avail-staff-name">
                    ${emp.name}
                    <span class="badge badge-${emp.classification === 'full_time' ? 'ft' : 'pt'}">${emp.classification === 'full_time' ? 'FT' : 'PT'}</span>
                </div>
                <div class="avail-staff-role">${roleNames}</div>
                <div class="avail-staff-hours">${availHours} hrs/week available</div>
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

function showAvailabilityPanel(empId) {
    const emp = employeeMap[empId];
    if (!emp) return;
    
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
    document.getElementById('availPanelHours').textContent = `${availHours} hours/week available`;
    
    // Render the grid
    renderAvailabilityGrid(emp);
    
    // Setup preset buttons
    setupAvailabilityPresets(emp);
}

function renderAvailabilityGrid(emp) {
    const tbody = document.getElementById('availabilityTableBody');
    tbody.innerHTML = '';
    
    // Days start from Sunday (0) to Saturday (6) for display
    const dayOrder = [0, 1, 2, 3, 4, 5, 6]; // Sun, Mon, Tue, Wed, Thu, Fri, Sat
    
    for (let h = state.startHour; h <= state.endHour; h++) {
        const tr = document.createElement('tr');
        
        // Time label
        const timeCell = document.createElement('td');
        const hour12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
        const ampm = h >= 12 ? 'PM' : 'AM';
        timeCell.textContent = `${hour12} ${ampm}`;
        tr.appendChild(timeCell);
        
        // Day cells - reorder for Sun-Sat display
        dayOrder.forEach(displayDay => {
            // Map display day to data day (our data uses Mon=0, so Sun=6)
            const dataDay = displayDay === 0 ? 6 : displayDay - 1;
            
            const td = document.createElement('td');
            td.className = 'avail-cell';
            td.dataset.day = dataDay;
            td.dataset.hour = h;
            
            // Check current state
            const isAvailable = emp.availability.some(s => s.day === dataDay && s.hour === h);
            const isPreferred = emp.preferences.some(s => s.day === dataDay && s.hour === h);
            const isTimeOff = emp.time_off.some(s => s.day === dataDay && s.hour === h);
            
            if (isTimeOff) {
                td.classList.add('time-off');
            } else if (isPreferred) {
                td.classList.add('preferred');
            } else if (isAvailable) {
                td.classList.add('available');
            }
            
            // Click handlers
            td.addEventListener('click', () => toggleAvailabilityCell(td, emp.id, 'click'));
            td.addEventListener('dblclick', () => toggleAvailabilityCell(td, emp.id, 'dblclick'));
            td.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                toggleAvailabilityCell(td, emp.id, 'rightclick');
            });
            
            tr.appendChild(td);
        });
        
        tbody.appendChild(tr);
    }
}

async function toggleAvailabilityCell(cell, empId, action) {
    const day = parseInt(cell.dataset.day);
    const hour = parseInt(cell.dataset.hour);
    const emp = employeeMap[empId];
    if (!emp) return;
    
    // Determine new state based on action
    const isAvailable = cell.classList.contains('available');
    const isPreferred = cell.classList.contains('preferred');
    const isTimeOff = cell.classList.contains('time-off');
    
    // Remove all classes first
    cell.classList.remove('available', 'preferred', 'time-off');
    
    let newState = 'none';
    
    if (action === 'click') {
        // Click: none -> available -> none
        if (!isAvailable && !isPreferred && !isTimeOff) {
            cell.classList.add('available');
            newState = 'available';
        }
    } else if (action === 'dblclick') {
        // Double-click: set to preferred
        cell.classList.add('preferred');
        newState = 'preferred';
    } else if (action === 'rightclick') {
        // Right-click: set to time-off
        if (!isTimeOff) {
            cell.classList.add('time-off');
            newState = 'time-off';
        }
    }
    
    // Save to server
    await saveAvailabilityCell(empId, day, hour, newState);
    
    // Update hours display
    const availHours = calculateAvailableHoursFromGrid();
    document.getElementById('availPanelHours').textContent = `${availHours} hours/week available`;
    
    // Update sidebar
    updateSidebarHours(empId, availHours);
}

function calculateAvailableHoursFromGrid() {
    const cells = document.querySelectorAll('#availabilityTableBody .avail-cell');
    let count = 0;
    cells.forEach(cell => {
        if (cell.classList.contains('available') || cell.classList.contains('preferred')) {
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

async function saveAvailabilityCell(empId, day, hour, state) {
    try {
        await fetch(`/api/employees/${empId}/availability-cell`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ day, hour, state })
        });
        
        // Update local state
        const emp = employeeMap[empId];
        if (emp) {
            // Remove from all arrays
            emp.availability = emp.availability.filter(s => !(s.day === day && s.hour === hour));
            emp.preferences = emp.preferences.filter(s => !(s.day === day && s.hour === hour));
            emp.time_off = emp.time_off.filter(s => !(s.day === day && s.hour === hour));
            
            // Add to appropriate array
            if (state === 'available') {
                emp.availability.push({ day, hour });
            } else if (state === 'preferred') {
                emp.availability.push({ day, hour });
                emp.preferences.push({ day, hour });
            } else if (state === 'time-off') {
                emp.time_off.push({ day, hour });
            }
        }
    } catch (error) {
        console.error('Error saving availability cell:', error);
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
    const tbody = document.getElementById('availabilityTableBody');
    const cells = tbody.querySelectorAll('.avail-cell');
    
    // Clear all first
    cells.forEach(cell => {
        cell.classList.remove('available', 'preferred', 'time-off');
    });
    
    if (preset === 'clear') {
        // Just clear - already done above
    } else if (preset === 'all-9-5') {
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

async function saveFullAvailability(empId) {
    const tbody = document.getElementById('availabilityTableBody');
    const cells = tbody.querySelectorAll('.avail-cell');
    
    const availability = [];
    const preferences = [];
    const time_off = [];
    
    cells.forEach(cell => {
        const day = parseInt(cell.dataset.day);
        const hour = parseInt(cell.dataset.hour);
        
        if (cell.classList.contains('time-off')) {
            time_off.push({ day, hour });
        } else if (cell.classList.contains('preferred')) {
            availability.push({ day, hour });
            preferences.push({ day, hour });
        } else if (cell.classList.contains('available')) {
            availability.push({ day, hour });
        }
    });
    
    try {
        const response = await fetch(`/api/employees/${empId}/availability`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ availability, preferences, time_off })
        });
        
        if (response.ok) {
            // Update local state
            const emp = employeeMap[empId];
            if (emp) {
                emp.availability = availability;
                emp.preferences = preferences;
                emp.time_off = time_off;
            }
        }
    } catch (error) {
        console.error('Error saving availability:', error);
    }
}

// ==================== SETTINGS TAB ====================
function setupSettingsTab() {
    if (dom.saveSettingsBtn) {
        dom.saveSettingsBtn.addEventListener('click', saveSettings);
    }
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

// ==================== PEAK PERIODS (OLD UI) ====================
function renderPeakPeriodsOld() {
    const container = document.getElementById('peakPeriodsList');
    if (!container) return; // Element may not exist in new UI
    container.innerHTML = '';
    
    if (state.peakPeriods.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">⏰</div>
                <p>No peak periods defined yet.</p>
                <p class="text-muted">Add peak periods to schedule extra staff during busy times.</p>
            </div>
        `;
        return;
    }
    
    state.peakPeriods.forEach((period, index) => {
        const dayNames = period.days.map(d => state.days[d].substring(0, 3)).join(', ');
        
        const card = document.createElement('div');
        card.className = 'peak-period-card';
        card.innerHTML = `
            <div class="peak-icon">🔥</div>
            <div class="peak-period-info">
                <div class="peak-period-name">${period.name}</div>
                <div class="peak-period-time">${formatHour(period.start_hour)} - ${formatHour(period.end_hour)}</div>
                <div class="peak-period-days">${dayNames}</div>
            </div>
            <div class="peak-period-actions">
                <button class="btn-icon-sm" data-tooltip="Edit peak period" onclick="editPeakPeriod(${index})"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>
                <button class="btn-icon-sm" data-tooltip="Remove peak period" onclick="deletePeakPeriod(${index})"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
            </div>
        `;
        container.appendChild(card);
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

function addPeakPeriod() {
    const name = prompt('Peak period name (e.g., "Busy Hours", "Lunch Time"):');
    if (!name) return;
    
    const startHour = parseInt(prompt('Start hour (0-23):', '8'));
    if (isNaN(startHour) || startHour < 0 || startHour > 23) {
        showToast('Invalid start hour', 'error');
        return;
    }
    
    const endHour = parseInt(prompt('End hour (0-24):', '10'));
    if (isNaN(endHour) || endHour <= startHour || endHour > 24) {
        showToast('Invalid end hour', 'error');
        return;
    }
    
    const newPeriod = {
        name: name,
        start_hour: startHour,
        end_hour: endHour,
        days: [...state.daysOpen]  // Apply to all open days by default
    };
    
    state.peakPeriods.push(newPeriod);
    savePeakPeriods();
}

function editPeakPeriod(index) {
    const period = state.peakPeriods[index];
    if (!period) return;
    
    const name = prompt('Peak period name:', period.name);
    if (!name) return;
    
    const startHour = parseInt(prompt('Start hour (0-23):', period.start_hour));
    if (isNaN(startHour) || startHour < 0 || startHour > 23) {
        showToast('Invalid start hour', 'error');
        return;
    }
    
    const endHour = parseInt(prompt('End hour (0-24):', period.end_hour));
    if (isNaN(endHour) || endHour <= startHour || endHour > 24) {
        showToast('Invalid end hour', 'error');
        return;
    }
    
    period.name = name;
    period.start_hour = startHour;
    period.end_hour = endHour;
    
    savePeakPeriods();
}

function deletePeakPeriod(index) {
    if (!confirm('Remove this peak period?')) return;
    state.peakPeriods.splice(index, 1);
    savePeakPeriods();
}

async function savePeakPeriods() {
    try {
        const response = await fetch('/api/settings/peak-periods', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ peak_periods: state.peakPeriods })
        });
        
        const data = await response.json();
        
        if (data.success) {
            renderPeakPeriods();
            renderRoleCoverageEditor();  // Update coverage summaries
            showToast('Peak periods saved', 'success');
        } else {
            showToast(data.message || 'Failed to save peak periods', 'error');
        }
    } catch (error) {
        showToast('Error saving peak periods', 'error');
    }
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
            response = await fetch('/api/settings/roles', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(roleData)
            });
        } else {
            response = await fetch(`/api/settings/roles/${roleId}`, {
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
        const response = await fetch(`/api/settings/roles/${roleId}`, {
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

async function saveSettings() {
    showLoading('Saving settings...');
    
    // Gather settings
    const settings = {
        hours: {
            start_hour: parseInt(document.getElementById('startHour').value),
            end_hour: parseInt(document.getElementById('endHour').value)
        },
        days_open: Array.from(document.querySelectorAll('#daysOpen input:checked')).map(cb => parseInt(cb.value)),
        policies: getAllPolicies()
    };
    
    try {
        const response = await fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast('Settings saved successfully', 'success');
        } else {
            showToast(data.message || 'Failed to save settings', 'error');
        }
    } catch (error) {
        showToast('Error saving settings', 'error');
    } finally {
        hideLoading();
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
        
        // Close modals on Escape
        if (e.key === 'Escape') {
            closeAllModals();
            return;
        }
        
        // Tab switching with number keys
        if (e.key === '1') switchTab('schedule');
        else if (e.key === '2') switchTab('employees');
        else if (e.key === '3') switchTab('settings');
        else if (e.key === '4') switchTab('help');
        
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
            if (state.currentTab === 'employees') {
                openEmployeeForm();
            }
        }
    });
}

// ==================== UTILITIES ====================

// Maximally distinct color palette - avoids reds (reserved for "needs coverage" indicators)
const DISTINCT_COLORS = [
    '#2a9d8f', // Teal
    '#e9c46a', // Yellow/Gold
    '#264653', // Dark Blue-Gray
    '#f4a261', // Orange
    '#7209b7', // Purple
    '#3a86ff', // Bright Blue
    '#06d6a0', // Mint Green
    '#118ab2', // Ocean Blue
    '#ffd166', // Sunny Yellow
    '#073b4c', // Navy
    '#8338ec', // Violet
    '#4ecdc4', // Turquoise
    '#ffe66d', // Lemon
    '#95e1d3', // Seafoam
    '#aa96da', // Lavender
    '#a8d8ea', // Sky Blue
    '#ffc93c', // Amber
    '#6a0572', // Deep Purple
    '#1eb980', // Emerald
    '#00b4d8', // Cyan
    '#90be6d', // Olive Green
    '#577590', // Steel Blue
    '#43aa8b', // Sea Green
    '#f9844a', // Tangerine
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
            if (confirm('Delete this shift?')) {
                confirmDeleteShift(shiftId);
            }
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

function renderShiftTimeline() {
    // This is now handled by the calendar view
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
            renderShiftTimeline();
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
            renderShiftTimeline();
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

// ==================== START ====================
init();
