// Application State
const state = {
    currentView: 'landing-content',
    roomPin: '000000',
    students: [], // Array of {socketId, name, id, status, lastPulse, lastHidden}
    userName: '',
    userId: '',
    socket: null,
    theme: localStorage.getItem('theme') || 'light',
    heartbeatInterval: null,
    wakeLock: null
};

// Defensive DOM Element Selection
const getEl = (id) => document.getElementById(id);

// Initialization
document.addEventListener('DOMContentLoaded', () => {
    console.log('SmartClass initialized...');
    
    // Initialize Socket.IO with the current origin (Crucial for Render)
    state.socket = io(window.location.origin);

    // Initial Theme Setup
    document.documentElement.setAttribute('data-theme', state.theme);
    const themeIcon = getEl('theme-toggle')?.querySelector('i');
    if (themeIcon) {
        themeIcon.setAttribute('data-lucide', state.theme === 'light' ? 'moon' : 'sun');
    }
    if (window.lucide) lucide.createIcons();

    setupEventListeners();
    setupSocketListeners();
});

// View Management
function showView(sectionId) {
    console.log('Switching view to:', sectionId);
    
    // Toggle main visibility
    const landing = getEl('landing-content');
    const dashboards = getEl('dashboard-content');
    
    if (sectionId === 'landing-content') {
        landing?.classList.remove('hidden');
        dashboards?.classList.add('hidden');
    } else {
        landing?.classList.add('hidden');
        dashboards?.classList.remove('hidden');
    }

    // Toggle specific sections
    document.querySelectorAll('.dashboard-section').forEach(section => {
        section.classList.add('hidden');
    });
    
    const targetSection = getEl(sectionId);
    if (targetSection) {
        targetSection.classList.remove('hidden');
        state.currentView = sectionId;
    }
}

// Event Listeners Setup
function setupEventListeners() {
    // Start Session Buttons (Teacher)
    const teacherBtns = [getEl('hero-btn-teacher'), getEl('nav-btn-teacher')];
    teacherBtns.forEach(btn => {
        btn?.addEventListener('click', () => {
            generatePin();
            showView('teacher-view');
            requestNotificationPermission();
            requestWakeLock();
            initTeacherEvents();
        });
    });

    // Join Session Buttons (Student)
    const studentBtns = [getEl('hero-btn-student'), getEl('nav-btn-student')];
    studentBtns.forEach(btn => {
        btn?.addEventListener('click', () => {
            showView('student-view');
        });
    });

    // Back to Landing Buttons
    document.querySelectorAll('.back-to-landing').forEach(btn => {
        btn.addEventListener('click', () => {
            location.reload(); // Hard reset for clean state
        });
    });

    // Join Form Submit
    getEl('join-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = getEl('student-name')?.value;
        const id = getEl('student-id')?.value;
        const pin = getEl('room-pin')?.value;

        if (name && id && pin) {
            state.userName = name;
            state.userId = id;
            state.roomPin = pin;
            state.socket.emit('join-room', { pin, name, id });
        }
    });

    // Refresh PIN
    getEl('btn-refresh-pin')?.addEventListener('click', () => {
        generatePin();
        state.socket.emit('create-room', state.roomPin);
    });

    // Theme Toggle
    getEl('theme-toggle')?.addEventListener('click', () => {
        state.theme = state.theme === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', state.theme);
        localStorage.setItem('theme', state.theme);
        const icon = getEl('theme-toggle')?.querySelector('i');
        if (icon) {
            icon.setAttribute('data-lucide', state.theme === 'light' ? 'moon' : 'sun');
            if (window.lucide) lucide.createIcons();
        }
    });
}

// Socket IO Listeners
function setupSocketListeners() {
    // --- Teacher Updates ---
    state.socket.on('student-joined', (data) => {
        if (state.currentView !== 'teacher-view') return;
        const student = state.students.find(s => s.id === data.id);
        if (student) {
            student.socketId = data.socketId;
            student.status = 'Online';
        } else {
            state.students.push({
                socketId: data.socketId,
                name: data.name,
                id: data.id,
                status: 'Online',
                lastPulse: Date.now(),
                lastHidden: false,
                lastAlertTime: Date.now()
            });
        }
        updateStudentList();
        createPopupAlert(data.name, data.id, 'JOINED');
        sendSystemNotification(`Student Joined`, `${data.name} joined.`);
    });

    state.socket.on('student-heartbeat', (data) => {
        const student = state.students.find(s => s.socketId === data.socketId);
        if (student) {
            student.lastPulse = Date.now();
            student.lastHidden = data.hidden;
            if (!data.hidden && (student.status === 'Phone Off' || student.status === 'Switched Apps')) {
                handleStudentReturn(student);
            }
        }
    });

    state.socket.on('student-resumed', (data) => {
        const student = state.students.find(s => s.socketId === data.socketId);
        if (student) handleStudentReturn(student);
    });

    state.socket.on('student-left', (data) => {
        const student = state.students.find(s => s.socketId === data.socketId);
        if (student) {
            student.status = 'Phone Off';
            updateStudentList();
            
            if (student.offlineTimeout) clearTimeout(student.offlineTimeout);
            student.offlineTimeout = setTimeout(() => {
                if (student.status === 'Phone Off') {
                    student.status = 'Offline';
                    updateStudentList();
                }
            }, 300000);
        }
    });

    // --- Student Updates ---
    state.socket.on('joined-success', (data) => {
        const statusText = getEl('active-status-text');
        if (statusText) statusText.textContent = `Monitor Active (Session #${data.pin})`;
        showView('active-view');
        startStudentHeartbeat();
    });

    state.socket.on('error-msg', (msg) => {
        alert(msg);
    });

    state.socket.on('teacher-disconnected', () => {
        alert('The educator has ended the session.');
        location.reload();
    });
}

// --- Internal Logics ---
function initTeacherEvents() {
    state.socket.emit('create-room', state.roomPin);
}

function handleStudentReturn(student) {
    const now = Date.now();
    if (!student.lastOnAlert || (now - student.lastOnAlert) > 3000) {
        student.status = 'Online';
        student.lastAlertTime = now;
        student.lastOnAlert = now;
        updateStudentList();
        createPopupAlert(student.name, student.id, 'OPENED');
        sendSystemNotification(`${student.name}, ${student.id}`, `phone turned on`);
    }
}

function startStudentHeartbeat() {
    if (state.heartbeatInterval) clearInterval(state.heartbeatInterval);
    state.heartbeatInterval = setInterval(() => {
        if (state.socket) {
            state.socket.emit('heartbeat', { pin: state.roomPin, hidden: document.hidden });
        }
    }, 1500);
}

// Teacher Monitor Interval
setInterval(() => {
    if (state.currentView !== 'teacher-view') return;
    const now = Date.now();
    let changed = false;

    state.students.forEach(student => {
        if (student.status === 'Offline') return;
        const secondsSincePulse = (now - student.lastPulse) / 1000;
        const msSinceLastAlert = now - student.lastAlertTime;

        if (secondsSincePulse > 5) {
            if (student.status !== 'Phone Off') {
                student.status = 'Phone Off';
                student.lastAlertTime = now;
                changed = true;
                createPopupAlert(student.name, student.id, 'CLOSED');
            }
        } else if (student.lastHidden && secondsSincePulse <= 5) {
            if (student.status !== 'Switched Apps') {
                student.status = 'Switched Apps';
                student.lastAlertTime = now;
                changed = true;
                createPopupAlert(student.name, student.id, 'SWITCHED');
            } else if (msSinceLastAlert > 60000) {
                student.lastAlertTime = now;
                createPopupAlert(student.name, student.id, 'SWITCHED');
            }
        }
    });
    if (changed) updateStudentList();
}, 2000);

// Tab Visibility for Students
document.addEventListener('visibilitychange', () => {
    if (state.currentView !== 'active-view' || !state.socket) return;
    state.socket.emit('visibility-change', { pin: state.roomPin, hidden: document.hidden });
    if (!document.hidden) state.socket.emit('student-resumed', { pin: state.roomPin });
});

// UI Helper Functions
function generatePin() {
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    state.roomPin = pin;
    const pinDisp = getEl('teacher-pin-input');
    if (pinDisp) pinDisp.value = pin;
}

function updateStudentList() {
    const list = getEl('student-list');
    const count = getEl('student-count');
    if (!list) return;

    if (state.students.length === 0) {
        list.innerHTML = '<li class="empty-state">Waiting for students...</li>';
        if (count) count.textContent = '0';
        return;
    }

    if (count) count.textContent = state.students.length;
    list.innerHTML = state.students.map(student => {
        let badgeColor = student.status === 'Phone Off' ? '#10b981' : (student.status === 'Offline' ? '#64748b' : '#ef4444');
        let badgeBg = student.status === 'Phone Off' ? 'rgba(16, 185, 129, 0.1)' : (student.status === 'Offline' ? 'rgba(100, 116, 139, 0.1)' : 'rgba(239, 68, 68, 0.1)');

        return `
            <li>
                <div class="student-info">
                    <span class="student-name">${student.name}</span>
                    <span class="student-id">ID: ${student.id}</span>
                </div>
                <span class="status-badge" style="color: ${badgeColor}; background: ${badgeBg}">
                    ${student.status}
                </span>
            </li>
        `;
    }).join('');
}

function createPopupAlert(name, id, type) {
    if (state.currentView !== 'teacher-view') return;
    const container = getEl('alert-container');
    if (!container) return;

    const toast = document.createElement('div');
    let statusText = type === 'OPENED' ? 'phone is turned on' : (type === 'SWITCHED' ? 'switched app' : (type === 'JOINED' ? 'JOINED' : (type === 'OFFLINE' ? 'is OFFLINE' : 'phone is turned off')));
    let statusColor = (type === 'OPENED' || type === 'SWITCHED' || type === 'OFFLINE') ? 'red' : 'green';
    let icon = type === 'OPENED' ? 'smartphone' : (type === 'SWITCHED' ? 'layers' : (type === 'JOINED' ? 'user-plus' : (type === 'OFFLINE' ? 'wifi-off' : 'smartphone-off')));

    toast.className = `alert-toast ${type === 'CLOSED' ? 'closed' : 'opened'}`;
    toast.innerHTML = `
        <div class="alert-icon"><i data-lucide="${icon}"></i></div>
        <div class="alert-content">
            <h4>${name}, ${id}</h4>
            <p class="alert-status ${statusColor}">${statusText}</p>
        </div>
    `;
    container.appendChild(toast);
    if (window.lucide) lucide.createIcons();
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(50px)';
        setTimeout(() => toast.remove(), 500);
    }, 5000);
}

function requestNotificationPermission() {
    if ("Notification" in window) Notification.requestPermission();
}

function sendSystemNotification(title, body) {
    if ("Notification" in window && Notification.permission === "granted") {
        new Notification(title, { body, icon: '/favicon.ico' });
    }
}

async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch (err) {}
    }
}
