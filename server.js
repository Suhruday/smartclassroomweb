const express = require('express');
const path = require('path');

const app = express();

// Serve static files from the current directory
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 SmartClass Website running!`);
    console.log(`-----------------------------------`);
    console.log(`Local Access: http://localhost:${PORT}`);
    console.log(`Network Access: http://YOUR_IP_ADDRESS:${PORT}`);
    console.log(`-----------------------------------\n`);
});
