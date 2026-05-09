const assert = require('assert');

let student = {
    status: 'Active',
    lastPulse: Date.now() - 11000, // 11 seconds ago
    hiddenPulseCount: 2
};

let secSincePulse = (Date.now() - student.lastPulse) / 1000;

if (secSincePulse > 10) {
    if (student.status === 'Switched App' || student.status === 'Offline') {
        console.log("Returned early");
    } else if (student.status !== 'Phone Off') {
        student.status = 'Phone Off';
        student.hiddenPulseCount = 0;
        console.log("Triggered Phone Off!");
    }
}
console.log("Final status:", student.status);
