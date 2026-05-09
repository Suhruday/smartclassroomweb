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
    teacherPin: ''
};

const getEl = (id) => document.getElementById(id);

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    // Socket.IO configuration for reconnects
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
// 6. HEARTBEAT SYSTEM
// ==========================================
function startStudentHeartbeat() {
    if (state.heartbeatInterval) clearInterval(state.heartbeatInterval);
    // Heartbeat every 5 seconds as requested
    state.heartbeatInterval = setInterval(() => {
        sendPulse(); 
    }, 5000); 
}

function sendPulse() {
    if (state.socket && state.socket.connected && state.isJoined) {
        state.socket.emit('heartbeat', {
            pin: state.roomPin,
            hidden: document.hidden
        });
    }
}

// ==========================================
// 3. REAL-TIME COMMUNICATION
// ==========================================
function setupSocketListeners() {
    // --- 7. RECONNECT LOGIC ---
    state.socket.on('connect', () => {
        if (state.isJoined) {
            // Auto reconnect and preserve session
            state.socket.emit('join-room', { pin: state.roomPin, name: state.userName, id: state.userId });
        } else if (state.currentView === 'teacher-view' && state.teacherPin) {
            // Teacher reconnect
            state.socket.emit('create-room', state.teacherPin);
        }
    });

    // --- 4 & 5. STUDENT MONITORING & DETECTION LOGIC ---
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

            if (!data.hidden) {
                // A) ACTIVE CONDITIONS MET
                if (student.status !== 'Active') {
                    if (student.status === 'Offline') {
                        // Return from Offline
                        student.status = 'Active';
                        triggerAlert(student, 'came back online', 'blue', true);
                        logEvent(`${student.name} came back online.`);
                    } else {
                        // Phone On Alert (from off or switched state)
                        student.turnOnCount++;
                        student.status = 'Active';
                        triggerAlert(student, 'turned on the phone', 'red');
                        logEvent(`${student.name} returned to Active state.`);
                    }
                }
                student.hiddenPulseCount = 0;
            } else {
                // HIDDEN PAGE DETECTED
                student.hiddenPulseCount++;
                
                // B) SWITCHED APP CONDITIONS
                // Page hidden + heartbeat STILL active (we got at least 2 consecutive hidden pulses)
                if (student.hiddenPulseCount >= 2 && student.status !== 'Switched App' && student.status !== 'Phone Off') {
                    student.status = 'Switched App';
                    student.switchedAppCount++;
                    // Trigger ONE red alert only
                    triggerAlert(student, 'switched app', 'red', true);
                    logEvent(`${student.name} switched app.`);
                }
            }
            student.lastHidden = data.hidden;
        }
        updateStudentList();
    });

    state.socket.on('student-explicit-offline', (data) => {
        // Fired when student explicitly closes the browser/tab
        const student = state.students.find(s => s.socketId === data.socketId);
        if (student && student.status !== 'Offline') {
            student.status = 'Offline';
            updateStudentList();
            triggerAlert(student, 'went offline', 'gray', true);
            logEvent(`${student.name} went offline (browser closed).`);
        }
    });

    state.socket.on('student-offline', (data) => {
        // Standard socket disconnect (could be internet drop or background kill).
        // We rely on the watchdog for precise Offline vs Phone Off detection.
    });

    state.socket.on('joined-success', (data) => {
        state.isJoined = true;
        getEl('active-status-text').textContent = `Focus Guard Active (Session #${data.pin})`;
        showView('active-view');
        startStudentHeartbeat();
    });
}

// ==========================================
// 8. ALERT SYSTEM
// ==========================================
function triggerAlert(student, message, colorType, withSound = false) {
    const fullMsg = `${student.name} (${student.id}) ${message}`;
    createPopupAlert(student.name, student.id, message, colorType);
    
    // Browser Notifications
    if ("Notification" in window && Notification.permission === "granted") {
        new Notification('SmartClass Alert', { body: fullMsg, icon: '/favicon.ico' });
    }
    
    // Notification Sounds
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

        // D) OFFLINE (Internet loss or long timeout)
        if (secSincePulse > 60) {
            if (student.status !== 'Offline') {
                // Keep phone off and offline as separate states
                // Do NOT convert phone lock into offline immediately
                if (student.status === 'Phone Off' && secSincePulse <= 300) return;
                
                // Do NOT convert switched app into offline immediately
                if (student.status === 'Switched App' && secSincePulse <= 300) return;

                student.status = 'Offline';
                triggerAlert(student, 'went offline', 'gray');
                logEvent(`${student.name} went offline (timeout).`);
                changed = true;
            }
            return;
        }

        // C) PHONE OFF
        // 2 missed heartbeats (heartbeat is 5s, so 10s of silence = Phone Off)
        // DIRECTLY classify as PHONE OFF (if not already switched).
        if (secSincePulse > 10) {
            // --- FIX: Prevent Incorrect Auto Transition ---
            // Do NOT automatically escalate switched app to phone off
            if (student.status === 'Switched App') {
                return; // Keep RED state active continuously
            }

            if (student.status !== 'Phone Off' && student.status !== 'Offline') {
                student.status = 'Phone Off';
                student.hiddenPulseCount = 0; // Reset
                triggerAlert(student, 'turned off the phone', 'green');
                logEvent(`${student.name} turned off the phone.`);
                changed = true;
            }
        }
    });

    // Live updates
    if (changed) updateStudentList();
}, 1000);

// ==========================================
// 10. TEACHER DASHBOARD UI
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
        // STATE COLORS
        let color = '#3b82f6'; // ACTIVE = BLUE
        if (student.status === 'Switched App') color = '#ef4444'; // SWITCHED APP = RED
        if (student.status === 'Phone Off') color = '#10b981'; // PHONE OFF = GREEN
        if (student.status === 'Offline') color = '#9ca3af'; // OFFLINE = GRAY

        // Calculate Session Duration
        const durationMin = Math.floor((Date.now() - student.joinTime) / 60000);
        
        // Calculate Last Seen
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
                        <span class="m-label">Turned On:</span>
                        <span class="m-value">${student.turnOnCount}</span>
                    </div>
                    <div class="metric">
                        <span class="m-label">Switched:</span>
                        <span class="m-value">${student.switchedAppCount}</span>
                    </div>
                    <div class="metric" style="grid-column: span 2;">
                        <span class="m-label">Last Seen:</span>
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

// --- UI Helpers & False Positive Prevention ---
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
    
    // Auto remove after 5 seconds
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
        state.socket.emit('join-room', { pin: state.roomPin, name: state.userName, id: state.userId });
    });

    getEl('theme-toggle')?.addEventListener('click', () => {
        state.theme = state.theme === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', state.theme);
        localStorage.setItem('theme', state.theme);
    });

    // Handle student explicitly closing the browser or tab
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

// 11. MOBILE OPTIMIZATION
async function requestWakeLock() {
    // Keeps teacher screen alive
    if ('wakeLock' in navigator) {
        try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch (err) { }
    }
}
