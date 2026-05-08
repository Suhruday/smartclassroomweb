const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

io.on('connection', (socket) => {
    // Teacher: Create
    socket.on('create-room', (pin) => {
        rooms[pin] = { teacherId: socket.id, students: {} };
        socket.join(pin);
    });

    // Student: Join
    socket.on('join-room', ({ pin, name, id }) => {
        if (!rooms[pin]) return socket.emit('error-msg', 'Room not found.');
        rooms[pin].students[socket.id] = { name, id };
        socket.join(pin);
        io.to(rooms[pin].teacherId).emit('student-pulse', {
            socketId: socket.id, name, id, hidden: false, idle: false
        });
        socket.emit('joined-success', { pin });
    });

    // Activity Updates
    socket.on('heartbeat', ({ pin, hidden, idle }) => {
        if (rooms[pin]) {
            const student = rooms[pin].students[socket.id];
            if (student) {
                io.to(rooms[pin].teacherId).emit('student-pulse', {
                    socketId: socket.id,
                    name: student.name,
                    id: student.id,
                    hidden,
                    idle
                });
            }
        }
    });

    socket.on('visibility-status', ({ pin, hidden }) => {
        if (rooms[pin]) {
            io.to(rooms[pin].teacherId).emit('student-visibility-update', {
                socketId: socket.id,
                hidden
            });
        }
    });

    socket.on('disconnect', () => {
        for (const pin in rooms) {
            if (rooms[pin].teacherId === socket.id) {
                io.to(pin).emit('teacher-disconnected');
                delete rooms[pin];
                break;
            }
            if (rooms[pin].students[socket.id]) {
                io.to(rooms[pin].teacherId).emit('student-offline', {
                    socketId: socket.id
                });
                delete rooms[pin].students[socket.id];
                break;
            }
        }
    });
});

server.listen(PORT, () => console.log(`Server on ${PORT}`));
