const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Store rooms and their current states
const rooms = {};

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    // --- Teacher: Create Room ---
    socket.on('create-room', (pin) => {
        rooms[pin] = {
            teacherId: socket.id,
            students: {}
        };
        socket.join(pin);
        console.log(`Room ${pin} created by teacher ${socket.id}`);
    });

    // --- Student: Join Room ---
    socket.on('join-room', ({ pin, name, id }) => {
        if (!rooms[pin]) {
            return socket.emit('error-msg', 'Room not found.');
        }

        // Register student in the room object
        rooms[pin].students[socket.id] = { name, id, status: 'Active' };
        socket.join(pin);
        
        // Notify Teacher
        io.to(rooms[pin].teacherId).emit('student-status-broadcast', {
            socketId: socket.id,
            name,
            id,
            status: 'Active'
        });

        socket.emit('joined-success', { pin });
        console.log(`Student ${name} joined room ${pin}`);
    });

    // --- Activity & Status Updates ---
    socket.on('status-update', ({ pin, status }) => {
        if (rooms[pin] && rooms[pin].students[socket.id]) {
            const student = rooms[pin].students[socket.id];
            student.status = status;

            // Broadcast to teacher
            io.to(rooms[pin].teacherId).emit('student-status-broadcast', {
                socketId: socket.id,
                name: student.name,
                id: student.id,
                status: status
            });
        }
    });

    // --- Heartbeat Logic ---
    socket.on('heartbeat', ({ pin, status }) => {
        if (rooms[pin] && rooms[pin].students[socket.id]) {
            const student = rooms[pin].students[socket.id];
            
            // Keep heartbeat simple, just forward status to teacher to verify life
            io.to(rooms[pin].teacherId).emit('student-status-broadcast', {
                socketId: socket.id,
                name: student.name,
                id: student.id,
                status: status
            });
        }
    });

    // --- Visibility Change (Legacy support for fast detection) ---
    socket.on('visibility-change', ({ pin, hidden }) => {
        if (rooms[pin] && rooms[pin].students[socket.id]) {
            const student = rooms[pin].students[socket.id];
            const newStatus = hidden ? 'Background' : 'Active';
            student.status = newStatus;

            io.to(rooms[pin].teacherId).emit('student-status-broadcast', {
                socketId: socket.id,
                name: student.name,
                id: student.id,
                status: newStatus
            });
        }
    });

    socket.on('student-resumed', ({ pin }) => {
        if (rooms[pin] && rooms[pin].students[socket.id]) {
            const student = rooms[pin].students[socket.id];
            student.status = 'Active';

            io.to(rooms[pin].teacherId).emit('student-status-broadcast', {
                socketId: socket.id,
                name: student.name,
                id: student.id,
                status: 'Active'
            });
        }
    });

    // --- Disconnect Logic ---
    socket.on('disconnect', () => {
        // Clean up if it was a teacher
        for (const pin in rooms) {
            if (rooms[pin].teacherId === socket.id) {
                io.to(pin).emit('teacher-disconnected');
                delete rooms[pin];
                break;
            }

            // Notify if it was a student
            if (rooms[pin].students[socket.id]) {
                io.to(rooms[pin].teacherId).emit('student-disconnected', {
                    socketId: socket.id
                });
                delete rooms[pin].students[socket.id];
                break;
            }
        }
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
