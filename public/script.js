// Application State
const state = {
    currentView: 'landing-content',
    roomPin: '000000',
    students: [], // {socketId, name, id, status, lastPulse, lastHidden, turnOnCount, firstHiddenTime}
    userName: '',
    userId: '',
    socket: null,
    theme: localStorage.getItem('theme') || 'light',
    heartbeatInterval: null,
    wakeLock: null,
    isJoined: false
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
        sendPulse(); // Periodic heartbeat
    }, 2000); // Super fast (2s) for instant detection
}

function sendPulse() {
    if (state.socket && state.socket.connected && state.isJoined) {
        state.socket.emit('heartbeat', {
            pin: state.roomPin,
            hidden: document.hidden
        });
    }
}

// --- Socket Listeners ---
function setupSocketListeners() {
    state.socket.on('connect', () => {
        if (state.isJoined) {
            state.socket.emit('join-room', { pin: state.roomPin, name: state.userName, id: state.userId });
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
                status: 'Active',
                lastPulse: Date.now(),
                lastHidden: data.hidden,
                turnOnCount: 0,
                firstHiddenTime: data.hidden ? Date.now() : null,
                lastSwitchedAlertTime: 0
            };
            state.students.push(student);
            logEvent(`${student.name} joined.`);
        } else {
            student.socketId = data.socketId;
            student.lastPulse = Date.now();

            if (!data.hidden) {
                // RETURN TO CLASS (Active/Blue)
                if (student.status !== 'Active') {
                    student.turnOnCount++;
                    student.status = 'Active';
                    triggerAlert(student, 'turned on the phone', 'red');
                    logEvent(`${student.name} turned on phone.`);
                }
                student.firstHiddenTime = null;
            } else {
                // TAB HIDDEN (Could be Lock or Switch)
                if (!student.lastHidden) {
                    student.firstHiddenTime = Date.now();
                }
                // We DON'T set status here anymore. 
                // The Watchdog will decide if it's a Lock or Switch based on if pulses continue.
            }
            student.lastHidden = data.hidden;
        }
        updateStudentList();
    });

    state.socket.on('student-offline', (data) => {
        const student = state.students.find(s => s.socketId === data.socketId);
        if (student) {
            // Ignore disconnects for Switched App students (let watchdog handle it)
            if (student.status === 'Switched App') {
                logEvent(`${student.name} background connection lost.`);
                return;
            }

            if (student.status !== 'Phone Off') {
                student.status = 'Phone Off';
                student.firstHiddenTime = null;
                updateStudentList();
                triggerAlert(student, 'turned off the phone', 'green');
                logEvent(`${student.name} turned off.`);
            }
        }
    });

    state.socket.on('joined-success', (data) => {
        state.isJoined = true;
        getEl('active-status-text').textContent = `Focus Guard Active (Session #${data.pin})`;
        showView('active-view');
        startStudentHeartbeat();
    });
}

function triggerAlert(student, message, colorType, withSound = false) {
    const fullMsg = `${student.name} (${student.id}) ${message}`;
    createPopupAlert(student.name, student.id, message, colorType);
    sendSystemNotification('Class Monitor Alert', fullMsg);
    if (withSound) playSound();
}

// --- Teacher Watchdog: State Decision Engine ---
setInterval(() => {
    if (state.currentView !== 'teacher-view') return;
    const now = Date.now();
    let changed = false;

    state.students.forEach(student => {
        const secSincePulse = (now - student.lastPulse) / 1000;
        const secSinceHidden = student.firstHiddenTime ? (now - student.firstHiddenTime) / 1000 : 0;

        // 1. RECURRING ALERT for Switched App
        if (student.status === 'Switched App') {
            const timeSinceLastAlert = (now - (student.lastSwitchedAlertTime || 0)) / 1000;
            if (timeSinceLastAlert >= 60) {
                triggerAlert(student, 'is still using another app', 'red', true);
                student.lastSwitchedAlertTime = now;
            }
        }

        // 2. DETECT SILENCE (Phone Off / Lock)
        if (secSincePulse > 4) {
            if (student.status !== 'Phone Off') {
                // If they were "Switched App", we use a 5-min timeout for silence (throttling resilience)
                if (student.status === 'Switched App') {
                    if (secSincePulse > 300) {
                        student.status = 'Phone Off';
                        triggerAlert(student, 'turned off the phone', 'green');
                        changed = true;
                    }
                } else {
                    // If they were Active, 3s silence means they LOCKED the phone.
                    student.status = 'Phone Off';
                    student.firstHiddenTime = null;
                    triggerAlert(student, 'turned off the phone', 'green');
                    logEvent(`${student.name} turned off.`);
                    changed = true;
                }
            }
        } 
        // 3. DETECT CONTINUOUS HIDDEN PULSES (Switched App)
        else if (student.lastHidden && student.status === 'Active') {
            // If they are still sending pulses but hidden for > 20 seconds, they SWITCHED APPS.
            // A 20s delay ensures that if they just locked the phone, the OS has enough time 
            // to suspend the browser and trigger the "Phone Off" silence check above.
            if (secSinceHidden > 20) {
                student.status = 'Switched App';
                student.lastSwitchedAlertTime = now;
                triggerAlert(student, 'switched app', 'red', true);
                logEvent(`${student.name} switched app.`);
                changed = true;
            }
        }
    });

    if (changed) updateStudentList();
}, 1000);

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

function sendSystemNotification(title, body) {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") {
        new Notification(title, { body, icon: '/favicon.ico' });
    }
}

function playSound() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        osc.frequency.setValueAtTime(440, audioCtx.currentTime);
        osc.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.1);
    } catch (e) { }
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
        try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch (err) { }
    }
}
