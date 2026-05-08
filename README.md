# Smart Classroom Monitor 2.0 (Socket.IO Version)

A stable, real-time classroom monitoring platform designed for 100% student focus.

## 🚀 Deployment Instructions (Render)

1. **Push to GitHub**: Create a repository and push all files (including `public`, `server.js`, `package.json`).
2. **Create Web Service on Render**:
   - Go to [Render.com](https://render.com)
   - Click **New +** -> **Web Service**
   - Connect your GitHub repo.
3. **Configure Settings**:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. **Environment Variables**:
   - No special env vars needed, but Ensure `PORT` is allowed (Render handles this automatically).
5. **Click Deploy**.

## 🛠 Features
- **Real-Time Stability**: Powered by Socket.IO for robust connections.
- **Auto-Recovery**: Handles mobile sleep cycles and network flickers.
- **Heartbeat Monitoring**: Distinguishes between phone-locked (Green) and app-switching (Red).
- **OS Notifications**: Get alerts even when the browser is minimized.

## 📁 File Structure
- `server.js`: Node/Express/Socket.IO backend.
- `public/index.html`: Modern tech-minimalist UI.
- `public/script.js`: Real-time client-side logic.
- `public/style.css`: High-end monochrome styling.

## ⚖️ License
MIT
