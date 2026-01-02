/**
 * Staff Scheduler Pro - Settings Page
 * Demo authentication and user data management
 */

// ==================== STORAGE KEYS ====================
const STORAGE_KEYS = {
    USERS: 'staffScheduler_users',
    SESSION: 'staffScheduler_session',
    THEME: 'theme',
    DATA_PREFIX: 'staffScheduler_data_'
};

// ==================== STATE ====================
const state = {
    currentUser: null,
    theme: 'dark'
};

// ==================== DOM ELEMENTS ====================
const dom = {
    // Toast
    toastContainer: document.getElementById('toastContainer'),
    
    // Auth tabs and forms
    authTabs: document.querySelectorAll('.auth-tab'),
    loginForm: document.getElementById('loginForm'),
    signupForm: document.getElementById('signupForm'),
    
    // Login form fields
    loginUsername: document.getElementById('loginUsername'),
    loginPassword: document.getElementById('loginPassword'),
    
    // Signup form fields
    signupUsername: document.getElementById('signupUsername'),
    signupPassword: document.getElementById('signupPassword'),
    signupConfirm: document.getElementById('signupConfirm'),
    
    // Auth states
    loggedOutState: document.getElementById('loggedOutState'),
    loggedInState: document.getElementById('loggedInState'),
    userName: document.getElementById('userName'),
    userAvatar: document.getElementById('userAvatar'),
    
    // Buttons
    logoutBtn: document.getElementById('logoutBtn'),
    deleteAccountBtn: document.getElementById('deleteAccountBtn'),
    
    // Theme
    themeSwitch: document.getElementById('themeSwitch'),
    themeOptions: document.querySelectorAll('.theme-option'),
    
    // Data section
    dataStatusText: document.getElementById('dataStatusText'),
    dataStats: document.getElementById('dataStats'),
    storedItemsCount: document.getElementById('storedItemsCount'),
    
    // Delete modal
    deleteModal: document.getElementById('deleteModal'),
    closeDeleteModal: document.getElementById('closeDeleteModal'),
    cancelDeleteBtn: document.getElementById('cancelDeleteBtn'),
    confirmDeleteBtn: document.getElementById('confirmDeleteBtn')
};

// ==================== TOAST NOTIFICATIONS ====================
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <span class="toast-message">${message}</span>
        <button class="toast-close">&times;</button>
    `;
    
    dom.toastContainer.appendChild(toast);
    
    // Trigger animation
    requestAnimationFrame(() => toast.classList.add('show'));
    
    // Auto dismiss
    const timeout = setTimeout(() => dismissToast(toast), 4000);
    
    // Manual dismiss
    toast.querySelector('.toast-close').addEventListener('click', () => {
        clearTimeout(timeout);
        dismissToast(toast);
    });
}

function dismissToast(toast) {
    toast.classList.remove('show');
    toast.addEventListener('transitionend', () => toast.remove());
}

// ==================== SIMPLE HASH FUNCTION ====================
// Note: This is for demo purposes only - NOT secure for production
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(36);
}

// ==================== USER MANAGEMENT ====================
function getUsers() {
    try {
        const users = localStorage.getItem(STORAGE_KEYS.USERS);
        return users ? JSON.parse(users) : {};
    } catch {
        return {};
    }
}

function saveUsers(users) {
    localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(users));
}

function createAccount(username, password) {
    const users = getUsers();
    
    if (users[username]) {
        showToast('Username already exists', 'error');
        return false;
    }
    
    if (username.length < 3) {
        showToast('Username must be at least 3 characters', 'error');
        return false;
    }
    
    if (password.length < 4) {
        showToast('Password must be at least 4 characters', 'error');
        return false;
    }
    
    users[username] = {
        passwordHash: simpleHash(password),
        createdAt: new Date().toISOString()
    };
    
    saveUsers(users);
    showToast('Account created successfully!', 'success');
    return true;
}

function login(username, password) {
    const users = getUsers();
    const user = users[username];
    
    if (!user) {
        showToast('User not found', 'error');
        return false;
    }
    
    if (user.passwordHash !== simpleHash(password)) {
        showToast('Incorrect password', 'error');
        return false;
    }
    
    // Create session
    const session = {
        username: username,
        loginTime: new Date().toISOString()
    };
    
    localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify(session));
    state.currentUser = username;
    
    showToast(`Welcome back, ${username}!`, 'success');
    updateAuthUI();
    return true;
}

function logout() {
    localStorage.removeItem(STORAGE_KEYS.SESSION);
    state.currentUser = null;
    showToast('Logged out successfully', 'info');
    updateAuthUI();
}

function deleteAccount() {
    if (!state.currentUser) return;
    
    const username = state.currentUser;
    const users = getUsers();
    
    // Remove user
    delete users[username];
    saveUsers(users);
    
    // Remove user data
    const dataKey = STORAGE_KEYS.DATA_PREFIX + username;
    localStorage.removeItem(dataKey);
    
    // Clear session
    localStorage.removeItem(STORAGE_KEYS.SESSION);
    state.currentUser = null;
    
    showToast('Account deleted successfully', 'info');
    updateAuthUI();
    closeModal();
}

function checkSession() {
    try {
        const session = localStorage.getItem(STORAGE_KEYS.SESSION);
        if (session) {
            const { username } = JSON.parse(session);
            const users = getUsers();
            if (users[username]) {
                state.currentUser = username;
                return true;
            }
        }
    } catch {
        // Session invalid
    }
    state.currentUser = null;
    return false;
}

// ==================== UI UPDATES ====================
function updateAuthUI() {
    if (state.currentUser) {
        dom.loggedOutState.style.display = 'none';
        dom.loggedInState.style.display = 'block';
        dom.userName.textContent = state.currentUser;
        dom.userAvatar.textContent = state.currentUser.charAt(0).toUpperCase();
        dom.dataStatusText.textContent = `Logged in as ${state.currentUser}. Your data is saved locally.`;
        dom.dataStats.style.display = 'block';
        updateDataStats();
    } else {
        dom.loggedOutState.style.display = 'block';
        dom.loggedInState.style.display = 'none';
        dom.dataStatusText.textContent = 'Login to save data associated with your account.';
        dom.dataStats.style.display = 'none';
    }
}

function updateDataStats() {
    if (!state.currentUser) return;
    
    const dataKey = STORAGE_KEYS.DATA_PREFIX + state.currentUser;
    try {
        const data = localStorage.getItem(dataKey);
        if (data) {
            const parsed = JSON.parse(data);
            const count = Object.keys(parsed).length;
            dom.storedItemsCount.textContent = count;
        } else {
            dom.storedItemsCount.textContent = '0';
        }
    } catch {
        dom.storedItemsCount.textContent = '0';
    }
}

function switchAuthTab(tab) {
    dom.authTabs.forEach(t => t.classList.remove('active'));
    document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
    
    if (tab === 'login') {
        dom.loginForm.classList.add('active');
        dom.signupForm.classList.remove('active');
    } else {
        dom.loginForm.classList.remove('active');
        dom.signupForm.classList.add('active');
    }
}

// ==================== THEME ====================
function applyTheme(theme) {
    if (theme === 'light') {
        document.body.setAttribute('data-theme', 'light');
        dom.themeSwitch.checked = true;
    } else {
        document.body.removeAttribute('data-theme');
        dom.themeSwitch.checked = false;
    }
    state.theme = theme;
    localStorage.setItem(STORAGE_KEYS.THEME, theme);
    
    // Update theme option highlights
    dom.themeOptions.forEach(opt => {
        opt.classList.toggle('active', opt.dataset.theme === theme);
    });
}

function toggleTheme() {
    const newTheme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme(newTheme);
}

function loadTheme() {
    const savedTheme = localStorage.getItem(STORAGE_KEYS.THEME);
    // Default to dark if no theme saved
    applyTheme(savedTheme || 'dark');
}

// ==================== MODAL ====================
function showModal() {
    dom.deleteModal.style.display = 'flex';
    requestAnimationFrame(() => dom.deleteModal.classList.add('active'));
}

function closeModal() {
    dom.deleteModal.classList.remove('active');
    setTimeout(() => {
        dom.deleteModal.style.display = 'none';
    }, 300);
}

// ==================== EVENT HANDLERS ====================
function setupEventListeners() {
    // Auth tabs
    dom.authTabs.forEach(tab => {
        tab.addEventListener('click', () => switchAuthTab(tab.dataset.tab));
    });
    
    // Login form
    dom.loginForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const username = dom.loginUsername.value.trim();
        const password = dom.loginPassword.value;
        
        if (login(username, password)) {
            dom.loginForm.reset();
        }
    });
    
    // Signup form
    dom.signupForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const username = dom.signupUsername.value.trim();
        const password = dom.signupPassword.value;
        const confirm = dom.signupConfirm.value;
        
        if (password !== confirm) {
            showToast('Passwords do not match', 'error');
            return;
        }
        
        if (createAccount(username, password)) {
            // Auto login after account creation
            login(username, password);
            dom.signupForm.reset();
        }
    });
    
    // Logout
    dom.logoutBtn.addEventListener('click', logout);
    
    // Delete account
    dom.deleteAccountBtn.addEventListener('click', showModal);
    dom.closeDeleteModal.addEventListener('click', closeModal);
    dom.cancelDeleteBtn.addEventListener('click', closeModal);
    dom.confirmDeleteBtn.addEventListener('click', deleteAccount);
    
    // Close modal on overlay click
    dom.deleteModal.addEventListener('click', (e) => {
        if (e.target === dom.deleteModal) {
            closeModal();
        }
    });
    
    // Theme toggle
    dom.themeSwitch.addEventListener('change', toggleTheme);
    
    // Theme option clicks
    dom.themeOptions.forEach(opt => {
        opt.addEventListener('click', () => {
            applyTheme(opt.dataset.theme);
        });
    });
    
    // Escape key to close modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dom.deleteModal.style.display === 'flex') {
            closeModal();
        }
    });
}

// ==================== INITIALIZATION ====================
function init() {
    loadTheme();
    checkSession();
    updateAuthUI();
    setupEventListeners();
}

// Start
document.addEventListener('DOMContentLoaded', init);

