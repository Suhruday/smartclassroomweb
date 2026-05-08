// Application State
const state = {
    currentView: 'landing-content',
    roomPin: '000000',
    students: [], // {socketId, name, id, status, lastPulse, lastHidden, alertCooldown}
    userName: '',
    userId: '',
    socket: null,
    theme: localStorage.getItem('theme') || 'light',
    heartbeatInterval: null,
    wakeLock: null,
    lastInteraction: Date.now()
};

const getEl = (id) => document.getElementById(id);

// Initialization
document.addEventListener('DOMContentLoaded', () => {
    state.socket = io(window.location.origin);
    document.documentElement.setAttribute('data-theme', state.theme);
    if (window.lucide) lucide.createIcons();

    setupEventListeners();
    setupSocketListeners();
    setupMobileResilience();
});

// --- Student: High-Resilience Heartbeat ---
function startStudentHeartbeat() {
    if (state.heartbeatInterval) clearInterval(state.heartbeatInterval);
    state.heartbeatInterval = setInterval(() => {
        if (state.socket && state.socket.connected) {
            state.socket.emit('heartbeat', {
                pin: state.roomPin,
                hidden: document.hidden,
                focused: document.hasFocus()
            });
        }
    }, 4000); // 4s interval is optimal for mobile background stability
}

function setupMobileResilience() {
    const report = () => {
        if (state.currentView === 'active-view' && state.socket) {
            state.socket.emit('visibility-status', { pin: state.roomPin, hidden: document.hidden });
        }
    };
    document.addEventListener('visibilitychange', report);
    window.addEventListener('pagehide', report);
}

// --- Socket Listeners ---
function setupSocketListeners() {
    // Teacher: Process Incoming Signals
    state.socket.on('student-pulse', (data) => {
        if (state.currentView !== 'teacher-view') return;
        
        let student = state.students.find(s => s.id === data.id);
        if (!student) {
            student = {
                socketId: data.socketId,
                name: data.name,
                id: data.id,
                status: 'Active',
                lastPulse: Date.now(),
                lastHidden: data.hidden,
                alertCooldown: 0
            };
            state.students.push(student);
            logEvent(`${student.name} joined the session.`);
            sendNotification('New Student Joined', `${student.name} is now connected.`);
        } else {
            student.socketId = data.socketId;
            student.lastPulse = Date.now();
            student.lastHidden = data.hidden;
        }
        updateStudentList();
    });

    state.socket.on('student-offline', (data) => {
        const student = state.students.find(s => s.socketId === data.socketId);
        if (student) {
            student.status = 'Disconnected';
            updateStudentList();
            logEvent(`${student.name} has disconnected.`);
            sendNotification('Student Disconnected', `${student.name} lost connection.`);
        }
    });

    // Student: Success
    state.socket.on('joined-success', (data) => {
        getEl('active-status-text').textContent = `Focus Shield Active (Session #${data.pin})`;
        showView('active-view');
        startStudentHeartbeat();
    });

    state.socket.on('error-msg', (msg) => alert(msg));
}

// --- Teacher Dashboard Brain (Detection & Alerts) ---
setInterval(() => {
    if (state.currentView !== 'teacher-view') return;
    const now = Date.now();
    let listChanged = false;

    state.students.forEach(student => {
        if (student.status === 'Disconnected') return;

        const secSincePulse = (now - student.lastPulse) / 1000;
        let nextStatus = student.status;

        // 1. Detection Logic
        if (secSincePulse > 12) {
            // Heartbeat fully stopped = Screen Locked or Phone Off
            nextStatus = 'Screen Locked';
        } else if (student.lastHidden) {
            // Heartbeat is still arriving but tab is hidden = Switched App
            nextStatus = 'Switched App';
        } else {
            nextStatus = 'Active';
        }

        // 2. Alert Management
        if (nextStatus !== student.status) {
            const oldStatus = student.status;
            student.status = nextStatus;
            listChanged = true;

            // Only notify if status changed significantly and not spamming (10s cooldown)
            if (now - student.alertCooldown > 10000) {
                if (nextStatus === 'Switched App') {
                    triggerViolation(student, 'switched to another app');
                } else if (nextStatus === 'Screen Locked' && oldStatus === 'Active') {
                    logEvent(`${student.name} locked their phone.`);
                } else if (nextStatus === 'Active' && (oldStatus === 'Switched App' || oldStatus === 'Screen Locked')) {
                    triggerViolation(student, 'returned to class', 'green');
                }
                student.alertCooldown = now;
            }
        }
    });

    if (listChanged) updateStudentList();
}, 2000);

function triggerViolation(student, message, color = 'red') {
    createPopupAlert(student.name, student.id, message, color);
    logEvent(`${student.name} ${message}`);
    
    if (color === 'red') {
        sendNotification('Focus Violation', `${student.name} ${message}`);
        playSound('alert');
    }
}

// --- View & UI Helpers ---
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
    document.querySelectorAll('.dashboard-section').forEach(s => s.classList.add('hidden'));
    getEl(sectionId)?.classList.remove('hidden');
    state.currentView = sectionId;
}

function updateStudentList() {
    const list = getEl('student-list');
    const count = getEl('student-count');
    if (!list) return;

    count.textContent = state.students.length;
    list.innerHTML = state.students.map(student => {
        let color = '#10b981'; // Active
        if (student.status === 'Switched App') color = '#ef4444'; // Violation
        if (student.status === 'Screen Locked') color = '#f59e0b'; // Warn
        if (student.status === 'Disconnected') color = '#64748b'; // Off

        return `
            <li>
                <div class="student-info">
                    <span class="student-name">${student.name}</span>
                    <span class="student-id">${student.status}</span>
                </div>
                <div class="status-indicator" style="background: ${color}"></div>
            </li>
        `;
    }).join('');
}

function createPopupAlert(name, id, message, color) {
    const container = getEl('alert-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `alert-toast opened`;
    toast.innerHTML = `
        <div class="alert-icon"><i data-lucide="${color === 'red' ? 'layers' : 'zap'}"></i></div>
        <div class="alert-content">
            <h4>${name}</h4>
            <p class="alert-status ${color}">${message}</p>
        </div>
    `;
    container.appendChild(toast);
    if (window.lucide) lucide.createIcons();
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 500);
    }, 5000);
}

function logEvent(msg) {
    const log = getEl('event-log');
    if (!log) return;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = `<span class="log-time">[${time}]</span> ${msg}`;
    log.prepend(entry);
    if (log.children.length > 50) log.lastChild.remove();
}

// --- Notifications & Sound ---
function requestPermissions() {
    if ("Notification" in window) Notification.requestPermission();
}

function sendNotification(title, body) {
    if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
        new Notification(title, { body, icon: '/favicon.ico' });
    }
}

function playSound(type) {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(type === 'alert' ? 440 : 880, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.1);
    } catch (e) {}
}

// --- Setup ---
function setupEventListeners() {
    const tBtns = [getEl('hero-btn-teacher'), getEl('nav-btn-teacher')];
    tBtns.forEach(b => b?.addEventListener('click', () => {
        generatePin();
        showView('teacher-view');
        state.socket.emit('create-room', state.roomPin);
        requestPermissions();
        requestWakeLock();
    }));

    getEl('hero-btn-student')?.addEventListener('click', () => showView('student-view'));
    getEl('nav-btn-student')?.addEventListener('click', () => showView('student-view'));

    getEl('join-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        state.userName = getEl('student-name').value;
        state.userId = getEl('student-id').value;
        state.roomPin = getEl('room-pin').value;
        state.socket.emit('join-room', { pin: state.roomPin, name: state.userName, id: state.userId });
    });

    getEl('theme-toggle')?.addEventListener('click', () => {
        state.theme = state.theme === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', state.theme);
        localStorage.setItem('theme', state.theme);
    });
}

function generatePin() {
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    state.roomPin = pin;
    if (getEl('teacher-pin-input')) getEl('teacher-pin-input').value = pin;
}

async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch (err) {}
    }
}
