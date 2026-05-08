// Application State
const state = {
    currentView: 'landing-content',
    roomPin: '000000',
    students: [], // Array of {socketId, name, id, status, lastPulse, lastHidden, lastInteraction}
    userName: '',
    userId: '',
    socket: null,
    theme: localStorage.getItem('theme') || 'light',
    heartbeatInterval: null,
    wakeLock: null,
    lastInteraction: Date.now(),
    localStatus: 'Active' // Active, Idle, Background
};

// Defensive DOM Element Selection
const getEl = (id) => document.getElementById(id);

// Initialization
document.addEventListener('DOMContentLoaded', () => {
    console.log('SmartClass Focus Engine initializing...');
    
    // Initialize Socket.IO
    state.socket = io(window.location.origin, {
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: Infinity
    });

    // Theme Setup
    document.documentElement.setAttribute('data-theme', state.theme);
    if (window.lucide) lucide.createIcons();

    setupEventListeners();
    setupSocketListeners();
    setupActivityDetection();
});

// --- Focus & Activity Detection Logic ---
function setupActivityDetection() {
    // 1. Visibility API
    document.addEventListener('visibilitychange', () => {
        updateLocalStatus();
    });

    // 2. Window Focus/Blur (More sensitive than visibility)
    window.addEventListener('focus', () => updateLocalStatus());
    window.addEventListener('blur', () => updateLocalStatus());

    // 3. Interaction tracking for "Idle" status
    const recordInteraction = () => {
        state.lastInteraction = Date.now();
        if (state.localStatus === 'Idle') updateLocalStatus();
    };

    ['mousemove', 'keydown', 'click', 'touchstart'].forEach(evt => {
        window.addEventListener(evt, recordInteraction, { passive: true });
    });

    // 4. Online/Offline detection
    window.addEventListener('online', () => updateLocalStatus());
    window.addEventListener('offline', () => {
        state.localStatus = 'Disconnected';
        broadcastStatus();
    });

    // Idle Check Interval
    setInterval(() => {
        if (state.localStatus === 'Active' && (Date.now() - state.lastInteraction > 60000)) { // 1 min idle
            state.localStatus = 'Idle';
            broadcastStatus();
        }
    }, 10000);
}

function updateLocalStatus() {
    let newStatus = 'Active';

    if (document.hidden) {
        newStatus = 'Background';
    } else if (!document.hasFocus()) {
        newStatus = 'Background'; // Switched tab or split screen
    } else if (Date.now() - state.lastInteraction > 60000) {
        newStatus = 'Idle';
    }

    if (newStatus !== state.localStatus) {
        state.localStatus = newStatus;
        broadcastStatus();
    }
}

function broadcastStatus() {
    if (state.socket && state.currentView === 'active-view') {
        state.socket.emit('status-update', {
            pin: state.roomPin,
            status: state.localStatus,
            timestamp: Date.now()
        });
    }
}

// --- Socket Listeners ---
function setupSocketListeners() {
    // Teacher Side Updates
    state.socket.on('student-status-broadcast', (data) => {
        if (state.currentView !== 'teacher-view') return;
        
        let student = state.students.find(s => s.id === data.id);
        if (student) {
            const oldStatus = student.status;
            student.socketId = data.socketId;
            student.status = data.status;
            student.lastPulse = Date.now();
            
            if (oldStatus !== data.status) {
                updateStudentList();
                handleStatusAlert(student, data.status);
            }
        } else {
            // New Student
            state.students.push({
                socketId: data.socketId,
                name: data.name,
                id: data.id,
                status: data.status,
                lastPulse: Date.now(),
                lastAlertTime: 0
            });
            updateStudentList();
            createPopupAlert(data.name, data.id, 'JOINED');
        }
    });

    state.socket.on('student-disconnected', (data) => {
        const student = state.students.find(s => s.socketId === data.socketId);
        if (student) {
            student.status = 'Disconnected';
            updateStudentList();
            // 30s delay before full cleanup
            setTimeout(() => {
                if (student.status === 'Disconnected') {
                    // student.status = 'Offline'; // Could remove here
                    updateStudentList();
                }
            }, 30000);
        }
    });

    // Student Side Updates
    state.socket.on('joined-success', (data) => {
        getEl('active-status-text').textContent = `Focus Shield Active (Session #${data.pin})`;
        showView('active-view');
        startHeartbeat();
    });

    state.socket.on('reconnect', () => {
        if (state.currentView === 'active-view') {
            state.socket.emit('join-room', { pin: state.roomPin, name: state.userName, id: state.userId });
        }
    });
}

function handleStatusAlert(student, status) {
    const now = Date.now();
    // Debounce alerts to prevent spam (min 5s between same student alerts)
    if (now - student.lastAlertTime < 5000) return;

    if (status === 'Background') {
        createPopupAlert(student.name, student.id, 'SWITCHED');
        student.lastAlertTime = now;
    } else if (status === 'Active') {
        createPopupAlert(student.name, student.id, 'OPENED');
        student.lastAlertTime = now;
    }
}

// --- Heartbeat Logic ---
function startHeartbeat() {
    if (state.heartbeatInterval) clearInterval(state.heartbeatInterval);
    state.heartbeatInterval = setInterval(() => {
        if (state.socket && state.socket.connected) {
            state.socket.emit('heartbeat', {
                pin: state.roomPin,
                status: state.localStatus
            });
        }
    }, 4000); // Every 4 seconds
}

// Teacher Watchdog (Checks for missing heartbeats)
setInterval(() => {
    if (state.currentView !== 'teacher-view') return;
    const now = Date.now();
    let changed = false;

    state.students.forEach(student => {
        if (student.status === 'Disconnected' || student.status === 'Offline') return;
        
        const secondsSincePulse = (now - student.lastPulse) / 1000;
        if (secondsSincePulse > 12) { // 12s timeout
            student.status = 'Disconnected';
            changed = true;
            createPopupAlert(student.name, student.id, 'OFFLINE');
        }
    });

    if (changed) updateStudentList();
}, 5000);

// --- View Management ---
function showView(sectionId) {
    const landing = getEl('landing-content');
    const dashboards = getEl('dashboard-content');
    
    if (sectionId === 'landing-content') {
        landing?.classList.remove('hidden');
        dashboards?.classList.add('hidden');
    } else {
        landing?.classList.add('hidden');
        dashboards?.classList.remove('hidden');
    }

    document.querySelectorAll('.dashboard-section').forEach(section => section.classList.add('hidden'));
    getEl(sectionId)?.classList.remove('hidden');
    state.currentView = sectionId;
}

function setupEventListeners() {
    // Navigation
    const teacherBtns = [getEl('hero-btn-teacher'), getEl('nav-btn-teacher')];
    teacherBtns.forEach(btn => btn?.addEventListener('click', () => {
        generatePin();
        showView('teacher-view');
        state.socket.emit('create-room', state.roomPin);
        requestWakeLock();
    }));

    const studentBtns = [getEl('hero-btn-student'), getEl('nav-btn-student')];
    studentBtns.forEach(btn => btn?.addEventListener('click', () => showView('student-view')));

    document.querySelectorAll('.back-to-landing').forEach(btn => btn.addEventListener('click', () => location.reload()));

    // Join Session
    getEl('join-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        state.userName = getEl('student-name').value;
        state.userId = getEl('student-id').value;
        state.roomPin = getEl('room-pin').value;
        state.socket.emit('join-room', { pin: state.roomPin, name: state.userName, id: state.userId });
    });

    // Theme
    getEl('theme-toggle')?.addEventListener('click', () => {
        state.theme = state.theme === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', state.theme);
        localStorage.setItem('theme', state.theme);
    });
}

// --- UI Helpers ---
function generatePin() {
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    state.roomPin = pin;
    if (getEl('teacher-pin-input')) getEl('teacher-pin-input').value = pin;
}

function updateStudentList() {
    const list = getEl('student-list');
    const count = getEl('student-count');
    if (!list) return;

    count.textContent = state.students.length;
    list.innerHTML = state.students.map(student => {
        let color = '#ef4444'; // Red (Default)
        if (student.status === 'Active') color = '#10b981'; // Green
        if (student.status === 'Idle' || student.status === 'Background') color = '#f59e0b'; // Yellow/Orange

        return `
            <li>
                <div class="student-info">
                    <span class="student-name">${student.name}</span>
                    <span class="student-id">ID: ${student.id}</span>
                </div>
                <span class="status-badge" style="color: ${color}; background: ${color}1A">
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
    const config = {
        JOINED: { text: 'joined class', color: 'green', icon: 'user-plus' },
        OPENED: { text: 'phone is turned on', color: 'red', icon: 'smartphone' },
        CLOSED: { text: 'phone is turned off', color: 'green', icon: 'smartphone-off' },
        SWITCHED: { text: 'switched app', color: 'red', icon: 'layers' },
        OFFLINE: { text: 'is disconnected', color: 'red', icon: 'wifi-off' }
    };
    const c = config[type] || config.JOINED;

    toast.className = `alert-toast opened`;
    toast.innerHTML = `
        <div class="alert-icon"><i data-lucide="${c.icon}"></i></div>
        <div class="alert-content">
            <h4>${name}</h4>
            <p class="alert-status ${c.color}">${c.text}</p>
        </div>
    `;
    container.appendChild(toast);
    if (window.lucide) lucide.createIcons();
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 500);
    }, 5000);
}

async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch (err) {}
    }
}
