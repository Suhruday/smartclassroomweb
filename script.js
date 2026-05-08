// Initialize Lucide icons
lucide.createIcons();

// State Management
const state = {
    currentView: 'landing-content',
    roomPin: '000000',
    students: [], // Array of {name, id, status, lastPulse, conn}
    userName: '',
    userId: '',
    peer: null,
    activeConnection: null,
    theme: localStorage.getItem('theme') || 'light',
    heartbeatInterval: null,
    wakeLock: null
};

// Apply Initial Theme
document.documentElement.setAttribute('data-theme', state.theme);

// DOM Elements
const landingContent = document.getElementById('landing-content');
const dashboardContent = document.getElementById('dashboard-content');
const dashboardSections = document.querySelectorAll('.dashboard-section');

// Buttons
const heroBtnTeacher = document.getElementById('hero-btn-teacher');
const navBtnTeacher = document.getElementById('nav-btn-teacher');
const heroBtnStudent = document.getElementById('hero-btn-student');
const navBtnStudent = document.getElementById('nav-btn-student');
const backButtons = document.querySelectorAll('.back-to-landing');

// Teacher Elements
const pinInput = document.getElementById('teacher-pin-input');
const btnRefreshPin = document.getElementById('btn-refresh-pin');
const studentList = document.getElementById('student-list');
const studentCount = document.getElementById('student-count');

// Student Elements
const joinForm = document.getElementById('join-form');
const activeStatusText = document.getElementById('active-status-text');
const alertContainer = document.getElementById('alert-container');

// Navigation Logic
function showDashboardSection(sectionId) {
    // Hide landing content and show dashboard container
    landingContent.classList.add('hidden');
    dashboardContent.classList.remove('hidden');
    
    // Hide all dashboard sections and show the target one
    dashboardSections.forEach(section => {
        section.classList.add('hidden');
        if (section.id === sectionId) {
            section.classList.remove('hidden');
        }
    });
    state.currentView = sectionId;
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetToHome() {
    if (state.peer) state.peer.destroy();
    state.peer = null;
    state.activeConnection = null;
    state.students = [];
    
    dashboardContent.classList.add('hidden');
    landingContent.classList.remove('hidden');
    state.currentView = 'landing-content';
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Event Listeners
heroBtnTeacher?.addEventListener('click', () => {
    generatePin();
    showDashboardSection('teacher-view');
    requestNotificationPermission();
    requestWakeLock();
    initEducatorPeer();
});

navBtnTeacher?.addEventListener('click', () => {
    generatePin();
    showDashboardSection('teacher-view');
    requestNotificationPermission();
    requestWakeLock();
    initEducatorPeer();
});

heroBtnStudent?.addEventListener('click', () => {
    showDashboardSection('student-view');
});

navBtnStudent?.addEventListener('click', () => {
    showDashboardSection('student-view');
});

backButtons.forEach(btn => {
    btn.addEventListener('click', resetToHome);
});

// Educator Logic
function initEducatorPeer() {
    if (state.peer) state.peer.destroy();
    
    state.peer = new Peer('SCM-' + state.roomPin);
    
    state.peer.on('open', (id) => {
        console.log('Dashboard Active. Code:', id);
        // Ensure Wake Lock stays active
        requestWakeLock();
    });

    state.peer.on('disconnected', () => {
        state.peer.reconnect();
    });

    state.peer.on('connection', (conn) => {
        conn.on('data', (data) => {
            handleIncomingData(data, conn);
        });
        
        conn.on('close', () => {
            const student = state.students.find(s => s.conn === conn);
            if (student) {
                // When connection closes, assume they locked the phone (Green)
                student.status = 'Phone Off';
                updateStudentList();
                
                // Be much more patient (5 minutes) before marking as truly Offline
                // This gives mobile devices plenty of time to reconnect
                if (student.offlineTimeout) clearTimeout(student.offlineTimeout);
                student.offlineTimeout = setTimeout(() => {
                    if (student.status === 'Phone Off') {
                        student.status = 'Offline';
                        updateStudentList();
                        sendSystemNotification(`Student Offline`, `${student.name} has left the session.`);
                    }
                }, 300000); // 5 minutes grace period
            }
        });
    });

    state.peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
            alert('This Session Code is already in use. Please generate a new one.');
            resetToHome();
        }
    });
}

function handleIncomingData(data, conn) {
    const student = state.students.find(s => s.id === data.id);

    if (data.type === 'JOIN') {
        const wasOff = student && (student.status === 'Phone Off' || student.status === 'Switched Apps' || student.status === 'Offline');
        
        if (student) {
            student.status = 'Online';
            student.conn = conn;
            student.lastPulse = Date.now();
            student.lastAlertTime = Date.now();
        } else {
            state.students.push({ 
                name: data.name, 
                id: data.id, 
                status: 'Online',
                lastPulse: Date.now(),
                lastAlertTime: Date.now(),
                lastHidden: false,
                conn: conn 
            });
        }
        updateStudentList();
        
        if (wasOff) {
            createPopupAlert(data.name, data.id, 'OPENED');
            sendSystemNotification(`${data.name}, ${data.id}`, `phone is turned on`);
        } else {
            createPopupAlert(data.name, data.id, 'JOINED');
            sendSystemNotification(`Student Joined`, `${data.name} has entered the session.`);
        }
    } else if (data.type === 'HEARTBEAT' || data.type === 'RESUMED') {
        if (student) {
            const now = Date.now();
            const wasOff = student.status === 'Phone Off' || student.status === 'Switched Apps' || student.status === 'Offline';
            student.lastPulse = now;
            student.lastHidden = data.hidden;
            
            // ALWAYS Alert if they explicitly RESUMED or became visible after being hidden
            if (data.type === 'RESUMED' || (!data.hidden && wasOff)) {
                // Throttle alerts to once every 3 seconds per student to avoid double-triggers
                if (!student.lastOnAlert || (now - student.lastOnAlert) > 3000) {
                    student.status = 'Online';
                    student.lastAlertTime = now;
                    student.lastOnAlert = now;
                    updateStudentList();
                    createPopupAlert(data.name, data.id, 'OPENED');
                    sendSystemNotification(`${data.name}, ${data.id}`, `phone is turned on`);
                }
            }
        }
    }
}

// Educator: Monitor Heartbeats
setInterval(() => {
    if (state.currentView !== 'teacher-view') return;
    
    const now = Date.now();
    let changed = false;
    
    state.students.forEach(student => {
        if (student.status === 'Offline') return;

        const secondsSincePulse = (now - student.lastPulse) / 1000;
        const msSinceLastAlert = now - student.lastAlertTime;
        
        // CASE 1: Phone is LOCKED (No pulse for 4+ seconds)
        if (secondsSincePulse > 4) {
            if (student.status !== 'Phone Off') {
                student.status = 'Phone Off';
                student.lastAlertTime = now;
                changed = true;
                createPopupAlert(student.name, student.id, 'CLOSED');
                sendSystemNotification(`${student.name}, ${student.id}`, `phone is turned off`);
            }
        } 
        // CASE 2: Phone is ON but student switched apps (Pulse is fresh, but hidden)
        else if (student.lastHidden && secondsSincePulse <= 4) {
            if (student.status !== 'Switched Apps') {
                student.status = 'Switched Apps';
                student.lastAlertTime = now;
                changed = true;
                createPopupAlert(student.name, student.id, 'SWITCHED');
                sendSystemNotification(`${student.name}, ${student.id}`, `switched app`);
            } else if (msSinceLastAlert > 60000) {
                // Repeat alert every 1 min
                student.lastAlertTime = now;
                createPopupAlert(student.name, student.id, 'SWITCHED');
                sendSystemNotification(`${student.name}, ${student.id}`, `switched app (still active)`);
            }
        }
    });
    
    if (changed) updateStudentList();
}, 2000);

// Student Logic
joinForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('student-name').value;
    const id = document.getElementById('student-id').value;
    const pin = document.getElementById('room-pin').value;

    state.userName = name;
    state.userId = id;
    state.roomPin = pin;

    initStudentPeer(name, id, pin);
});

function initStudentPeer(name, id, pin) {
    if (state.peer && !state.peer.destroyed) {
        state.peer.destroy();
    }
    
    state.peer = new Peer(); 
    
    state.peer.on('open', () => {
        attemptConnection(name, id, pin);
    });

    state.peer.on('error', (err) => {
        console.error('Peer error:', err);
        // If peer itself fails, retry everything
        setTimeout(() => initStudentPeer(name, id, pin), 5000);
    });

    state.peer.on('disconnected', () => {
        state.peer.reconnect();
    });
}

function attemptConnection(name, id, pin) {
    if (!state.peer || state.peer.destroyed) return;

    const conn = state.peer.connect('SCM-' + pin, {
        reliable: true
    });
    state.activeConnection = conn;
    
    activeStatusText.textContent = `Syncing with Educator (Session #${pin})...`;

    // Force a full reset if connection doesn't open within 10s
    const connectionTimeout = setTimeout(() => {
        if (!conn.open) {
            console.log('Connection taking too long, forcing identity reset...');
            initStudentPeer(name, id, pin);
        }
    }, 10000);

    conn.on('open', () => {
        clearTimeout(connectionTimeout);
        // Send initial state immediately
        conn.send({ type: 'JOIN', name, id });
        conn.send({ 
            type: 'HEARTBEAT', 
            name, 
            id,
            hidden: document.hidden
        });

        activeStatusText.textContent = `Monitor Active (Session #${pin})`;
        showDashboardSection('active-view');
        
        // Start Heartbeat
        if (state.heartbeatInterval) clearInterval(state.heartbeatInterval);
        state.heartbeatInterval = setInterval(() => {
            if (state.activeConnection && state.activeConnection.open) {
                state.activeConnection.send({ 
                    type: 'HEARTBEAT', 
                    name: state.userName, 
                    id: state.userId,
                    hidden: document.hidden
                });
            } else {
                // Heartbeat failed, reconnect
                clearInterval(state.heartbeatInterval);
                initStudentPeer(name, id, pin);
            }
        }, 1500); // Slightly slower heartbeat for better battery
    });

    conn.on('error', (err) => {
        clearTimeout(connectionTimeout);
        console.log('Connection error, re-initializing peer...');
        setTimeout(() => initStudentPeer(state.userName, state.userId, state.roomPin), 2000);
    });
    
    conn.on('close', () => {
        clearTimeout(connectionTimeout);
        activeStatusText.textContent = `Searching for Educator...`;
        setTimeout(() => initStudentPeer(state.userName, state.userId, state.roomPin), 2000);
    });
}

// Global Tab Visibility Detection (Flipped for "Focus" mode)
document.addEventListener('visibilitychange', () => {
    if (state.currentView === 'active-view' && state.activeConnection) {
        if (!document.hidden) {
            // Student unlocked or switched back - SEND INSTANT ALERT
            state.activeConnection.send({ 
                type: 'RESUMED',
                name: state.userName, 
                id: state.userId,
                hidden: false
            });
        } else {
            // Student locked or switched away
            state.activeConnection.send({ 
                type: 'VISIBILITY_CHANGE',
                name: state.userName, 
                id: state.userId, 
                hidden: true
            });
        }
    } else if (state.currentView === 'teacher-view') {
        if (!document.hidden) {
            // Teacher returned to tab or woke up computer
            console.log('Teacher view resumed, checking session...');
            requestWakeLock();
            if (state.peer && state.peer.disconnected) {
                state.peer.reconnect();
            } else if (!state.peer || state.peer.destroyed) {
                initEducatorPeer();
            }
        }
    }
});

// Network Status Detection
window.addEventListener('online', () => {
    if (state.currentView === 'teacher-view') initEducatorPeer();
    if (state.currentView === 'active-view') initStudentPeer(state.userName, state.userId, state.roomPin);
});

// UI Helpers
function generatePin() {
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    state.roomPin = pin;
    if (pinInput) pinInput.value = pin;
}

if (pinInput) {
    pinInput.addEventListener('input', (e) => {
        state.roomPin = e.target.value;
    });
}

if (btnRefreshPin) {
    btnRefreshPin.addEventListener('click', () => {
        generatePin();
        if (state.currentView === 'teacher-view') initEducatorPeer();
    });
}

function updateStudentList() {
    if (!studentList) return;
    if (state.students.length === 0) {
        studentList.innerHTML = '<li class="empty-state">Waiting for students...</li>';
        studentCount.textContent = '0';
        return;
    }

    studentCount.textContent = state.students.length;
    studentList.innerHTML = state.students.map(student => {
        let badgeColor = '#ef4444'; // Red (On/Switched)
        let badgeBg = 'rgba(239, 68, 68, 0.1)';
        
        if (student.status === 'Phone Off') {
            badgeColor = '#10b981'; // Green
            badgeBg = 'rgba(16, 185, 129, 0.1)';
        } else if (student.status === 'Offline') {
            badgeColor = '#64748b'; // Gray
            badgeBg = 'rgba(100, 116, 139, 0.1)';
        }

        return `
            <li class="student-item">
                <div class="student-info">
                    <span class="student-name" style="font-weight: 600; font-size: 1.1rem; display: block;">${student.name}</span>
                    <span class="student-id-tag" style="font-size: 0.8rem; color: var(--text-muted);">ID: ${student.id}</span>
                </div>
                <span class="status-badge" style="background: ${badgeBg}; color: ${badgeColor}; padding: 0.4rem 0.8rem; border-radius: 6px; font-size: 0.75rem; font-weight: 700;">
                    ${student.status}
                </span>
            </li>
        `;
    }).join('');
}

function createPopupAlert(name, id, type) {
    if (state.currentView !== 'teacher-view') return;

    const toast = document.createElement('div');
    let typeClass = (type === 'OPENED' || type === 'SWITCHED' || type === 'OFFLINE') ? 'opened' : 'closed';
    let statusText = type === 'OPENED' ? `phone is turned on` : 
                    (type === 'SWITCHED' ? 'switched app' : 
                    (type === 'JOINED' ? 'JOINED' : 
                    (type === 'OFFLINE' ? 'is OFFLINE' : 'phone is turned off')));
    
    let statusColor = (type === 'OPENED' || type === 'SWITCHED' || type === 'OFFLINE') ? 'red' : 'green';
    let icon = type === 'OPENED' ? 'smartphone' : 
               (type === 'SWITCHED' ? 'layers' : 
               (type === 'JOINED' ? 'user-plus' : 
               (type === 'OFFLINE' ? 'wifi-off' : 'smartphone-off')));

    toast.className = `alert-toast ${typeClass}`;
    toast.innerHTML = `
        <div class="alert-icon"><i data-lucide="${icon}"></i></div>
        <div class="alert-content">
            <h4>${name}, ${id}</h4>
            <p class="alert-status ${statusColor}">${statusText}</p>
        </div>
    `;
    alertContainer.appendChild(toast);
    lucide.createIcons();
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(50px)';
        setTimeout(() => toast.remove(), 500);
    }, 5000);
}

// Theme Toggle Logic
const themeToggle = document.getElementById('theme-toggle');
themeToggle?.addEventListener('click', () => {
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', state.theme);
    localStorage.setItem('theme', state.theme);
    
    // Update Icon
    const icon = themeToggle.querySelector('i');
    if (icon) {
        icon.setAttribute('data-lucide', state.theme === 'light' ? 'moon' : 'sun');
        lucide.createIcons();
    }
});
function requestNotificationPermission() {
    if ("Notification" in window) {
        Notification.requestPermission();
    }
}

function sendSystemNotification(title, body) {
    if ("Notification" in window && Notification.permission === "granted") {
        new Notification(title, { 
            body: body,
            icon: '/favicon.ico' // Or a custom icon path
        });
    }
}

async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            state.wakeLock = await navigator.wakeLock.request('screen');
            console.log('Wake Lock active: System will not sleep.');
        } catch (err) {
            console.error(`${err.name}, ${err.message}`);
        }
    }
}
