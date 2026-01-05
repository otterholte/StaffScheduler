/**
 * Settings Page JavaScript
 * Handles theme toggle, account deletion, and user preferences
 */

// ==================== STATE ====================
const state = {
    currentUser: null,
    theme: localStorage.getItem('theme') || 'dark',
    isLoading: false
};

// ==================== API ENDPOINTS ====================
const API = {
    USER: '/auth/api/user'
};

// ==================== DOM ELEMENTS ====================
const dom = {
    // Toast container
    toastContainer: document.getElementById('toastContainer'),
    
    // Theme controls
    themeSwitch: document.getElementById('themeSwitch'),
    themeOptions: document.querySelectorAll('.theme-option'),
    
    // Delete account
    deleteAccountBtn: document.getElementById('deleteAccountBtn'),
    deleteModal: document.getElementById('deleteModal'),
    closeDeleteModal: document.getElementById('closeDeleteModal'),
    cancelDeleteBtn: document.getElementById('cancelDeleteBtn'),
    confirmDeleteBtn: document.getElementById('confirmDeleteBtn'),
    deletePassword: document.getElementById('deletePassword'),
    
    // User info
    userName: document.getElementById('userName'),
    userEmail: document.getElementById('userEmail'),
    userAvatar: document.getElementById('userAvatar')
};

// ==================== THEME ====================
function loadTheme() {
    const theme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    state.theme = theme;
    
    if (dom.themeSwitch) {
        dom.themeSwitch.checked = theme === 'light';
    }
    
    dom.themeOptions?.forEach(opt => {
        opt.classList.toggle('active', opt.dataset.theme === theme);
    });
}

function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    state.theme = theme;
    
    if (dom.themeSwitch) {
        dom.themeSwitch.checked = theme === 'light';
    }
    
    dom.themeOptions?.forEach(opt => {
        opt.classList.toggle('active', opt.dataset.theme === theme);
    });
}

// ==================== TOAST ====================
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <span class="toast-message">${message}</span>
        <button class="toast-close">&times;</button>
    `;
    
    dom.toastContainer?.appendChild(toast);
    
    // Trigger animation
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });
    
    // Auto dismiss
    const timeout = setTimeout(() => dismissToast(toast), 4000);
    
    // Manual dismiss
    toast.querySelector('.toast-close')?.addEventListener('click', () => {
        clearTimeout(timeout);
        dismissToast(toast);
    });
}

function dismissToast(toast) {
    toast.classList.remove('show');
    toast.addEventListener('transitionend', () => toast.remove());
}

// ==================== API HELPERS ====================
async function apiRequest(url, options = {}) {
    const defaultOptions = {
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        credentials: 'same-origin'
    };
    
    const response = await fetch(url, { ...defaultOptions, ...options });
    
    // Check if response is JSON before parsing
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
        throw new Error('Server returned non-JSON response');
    }
    
    const data = await response.json();
    return { response, data };
}

// ==================== DELETE ACCOUNT ====================
function openDeleteModal() {
    if (dom.deleteModal) {
        dom.deleteModal.style.display = 'flex';
        dom.deletePassword.value = '';
        dom.deletePassword.focus();
    }
}

function closeDeleteModal() {
    if (dom.deleteModal) {
        dom.deleteModal.style.display = 'none';
        dom.deletePassword.value = '';
    }
}

async function deleteAccount() {
    if (state.isLoading) return;
    
    const password = dom.deletePassword?.value || '';
    
    if (!password) {
        showToast('Please enter your password to confirm', 'error');
        return;
    }
    
    state.isLoading = true;
    dom.confirmDeleteBtn.disabled = true;
    dom.confirmDeleteBtn.textContent = 'Deleting...';
    
    try {
        const { response, data } = await apiRequest(API.USER, {
            method: 'DELETE',
            body: JSON.stringify({ password })
        });
        
        if (data.success) {
            showToast('Account deleted successfully', 'info');
            closeDeleteModal();
            // Redirect to home page after a short delay
            setTimeout(() => {
                window.location.href = '/';
            }, 1500);
        } else {
            showToast(data.error || 'Failed to delete account', 'error');
        }
    } catch (error) {
        console.error('Delete account error:', error);
        showToast('Connection error. Please try again.', 'error');
    } finally {
        state.isLoading = false;
        dom.confirmDeleteBtn.disabled = false;
        dom.confirmDeleteBtn.textContent = 'Delete Account';
    }
}

// ==================== EVENT LISTENERS ====================
function setupEventListeners() {
    // Theme switch
    dom.themeSwitch?.addEventListener('change', () => {
        setTheme(dom.themeSwitch.checked ? 'light' : 'dark');
    });
    
    // Theme options
    dom.themeOptions?.forEach(opt => {
        opt.addEventListener('click', () => {
            setTheme(opt.dataset.theme);
        });
    });
    
    // Delete account modal
    dom.deleteAccountBtn?.addEventListener('click', openDeleteModal);
    dom.closeDeleteModal?.addEventListener('click', closeDeleteModal);
    dom.cancelDeleteBtn?.addEventListener('click', closeDeleteModal);
    dom.confirmDeleteBtn?.addEventListener('click', deleteAccount);
    
    // Close modal on backdrop click
    dom.deleteModal?.addEventListener('click', (e) => {
        if (e.target === dom.deleteModal) {
            closeDeleteModal();
        }
    });
    
    // Close modal on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dom.deleteModal?.style.display === 'flex') {
            closeDeleteModal();
        }
    });
    
    // Delete password enter key
    dom.deletePassword?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            deleteAccount();
        }
    });
}

// ==================== INITIALIZATION ====================
function init() {
    loadTheme();
    
    // Get user data passed from Flask
    if (window.SETTINGS_DATA?.user) {
        state.currentUser = window.SETTINGS_DATA.user;
    }
    
    setupEventListeners();
}

// Start
document.addEventListener('DOMContentLoaded', init);
