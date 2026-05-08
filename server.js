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

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// In-memory store for active rooms and students
// structure: { roomPin: { teacherSocketId: string, students: { socketId: { name, id, status, lastPulse } } } }
const rooms = {};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // --- Teacher Actions ---
    socket.on('create-room', (pin) => {
        rooms[pin] = {
            teacherSocketId: socket.id,
            students: {}
        };
        socket.join(pin);
        console.log(`Room created: ${pin} by ${socket.id}`);
    });

    // --- Student Actions ---
    socket.on('join-room', ({ pin, name, id }) => {
        if (!rooms[pin]) {
            return socket.emit('error-msg', 'Invalid Room Code. Please check and try again.');
        }

        // Check for duplicate Student ID in this room
        const isDuplicate = Object.values(rooms[pin].students).some(s => s.id === id);
        if (isDuplicate) {
            return socket.emit('error-msg', 'A student with this ID is already in the room.');
        }

        // Register student
        rooms[pin].students[socket.id] = {
            name,
            id,
            status: 'Online',
            lastPulse: Date.now()
        };

        socket.join(pin);
        console.log(`Student ${name} (${id}) joined room ${pin}`);

        // Notify teacher
        io.to(rooms[pin].teacherSocketId).emit('student-joined', {
            socketId: socket.id,
            name,
            id
        });

        socket.emit('joined-success', { pin });
    });

    // --- Heartbeat Logic ---
    socket.on('heartbeat', ({ pin, hidden }) => {
        if (rooms[pin] && rooms[pin].students[socket.id]) {
            const student = rooms[pin].students[socket.id];
            student.lastPulse = Date.now();
            student.lastHidden = hidden;

            // Forward to teacher
            io.to(rooms[pin].teacherSocketId).emit('student-heartbeat', {
                socketId: socket.id,
                hidden: hidden
            });
        }
    });

    // --- Manual Visibility Change (Fast updates) ---
    socket.on('visibility-change', ({ pin, hidden }) => {
        if (rooms[pin] && rooms[pin].students[socket.id]) {
            io.to(rooms[pin].teacherSocketId).emit('student-visibility-change', {
                socketId: socket.id,
                hidden: hidden
            });
        }
    });

    // --- Resume Event ---
    socket.on('student-resumed', ({ pin }) => {
        if (rooms[pin] && rooms[pin].students[socket.id]) {
            io.to(rooms[pin].teacherSocketId).emit('student-resumed', {
                socketId: socket.id
            });
        }
    });

    // --- Disconnection Handling ---
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        // Find if this was a teacher
        for (const pin in rooms) {
            if (rooms[pin].teacherSocketId === socket.id) {
                // Notify all students in this room
                io.to(pin).emit('teacher-disconnected');
                delete rooms[pin];
                console.log(`Room ${pin} closed (teacher disconnected)`);
                break;
            }

            // Find if this was a student
            if (rooms[pin].students[socket.id]) {
                const student = rooms[pin].students[socket.id];
                io.to(rooms[pin].teacherSocketId).emit('student-left', {
                    socketId: socket.id,
                    name: student.name,
                    id: student.id
                });
                delete rooms[pin].students[socket.id];
                break;
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
