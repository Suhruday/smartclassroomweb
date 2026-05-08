// Application State
const state = {
    currentView: 'landing-content',
    roomPin: '000000',
    students: [], // {socketId, name, id, status, lastPulse, lastHidden, lastChange, alertCooldown}
    userName: '',
    userId: '',
    socket: null,
    theme: localStorage.getItem('theme') || 'light',
    heartbeatInterval: null,
    wakeLock: null,
    soundEnabled: true,
    lastInteraction: Date.now()
};

const getEl = (id) => document.getElementById(id);

// Initialization
document.addEventListener('DOMContentLoaded', () => {
    state.socket = io(window.location.origin, {
        reconnection: true,
        reconnectionDelay: 1000
    });

    document.documentElement.setAttribute('data-theme', state.theme);
    if (window.lucide) lucide.createIcons();

    setupEventListeners();
    setupSocketListeners();
    setupStudentActivity();
});

// --- Student Activity Monitoring ---
function setupStudentActivity() {
    const reportVisibility = () => {
        if (state.currentView === 'active-view') {
            state.socket.emit('visibility-status', { 
                pin: state.roomPin, 
                hidden: document.hidden 
            });
        }
    };
    document.addEventListener('visibilitychange', reportVisibility);
    window.addEventListener('focus', reportVisibility);
    window.addEventListener('blur', reportVisibility);

    // Interaction tracking
    ['mousemove', 'keydown', 'click', 'touchstart'].forEach(evt => {
        window.addEventListener(evt, () => {
            state.lastInteraction = Date.now();
        }, { passive: true });
    });
}

function startHeartbeat() {
    if (state.heartbeatInterval) clearInterval(state.heartbeatInterval);
    state.heartbeatInterval = setInterval(() => {
        if (state.socket && state.socket.connected) {
            state.socket.emit('heartbeat', {
                pin: state.roomPin,
                hidden: document.hidden,
                idle: (Date.now() - state.lastInteraction > 60000)
            });
        }
    }, 5000); // 5s heartbeat
}

// --- Socket Listeners ---
function setupSocketListeners() {
    // Teacher: Receive student updates
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
                lastChange: Date.now(),
                alertCooldown: 0
            };
            state.students.push(student);
            createPopupAlert(student.name, student.id, 'JOINED');
            playSound('join');
        } else {
            student.socketId = data.socketId;
            student.lastPulse = Date.now();
            student.lastHidden = data.hidden;
            student.idle = data.idle;
        }
        updateStudentList();
    });

    state.socket.on('student-visibility-update', (data) => {
        const student = state.students.find(s => s.socketId === data.socketId);
        if (student) {
            student.lastHidden = data.hidden;
            student.lastPulse = Date.now();
            // Fast detection handled by monitor loop
        }
    });

    state.socket.on('student-offline', (data) => {
        const student = state.students.find(s => s.socketId === data.socketId);
        if (student) {
            student.status = 'Offline';
            student.lastChange = Date.now();
            updateStudentList();
            createPopupAlert(student.name, student.id, 'OFFLINE');
            playSound('alert');
        }
    });

    // Student: Joined success
    state.socket.on('joined-success', (data) => {
        getEl('active-status-text').textContent = `Focus Guard Active (Session #${data.pin})`;
        showView('active-view');
        startHeartbeat();
    });

    state.socket.on('teacher-disconnected', () => {
        alert('Teacher ended the session.');
        location.reload();
    });
}

// --- Teacher Monitor Loop (The Intelligent Brain) ---
setInterval(() => {
    if (state.currentView !== 'teacher-view') return;
    const now = Date.now();
    let changed = false;

    state.students.forEach(student => {
        if (student.status === 'Offline') return;

        const secSincePulse = (now - student.lastPulse) / 1000;
        let newStatus = student.status;

        // 1. Check for Disconnection (No pulse for 15s)
        if (secSincePulse > 15) {
            newStatus = 'Screen Locked'; 
        } 
        // 2. Check for App Switching (Pulse IS fresh, but hidden)
        else if (student.lastHidden && secSincePulse <= 8) {
            // Debounce: Wait at least 8s before confirming background app
            // This prevents false positives during phone locks
            if (now - student.lastPulse < 2000) { // If pings are still arriving while hidden
                 newStatus = 'Background App';
            }
        }
        // 3. Check for Idle
        else if (student.idle) {
            newStatus = 'Idle';
        }
        // 4. Back to Active
        else if (!student.lastHidden && secSincePulse < 10) {
            newStatus = 'Active';
        }

        // Apply state change with debounce
        if (newStatus !== student.status) {
            // Only update if it's been in this state for a moment (prevent flicker)
            student.status = newStatus;
            student.lastChange = now;
            changed = true;
            
            // Trigger alerts for major switches
            if (now - student.alertCooldown > 10000) { // 10s alert cooldown per student
                if (newStatus === 'Background App') {
                    createPopupAlert(student.name, student.id, 'SWITCHED');
                    playSound('alert');
                } else if (newStatus === 'Active') {
                    createPopupAlert(student.name, student.id, 'OPENED');
                }
                student.alertCooldown = now;
            }
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
        const timeStr = new Date(student.lastPulse).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        let color = '#10b981'; // Green
        if (student.status === 'Background App' || student.status === 'Screen Locked') color = '#f59e0b'; // Yellow
        if (student.status === 'Offline') color = '#64748b'; // Gray

        return `
            <li>
                <div class="student-info">
                    <span class="student-name">${student.name}</span>
                    <span class="student-id">Last Pulse: ${timeStr}</span>
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

    const config = {
        JOINED: { text: 'joined session', color: 'green', icon: 'user-plus' },
        OPENED: { text: 'returned to class', color: 'green', icon: 'zap' },
        SWITCHED: { text: 'switched app', color: 'red', icon: 'layers' },
        OFFLINE: { text: 'went offline', color: 'red', icon: 'wifi-off' }
    };
    const c = config[type] || config.JOINED;

    const toast = document.createElement('div');
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

// Sound Helper
function playSound(type) {
    if (!state.soundEnabled) return;
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();

        oscillator.type = type === 'join' ? 'sine' : 'triangle';
        oscillator.frequency.setValueAtTime(type === 'join' ? 880 : 440, audioCtx.currentTime);
        gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);

        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);

        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.1);
    } catch (e) {}
}

function setupEventListeners() {
    const tBtns = [getEl('hero-btn-teacher'), getEl('nav-btn-teacher')];
    tBtns.forEach(b => b?.addEventListener('click', () => {
        generatePin();
        showView('teacher-view');
        state.socket.emit('create-room', state.roomPin);
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
