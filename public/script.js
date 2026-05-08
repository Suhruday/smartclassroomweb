// Application State
const state = {
    currentView: 'landing-content',
    roomPin: '000000',
    students: [], // {socketId, name, id, status, lastPulse, turnOnCount}
    userName: '',
    userId: '',
    socket: null,
    theme: localStorage.getItem('theme') || 'light',
    heartbeatInterval: null,
    wakeLock: null,
    isJoined: false // Track if student has successfully joined
};

const getEl = (id) => document.getElementById(id);

// Initialization
document.addEventListener('DOMContentLoaded', () => {
    state.socket = io(window.location.origin, {
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionAttempts: Infinity
    });

    document.documentElement.setAttribute('data-theme', state.theme);
    if (window.lucide) lucide.createIcons();

    setupEventListeners();
    setupSocketListeners();
});

// --- Student: High-Resilience Heartbeat ---
function startStudentHeartbeat() {
    if (state.heartbeatInterval) clearInterval(state.heartbeatInterval);
    state.heartbeatInterval = setInterval(() => {
        if (state.socket && state.socket.connected && state.isJoined) {
            state.socket.emit('heartbeat', {
                pin: state.roomPin,
                hidden: document.hidden
            });
        }
    }, 3000); 
}

// --- Socket Listeners ---
function setupSocketListeners() {
    // RECONNECT LOGIC: Ensure student re-joins room after a disconnect (like phone lock)
    state.socket.on('connect', () => {
        if (state.isJoined) {
            state.socket.emit('join-room', { 
                pin: state.roomPin, 
                name: state.userName, 
                id: state.userId 
            });
        }
    });

    state.socket.on('student-pulse', (data) => {
        if (state.currentView !== 'teacher-view') return;
        
        let student = state.students.find(s => s.id === data.id);
        if (!student) {
            student = {
                socketId: data.socketId,
                name: data.name,
                id: data.id,
                status: data.hidden ? 'Switched App' : 'Active',
                lastPulse: Date.now(),
                turnOnCount: 0
            };
            state.students.push(student);
            logEvent(`${student.name} connected.`);
        } else {
            const oldStatus = student.status;
            student.socketId = data.socketId;
            student.lastPulse = Date.now();
            
            const newStatus = data.hidden ? 'Switched App' : 'Active';
            
            // Immediate Status Update & Alerts
            if (newStatus === 'Active' && oldStatus !== 'Active') {
                student.turnOnCount++;
                createPopupAlert(student.name, student.id, 'turned on the phone', 'red');
                logEvent(`${student.name} returned/turned on.`);
            } else if (newStatus === 'Switched App' && oldStatus !== 'Switched App') {
                createPopupAlert(student.name, student.id, 'switched app', 'red');
                playSound();
            }

            student.status = newStatus;
        }
        updateStudentList();
    });

    state.socket.on('student-offline', (data) => {
        const student = state.students.find(s => s.socketId === data.socketId);
        if (student) {
            // Socket lost = Phone locked/off. Set to Green instantly.
            student.status = 'Phone Off';
            updateStudentList();
            createPopupAlert(student.name, student.id, 'turned off the phone', 'green');
            logEvent(`${student.name} turned off.`);
        }
    });

    state.socket.on('joined-success', (data) => {
        state.isJoined = true;
        getEl('active-status-text').textContent = `Focus Guard Active (Session #${data.pin})`;
        showView('active-view');
        startStudentHeartbeat();
    });

    state.socket.on('teacher-disconnected', () => {
        alert('Session ended by teacher.');
        location.reload();
    });

    state.socket.on('error-msg', (msg) => alert(msg));
}

// --- Teacher Watchdog: Handles Silent Pulse Fades ---
setInterval(() => {
    if (state.currentView !== 'teacher-view') return;
    const now = Date.now();
    let changed = false;

    state.students.forEach(student => {
        if (student.status === 'Disconnected') return;
        
        const secSincePulse = (now - student.lastPulse) / 1000;
        // If we haven't heard anything for 10s, it's definitely Phone Off
        if (secSincePulse > 10 && student.status !== 'Phone Off') {
            student.status = 'Phone Off';
            changed = true;
        }
    });

    if (changed) updateStudentList();
}, 2000);

// --- UI Logic ---
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
        let color = '#3b82f6'; // Blue (Active)
        if (student.status === 'Switched App') color = '#ef4444'; // Red
        if (student.status === 'Phone Off') color = '#10b981'; // Green
        
        return `
            <li class="student-item-large">
                <div class="student-main-info">
                    <span class="student-name">${student.name}</span>
                    <span class="student-id">ID: ${student.id}</span>
                </div>
                <div class="student-metrics">
                    <div class="metric">
                        <span class="m-label">Turned On Count:</span>
                        <span class="m-value">${student.turnOnCount}</span>
                    </div>
                </div>
                <span class="status-badge-solid" style="background: ${color}">
                    ${student.status}
                </span>
            </li>
        `;
    }).join('');
}

function createPopupAlert(name, id, message, colorType) {
    const container = getEl('alert-container');
    if (!container) return;

    let hexColor = colorType === 'green' ? '#10b981' : '#ef4444';

    const toast = document.createElement('div');
    toast.className = `alert-toast opened`;
    toast.style.borderLeft = `5px solid ${hexColor}`;
    toast.innerHTML = `
        <div class="alert-content">
            <h4>${name} (${id})</h4>
            <p class="alert-status" style="color: ${hexColor}">${message}</p>
        </div>
    `;
    container.appendChild(toast);
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
}

function playSound() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        osc.frequency.setValueAtTime(440, audioCtx.currentTime);
        osc.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.1);
    } catch (e) {}
}

function setupEventListeners() {
    const tBtns = [getEl('hero-btn-teacher'), getEl('nav-btn-teacher')];
    tBtns.forEach(b => b?.addEventListener('click', () => {
        generatePin();
        showView('teacher-view');
        state.socket.emit('create-room', state.roomPin);
        if ("Notification" in window) Notification.requestPermission();
        requestWakeLock();
    }));

    [getEl('hero-btn-student'), getEl('nav-btn-student')].forEach(b => b?.addEventListener('click', () => showView('student-view')));

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
