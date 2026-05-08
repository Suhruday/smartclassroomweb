// Application State
const state = {
    currentView: 'landing-content',
    roomPin: '000000',
    students: [], // {socketId, name, id, status, lastPulse, lastHidden, turnOnCount, switchDuration, lastSwitchTime, offlineTimeout}
    userName: '',
    userId: '',
    socket: null,
    theme: localStorage.getItem('theme') || 'light',
    heartbeatInterval: null,
    wakeLock: null
};

const getEl = (id) => document.getElementById(id);

// Initialization
document.addEventListener('DOMContentLoaded', () => {
    // Socket.io with aggressive reconnection
    state.socket = io(window.location.origin, {
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: Infinity
    });

    document.documentElement.setAttribute('data-theme', state.theme);
    if (window.lucide) lucide.createIcons();

    setupEventListeners();
    setupSocketListeners();
});

// --- Student: Reliable Heartbeat ---
function startStudentHeartbeat() {
    if (state.heartbeatInterval) clearInterval(state.heartbeatInterval);
    state.heartbeatInterval = setInterval(() => {
        if (state.socket && state.socket.connected) {
            state.socket.emit('heartbeat', {
                pin: state.roomPin,
                hidden: document.hidden
            });
        }
    }, 5000); 
}

// --- Socket Listeners ---
function setupSocketListeners() {
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
                turnOnCount: 0,
                switchDuration: 0,
                lastSwitchTime: null,
                offlineTimeout: null
            };
            state.students.push(student);
            logEvent(`${student.name} joined.`);
        } else {
            // Student is back (reconnected or pulse arrived)
            if (student.offlineTimeout) {
                clearTimeout(student.offlineTimeout);
                student.offlineTimeout = null;
            }
            
            student.socketId = data.socketId;
            student.lastPulse = Date.now();
            student.lastHidden = data.hidden;
        }
        updateStudentList();
    });

    state.socket.on('student-offline', (data) => {
        const student = state.students.find(s => s.socketId === data.socketId);
        if (student) {
            // DO NOT DISCONNECT IMMEDIATELY
            // When phone locks, the socket often closes. Treat this as "Phone Off" (Green)
            student.status = 'Phone Off';
            updateStudentList();

            // Only remove student if they don't reconnect within 10 minutes
            if (student.offlineTimeout) clearTimeout(student.offlineTimeout);
            student.offlineTimeout = setTimeout(() => {
                if (student.status === 'Phone Off' || student.status === 'Disconnected') {
                    student.status = 'Disconnected';
                    updateStudentList();
                    createPopupAlert(student.name, student.id, 'left the session', 'gray');
                }
            }, 600000); // 10 minute grace period
        }
    });

    state.socket.on('joined-success', (data) => {
        getEl('active-status-text').textContent = `Focus Shield Active (Session #${data.pin})`;
        showView('active-view');
        startStudentHeartbeat();
    });
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

        // --- THE "WAIT AND SEE" LOGIC ---
        // This prevents the "Switched App" flicker during phone lock.
        
        if (secSincePulse > 15) {
            // Heartbeat stopped = Phone is locked/off.
            nextStatus = 'Phone Off';
        } else if (student.lastHidden) {
            // If tab is hidden BUT pulses are still coming (secSincePulse < 10)
            // Wait at least 10s of hidden pulses before accusing of switching app
            if (secSincePulse < 10) {
                nextStatus = 'Switched App';
            }
        } else {
            nextStatus = 'Active';
        }

        // --- Handle State Changes ---
        if (nextStatus !== student.status) {
            const oldStatus = student.status;
            
            // PRIORITY 1: Lock Detection (Always Green)
            if (nextStatus === 'Phone Off') {
                createPopupAlert(student.name, student.id, 'turned off the phone', 'green');
                logEvent(`${student.name} turned off phone.`);
            } 
            // PRIORITY 2: Switched App (Red)
            else if (nextStatus === 'Switched App') {
                // Only alert if we haven't already marked them as switched
                if (oldStatus !== 'Switched App') {
                    student.lastSwitchTime = now;
                    createPopupAlert(student.name, student.id, 'switched app', 'red');
                    playSound('alert');
                }
            } 
            // PRIORITY 3: Return (Red Alert + Metrics)
            else if (nextStatus === 'Active' && (oldStatus === 'Phone Off' || oldStatus === 'Switched App')) {
                student.turnOnCount++;
                createPopupAlert(student.name, student.id, 'turned on the phone', 'red');
                logEvent(`${student.name} turned on phone (${student.turnOnCount}).`);
                
                if (oldStatus === 'Switched App' && student.lastSwitchTime) {
                    student.switchDuration += Math.round((now - student.lastSwitchTime) / 1000);
                    student.lastSwitchTime = null;
                }
            }

            student.status = nextStatus;
            listChanged = true;
        }

        if (student.status === 'Switched App') listChanged = true;
    });

    if (listChanged) updateStudentList();
}, 2000);

// --- UI Helpers ---
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
        let color = '#3b82f6'; // Blue
        if (student.status === 'Switched App') color = '#ef4444'; // Red
        if (student.status === 'Phone Off') color = '#10b981'; // Green
        if (student.status === 'Disconnected') color = '#64748b'; // Gray

        const now = Date.now();
        let totalSwitchTime = student.switchDuration;
        if (student.status === 'Switched App' && student.lastSwitchTime) {
            totalSwitchTime += Math.round((now - student.lastSwitchTime) / 1000);
        }

        return `
            <li class="student-item-large">
                <div class="student-main-info">
                    <span class="student-name">${student.name}</span>
                    <span class="student-id">Turned On Count: ${student.turnOnCount}</span>
                </div>
                <div class="student-metrics">
                    <div class="metric">
                        <span class="m-label">Outside:</span>
                        <span class="m-value">${totalSwitchTime}s</span>
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

    let hexColor = colorType === 'green' ? '#10b981' : (colorType === 'gray' ? '#64748b' : '#ef4444');

    const toast = document.createElement('div');
    toast.className = `alert-toast opened`;
    toast.style.borderLeft = `5px solid ${hexColor}`;
    toast.innerHTML = `
        <div class="alert-content">
            <h4>${name}</h4>
            <p class="alert-status" style="color: ${hexColor}">${message}</p>
        </div>
    `;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 500);
    }, 6000);
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

function playSound(type) {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        osc.frequency.setValueAtTime(440, audioCtx.currentTime);
        osc.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.05);
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
