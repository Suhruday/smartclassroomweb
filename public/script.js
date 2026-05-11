// ==========================================
// SMART CLASSROOM MONITORING SYSTEM
// ==========================================

const state = {
    currentView: 'landing-content',
    roomPin: '000000',
    students: [], // Stores student objects
    userName: '',
    userId: '',
    socket: null,
    theme: localStorage.getItem('theme') || 'light',
    heartbeatInterval: null,
    wakeLock: null,
    isJoined: false,
    teacherPin: '',
    isLocked: false
};

const getEl = (id) => document.getElementById(id);

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    state.socket = io(window.location.origin, {
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: Infinity
    });

    document.documentElement.setAttribute('data-theme', state.theme);
    if (window.lucide) lucide.createIcons();

    setupEventListeners();
    setupSocketListeners();
});

// ==========================================
// HEARTBEAT SYSTEM
// ==========================================
function startStudentHeartbeat() {
    if (state.heartbeatInterval) clearInterval(state.heartbeatInterval);
    // Heartbeat every 5 seconds
    state.heartbeatInterval = setInterval(() => {
        sendPulse(); 
    }, 5000); 
}

function sendPulse() {
    if (state.socket && state.socket.connected && state.isJoined) {
        state.socket.emit('heartbeat', {
            pin: state.roomPin,
            hidden: document.hidden,
            isLocked: state.isLocked
        });
    }
}

// ==========================================
// REAL-TIME COMMUNICATION
// ==========================================
function setupSocketListeners() {
    state.socket.on('connect', () => {
        if (state.isJoined) {
            state.socket.emit('join-room', { pin: state.roomPin, name: state.userName, id: state.userId });
        } else if (state.currentView === 'teacher-view' && state.teacherPin) {
            state.socket.emit('create-room', state.teacherPin);
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
                switchedAppCount: 0,
                joinTime: Date.now(),
                hiddenPulseCount: 0
            };
            state.students.push(student);
            logEvent(`${student.name} joined the session.`);
        } else {
            student.socketId = data.socketId;
            student.lastPulse = Date.now();

            // If under penalty, ignore normal status updates
            if (student.lockBrokenPenaltyUntil && Date.now() < student.lockBrokenPenaltyUntil) {
                updateStudentList();
                return;
            }

            if (data.isLocked) {
                student.hiddenPulseCount = 0;
                if (student.status !== 'Phone Off') {
                    student.status = 'Phone Off';
                    triggerAlert(student, 'locked their phone', 'green', true);
                    logEvent(`${student.name} locked their phone.`);
                }
            } else if (!data.hidden) {
                // --- 1. ACTIVE (BLUE) ---
                // The student is looking at the screen.
                if (student.status !== 'Active') {
                    if (student.status === 'Offline') {
                        triggerAlert(student, 'came back online', 'blue', true);
                        logEvent(`${student.name} came back online.`);
                    } else if (student.status === 'Phone Off') {
                        student.turnOnCount++;
                        triggerAlert(student, 'turned on their phone', 'blue', true);
                        logEvent(`${student.name} turned on their phone.`);
                    } else {
                        student.turnOnCount++;
                        triggerAlert(student, 'returned to the classroom', 'blue');
                        logEvent(`${student.name} returned to Active state.`);
                    }
                    student.status = 'Active';
                }
                student.hiddenPulseCount = 0;
            } else {
                // --- 2. SWITCHED APP (RED) ---
                // The student's screen is hidden, but the browser is still executing heartbeats.
                student.hiddenPulseCount++;
                
                // Wait for 6 consecutive hidden pulses (30s) to confirm it's an app switch.
                if (student.hiddenPulseCount >= 6 && (student.status === 'Active' || student.status === 'Phone Off')) {
                    student.status = 'Switched App';
                    student.switchedAppCount++;
                    triggerAlert(student, 'switched app', 'red', true);
                    logEvent(`${student.name} switched app.`);
                }
            }
            student.lastHidden = data.hidden;
        }
        updateStudentList();
    });

    state.socket.on('student-explicit-offline', (data) => {
        // --- 4. EXPLICIT OFFLINE (GRAY) ---
        // Student intentionally closed the browser or tab.
        const student = state.students.find(s => s.socketId === data.socketId);
        if (student && student.status !== 'Offline') {
            student.status = 'Offline';
            updateStudentList();
            triggerAlert(student, 'went offline (closed app)', 'gray', true);
            logEvent(`${student.name} went offline.`);
        }
    });

    state.socket.on('student-lock-broken', (data) => {
        if (state.currentView !== 'teacher-view') return;
        const student = state.students.find(s => s.socketId === data.socketId);
        if (student) {
            student.status = 'Switched App';
            student.switchedAppCount++;
            student.hiddenPulseCount = 6; // Force the heartbeat logic to agree they switched
            student.lockBrokenPenaltyUntil = Date.now() + 10000; // 10 second penalty
            triggerAlert(student, 'switched app (broke lock screen)', 'red', true);
            logEvent(`${student.name} switched app (broke lock screen).`);
            updateStudentList();
        }
    });

    state.socket.on('joined-success', (data) => {
        state.isJoined = true;
        getEl('active-status-text').textContent = `Focus Guard Active (Session #${data.pin})`;
        showView('active-view');
        startStudentHeartbeat();
    });

    state.socket.on('error-msg', (msg) => {
        alert(msg);
        if (state.isLocked) {
            state.isLocked = false;
            getEl('lock-screen-overlay')?.classList.add('hidden');
            try { document.exitFullscreen(); } catch (e) {}
        }
    });
}

// ==========================================
// ALERT SYSTEM
// ==========================================
function triggerAlert(student, message, colorType, withSound = false) {
    const fullMsg = `${student.name} (${student.id}) ${message}`;
    createPopupAlert(student.name, student.id, message, colorType);
    
    if ("Notification" in window && Notification.permission === "granted") {
        new Notification('SmartClass Alert', { body: fullMsg, icon: '/favicon.ico' });
    }
    
    if (withSound) playSound();
}

// ==========================================
// TEACHER WATCHDOG (Handles Missing Pulses)
// ==========================================
setInterval(() => {
    if (state.currentView !== 'teacher-view') return;
    const now = Date.now();
    let changed = false;

    state.students.forEach(student => {
        const secSincePulse = (now - student.lastPulse) / 1000;

        // --- NEW: SWITCHED APP REPEATED ALERT ---
        // Must be at the top of the loop so it's never skipped by a return
        if (student.status === 'Switched App') {
            if (!student.lastSwitchedAlertTime) {
                student.lastSwitchedAlertTime = now;
            } else if (now - student.lastSwitchedAlertTime >= 60000) {
                student.lastSwitchedAlertTime = now;
                triggerAlert(student, 'is still in another app!', 'red', true);
            }
        } else {
            student.lastSwitchedAlertTime = null; // Reset when they are no longer in Switched App
        }

        // --- 4. TIMEOUT OFFLINE (GRAY) ---
        // If a student is completely silent for 15 minutes, we declare them offline.
        if (secSincePulse > 900) { 
            if (student.status !== 'Offline') {
                student.status = 'Offline';
                triggerAlert(student, 'session timed out', 'gray');
                changed = true;
            }
            return;
        }

        // --- 3. PHONE OFF (GREEN) ---
        // 10 seconds of silence = Phone Lock or Sleep.
        if (secSincePulse > 10) {
            // CRITICAL RULE: Do NOT overwrite 'Switched App'.
            // When a student switches to WhatsApp, Android will eventually pause the browser 
            // in the background to save battery, stopping the heartbeats. 
            // We must ignore that silence and leave them as Switched App.
            if (student.status === 'Switched App' || student.status === 'Offline') {
                return; 
            }

            if (student.status !== 'Phone Off') {
                student.status = 'Phone Off';
                student.hiddenPulseCount = 0; // Reset
                triggerAlert(student, 'locked their phone / app slept', 'green');
                logEvent(`${student.name} locked their phone (heartbeats stopped).`);
                changed = true;
            }
        }
    });

    if (changed) updateStudentList();
}, 1000);

// ==========================================
// TEACHER DASHBOARD UI
// ==========================================
function updateStudentList() {
    const list = getEl('student-list');
    const count = getEl('student-count');
    if (!list) return;

    count.textContent = state.students.length;
    
    if (state.students.length === 0) {
        list.innerHTML = '<li class="empty-state">Waiting for students...</li>';
        return;
    }

    list.innerHTML = state.students.map(student => {
        let color = '#3b82f6'; // ACTIVE = BLUE
        if (student.status === 'Switched App') color = '#ef4444'; // SWITCHED APP = RED
        if (student.status === 'Phone Off') color = '#10b981'; // PHONE OFF = GREEN
        if (student.status === 'Offline') color = '#9ca3af'; // OFFLINE = GRAY

        const durationMin = Math.floor((Date.now() - student.joinTime) / 60000);
        const secSincePulse = Math.floor((Date.now() - student.lastPulse) / 1000);
        const lastSeen = secSincePulse < 5 ? 'Just now' : `${secSincePulse}s ago`;

        return `
            <li class="student-item-large" style="grid-template-columns: 2fr 3fr auto;">
                <div class="student-main-info">
                    <span class="student-name">${student.name}</span>
                    <span class="student-id">ID: ${student.id}</span>
                    <span class="metric" style="margin-top:4px;"><span class="m-label">Session:</span> <span class="m-value">${durationMin} min</span></span>
                </div>
                <div class="student-metrics" style="display:grid; grid-template-columns: 1fr 1fr; gap:0.5rem;">
                    <div class="metric">
                        <span class="m-label">Returned:</span>
                        <span class="m-value">${student.turnOnCount}</span>
                    </div>
                    <div class="metric">
                        <span class="m-label">Switched:</span>
                        <span class="m-value">${student.switchedAppCount}</span>
                    </div>
                    <div class="metric" style="grid-column: span 2;">
                        <span class="m-label">Last Pulse:</span>
                        <span class="m-value">${lastSeen}</span>
                    </div>
                </div>
                <span class="status-badge-solid" style="background: ${color}">
                    ${student.status}
                </span>
            </li>
        `;
    }).join('');
}

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

function createPopupAlert(name, id, message, colorType) {
    const container = getEl('alert-container');
    if (!container) return;

    let hexColor = '#3b82f6'; // blue
    if (colorType === 'green') hexColor = '#10b981';
    if (colorType === 'red') hexColor = '#ef4444';
    if (colorType === 'gray') hexColor = '#9ca3af';

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
    } catch (e) { }
}

function setupEventListeners() {
    const tBtns = [getEl('hero-btn-teacher'), getEl('nav-btn-teacher')];
    tBtns.forEach(b => b?.addEventListener('click', () => {
        generatePin();
        showView('teacher-view');
        state.socket.emit('create-room', state.teacherPin);
        if ("Notification" in window) Notification.requestPermission();
        requestWakeLock();
    }));

    [getEl('hero-btn-student'), getEl('nav-btn-student')].forEach(b => b?.addEventListener('click', () => showView('student-view')));

    getEl('join-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        state.userName = getEl('student-name').value;
        state.userId = getEl('student-id').value;
        state.roomPin = getEl('room-pin').value;
        
        // Optimistically lock the phone because it requires a user gesture
        state.isLocked = true;
        getEl('lock-screen-overlay')?.classList.remove('hidden');
        try { document.documentElement.requestFullscreen(); } catch (err) {}

        state.socket.emit('join-room', { pin: state.roomPin, name: state.userName, id: state.userId, isLocked: true });
    });

    getEl('theme-toggle')?.addEventListener('click', () => {
        state.theme = state.theme === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', state.theme);
        localStorage.setItem('theme', state.theme);
    });

    // Phone Lock / Unlock Handlers
    getEl('btn-lock-phone')?.addEventListener('click', () => {
        state.isLocked = true;
        getEl('lock-screen-overlay')?.classList.remove('hidden');
        try { document.documentElement.requestFullscreen(); } catch (e) {}
        sendPulse(); // Immediate heartbeat with locked state
    });

    getEl('btn-unlock-phone')?.addEventListener('click', () => {
        state.isLocked = false; // Set to false BEFORE exiting fullscreen
        getEl('lock-screen-overlay')?.classList.add('hidden');
        try { document.exitFullscreen(); } catch (e) {}
        sendPulse(); // Immediate heartbeat with unlocked state
    });

    // Detect if the student breaks out of the lock screen (e.g. System Back button, Home button)
    document.addEventListener('fullscreenchange', () => {
        if (state.isLocked && !document.fullscreenElement) {
            state.isLocked = false;
            getEl('lock-screen-overlay')?.classList.add('hidden');
            
            if (state.socket && state.socket.connected) {
                // Use sendBeacon to ensure the event reaches the server even if the browser is freezing
                if ('sendBeacon' in navigator) {
                    const data = new URLSearchParams();
                    data.append('pin', state.roomPin);
                    data.append('socketId', state.socket.id);
                    navigator.sendBeacon('/api/lock-broken', data);
                } else {
                    state.socket.emit('student-lock-broken', { pin: state.roomPin });
                }
            }
            sendPulse();
        }
    });


    window.addEventListener('beforeunload', () => {
        if (state.socket && state.socket.connected && state.isJoined && state.currentView !== 'teacher-view') {
            state.socket.emit('student-leaving', { pin: state.roomPin });
        }
    });
}

function generatePin() {
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    state.teacherPin = pin;
    if (getEl('teacher-pin-input')) getEl('teacher-pin-input').value = pin;
}

async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch (err) { }
    }
}
