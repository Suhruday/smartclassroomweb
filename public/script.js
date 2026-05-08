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

// DOM Elements
const landingContent = document.getElementById('landing-content');
const teacherView = document.getElementById('teacher-view');
const studentJoinView = document.getElementById('student-join-view');
const activeView = document.getElementById('active-view');
const btnCreateClass = document.getElementById('btn-create-class');
const btnJoinClass = document.getElementById('btn-join-class');
const joinForm = document.getElementById('join-form');
const pinInput = document.getElementById('room-pin');
const btnRefreshPin = document.getElementById('btn-refresh-pin');
const studentList = document.getElementById('student-list');
const studentCount = document.getElementById('student-count');
const alertContainer = document.getElementById('alert-container');
const activeStatusText = document.getElementById('active-status-text');

// Initialize Socket.IO
state.socket = io();

// Apply Initial Theme
document.documentElement.setAttribute('data-theme', state.theme);
const initialIcon = document.getElementById('theme-toggle')?.querySelector('i');
if (initialIcon) {
    initialIcon.setAttribute('data-lucide', state.theme === 'light' ? 'moon' : 'sun');
}
lucide.createIcons();

// View Management
function showDashboardSection(sectionId) {
    document.querySelectorAll('.dashboard-section').forEach(section => {
        section.classList.add('hidden');
    });
    document.getElementById(sectionId).classList.remove('hidden');
    state.currentView = sectionId;
}

function resetToHome() {
    showDashboardSection('landing-content');
    if (state.heartbeatInterval) clearInterval(state.heartbeatInterval);
}

// Event Listeners for Navigation
btnCreateClass?.addEventListener('click', () => {
    generatePin();
    showDashboardSection('teacher-view');
    requestNotificationPermission();
    requestWakeLock();
    initTeacherEvents();
});

btnJoinClass?.addEventListener('click', () => {
    showDashboardSection('student-join-view');
});

document.querySelectorAll('.back-to-landing').forEach(btn => {
    btn.addEventListener('click', () => {
        location.reload(); // Hard reset for clean state
    });
});

// --- Teacher Logic ---
function initTeacherEvents() {
    state.socket.emit('create-room', state.roomPin);

    state.socket.on('student-joined', (data) => {
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
        sendSystemNotification(`Student Joined`, `${data.name} has entered the session.`);
    });

    state.socket.on('student-heartbeat', (data) => {
        const student = state.students.find(s => s.socketId === data.socketId);
        if (student) {
            student.lastPulse = Date.now();
            student.lastHidden = data.hidden;
            
            // If they returned to the page
            if (!data.hidden && (student.status === 'Phone Off' || student.status === 'Switched Apps')) {
                handleStudentReturn(student);
            }
        }
    });

    state.socket.on('student-visibility-change', (data) => {
        const student = state.students.find(s => s.socketId === data.socketId);
        if (student && !data.hidden && (student.status === 'Phone Off' || student.status === 'Switched Apps')) {
            handleStudentReturn(student);
        }
    });

    state.socket.on('student-resumed', (data) => {
        const student = state.students.find(s => s.socketId === data.socketId);
        if (student) handleStudentReturn(student);
    });

    state.socket.on('student-left', (data) => {
        const student = state.students.find(s => s.socketId === data.socketId);
        if (student) {
            student.status = 'Phone Off'; // Assume locked/off first
            updateStudentList();
            
            // Wait 5 mins before marking as Offline
            if (student.offlineTimeout) clearTimeout(student.offlineTimeout);
            student.offlineTimeout = setTimeout(() => {
                if (student.status === 'Phone Off') {
                    student.status = 'Offline';
                    updateStudentList();
                    sendSystemNotification(`Student Offline`, `${student.name} has left the session.`);
                }
            }, 300000);
        }
    });
}

function handleStudentReturn(student) {
    const now = Date.now();
    if (!student.lastOnAlert || (now - student.lastOnAlert) > 3000) {
        student.status = 'Online';
        student.lastAlertTime = now;
        student.lastOnAlert = now;
        updateStudentList();
        createPopupAlert(student.name, student.id, 'OPENED');
        sendSystemNotification(`${student.name}, ${student.id}`, `phone is turned on`);
    }
}

// Teacher Monitor Loop
setInterval(() => {
    if (state.currentView !== 'teacher-view') return;
    const now = Date.now();
    let changed = false;

    state.students.forEach(student => {
        if (student.status === 'Offline') return;
        const secondsSincePulse = (now - student.lastPulse) / 1000;
        const msSinceLastAlert = now - student.lastAlertTime;

        if (secondsSincePulse > 4) {
            if (student.status !== 'Phone Off') {
                student.status = 'Phone Off';
                student.lastAlertTime = now;
                changed = true;
                createPopupAlert(student.name, student.id, 'CLOSED');
                sendSystemNotification(`${student.name}, ${student.id}`, `phone is turned off`);
            }
        } else if (student.lastHidden && secondsSincePulse <= 4) {
            if (student.status !== 'Switched Apps') {
                student.status = 'Switched Apps';
                student.lastAlertTime = now;
                changed = true;
                createPopupAlert(student.name, student.id, 'SWITCHED');
                sendSystemNotification(`${student.name}, ${student.id}`, `switched app`);
            } else if (msSinceLastAlert > 60000) {
                student.lastAlertTime = now;
                createPopupAlert(student.name, student.id, 'SWITCHED');
                sendSystemNotification(`${student.name}, ${student.id}`, `switched app (still active)`);
            }
        }
    });
    if (changed) updateStudentList();
}, 2000);

// --- Student Logic ---
joinForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('student-name').value;
    const id = document.getElementById('student-id').value;
    const pin = document.getElementById('room-pin').value;

    state.userName = name;
    state.userId = id;
    state.roomPin = pin;

    state.socket.emit('join-room', { pin, name, id });
});

state.socket.on('joined-success', (data) => {
    activeStatusText.textContent = `Monitor Active (Session #${data.pin})`;
    showDashboardSection('active-view');
    
    // Start Heartbeat
    if (state.heartbeatInterval) clearInterval(state.heartbeatInterval);
    state.heartbeatInterval = setInterval(() => {
        state.socket.emit('heartbeat', { pin: state.roomPin, hidden: document.hidden });
    }, 1500);
});

state.socket.on('error-msg', (msg) => {
    alert(msg);
});

state.socket.on('teacher-disconnected', () => {
    alert('The educator has ended the session.');
    location.reload();
});

// Student Visibility Detection
document.addEventListener('visibilitychange', () => {
    if (state.currentView !== 'active-view') return;
    
    state.socket.emit('visibility-change', {
        pin: state.roomPin,
        hidden: document.hidden
    });

    if (!document.hidden) {
        state.socket.emit('student-resumed', { pin: state.roomPin });
    }
});

// UI Helpers
function generatePin() {
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    state.roomPin = pin;
    if (pinInput) pinInput.value = pin;
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
        let badgeColor = '#ef4444'; // Red
        let badgeBg = 'rgba(239, 68, 68, 0.1)';
        
        if (student.status === 'Phone Off') {
            badgeColor = '#10b981'; // Green
            badgeBg = 'rgba(16, 185, 129, 0.1)';
        } else if (student.status === 'Offline') {
            badgeColor = '#64748b'; // Gray
            badgeBg = 'rgba(100, 116, 139, 0.1)';
        }

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
    const icon = themeToggle.querySelector('i');
    if (icon) {
        icon.setAttribute('data-lucide', state.theme === 'light' ? 'moon' : 'sun');
        lucide.createIcons();
    }
});

function requestNotificationPermission() {
    if ("Notification" in window) Notification.requestPermission();
}

function sendSystemNotification(title, body) {
    if ("Notification" in window && Notification.permission === "granted") {
        new Notification(title, { body: body, icon: '/favicon.ico' });
    }
}

async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            state.wakeLock = await navigator.wakeLock.request('screen');
        } catch (err) {
            console.error(`${err.name}, ${err.message}`);
        }
    }
}
