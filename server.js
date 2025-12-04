require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const sharp = require('sharp');

// --- CONNEXION MONGODB ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Connecté à MongoDB'))
    .catch(err => console.error('❌ Erreur MongoDB:', err));

// --- MODÈLE UTILISATEUR COMPLET ---
const UserSchema = new mongoose.Schema({
    pseudo: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    tagsInflicted: { type: Number, default: 0 },
    timesTagged: { type: Number, default: 0 },
    gamesJoined: { type: Number, default: 0 },
    distanceTraveled: { type: Number, default: 0 },
    backgroundsChanged: { type: Number, default: 0 },
    currentSkin: { type: String, default: null }
});
const User = mongoose.model('User', UserSchema);

const io = require('socket.io')(http, { maxHttpBufferSize: 5 * 1024 * 1024 });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- VARIABLES JEU ---
let players = {};
let currentBackground = null; 
let wolfId = null; 

const API_USER = process.env.SIGHTENGINE_USER; 
const API_SECRET = process.env.SIGHTENGINE_SECRET;
const API_URL = 'https://api.sightengine.com/1.0/check.json';
const BLOCKED_IMG = "https://i.redd.it/58qnz74nf5j41.png";

let uploadCooldowns = {}; 
const COOLDOWN_NORMAL = 15000;
const COOLDOWN_PENALTY = 60000;
let lastTagTime = 0;
const TAG_COOLDOWN = 1000; 
let lastWolfMoveTime = Date.now();

// --- ROUTES AUTHENTIFICATION ---
app.post('/api/register', async (req, res) => {
    const { pseudo, password } = req.body;
    if (!pseudo || !password) return res.json({ success: false, message: "Champs manquants." });
    if (pseudo.length > 12) return res.json({ success: false, message: "Pseudo trop long." });

    try {
        const existingUser = await User.findOne({ pseudo: { $regex: new RegExp(`^${pseudo}$`, 'i') } });
        if (existingUser) return res.json({ success: false, message: "Pseudo pris." });
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ pseudo, password: hashedPassword });
        await newUser.save();
        res.json({ success: true });
    } catch (error) { res.json({ success: false, message: "Erreur serveur." }); }
});

app.post('/api/login', async (req, res) => {
    const { pseudo, password } = req.body;
    try {
        const user = await User.findOne({ pseudo: { $regex: new RegExp(`^${pseudo}$`, 'i') } });
        if (!user) return res.json({ success: false, message: "Utilisateur inconnu." });
        const match = await bcrypt.compare(password, user.password);
        if (match) res.json({ success: true, pseudo: user.pseudo });
        else res.json({ success: false, message: "Mot de passe incorrect." });
    } catch (error) { res.json({ success: false, message: "Erreur serveur." }); }
});

app.get('/api/stats/:pseudo', async (req, res) => {
    try {
        const user = await User.findOne({ pseudo: req.params.pseudo });
        if (!user) return res.json({ success: false });
        const ratio = user.timesTagged === 0 ? user.tagsInflicted : (user.tagsInflicted / user.timesTagged).toFixed(2);
        res.json({
            success: true,
            stats: { ...user.toObject(), ratio: ratio, distanceTraveled: Math.round(user.distanceTraveled || 0) }
        });
    } catch (e) { res.json({ success: false }); }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const hunters = await User.find().sort({ tagsInflicted: -1 }).limit(10).select('pseudo tagsInflicted');
        const travelers = await User.find().sort({ distanceTraveled: -1 }).limit(10).select('pseudo distanceTraveled');
        res.json({ success: true, hunters, travelers });
    } catch (e) { res.json({ success: false }); }
});

// --- HELPER: RETIRER JOUEUR DU JEU ---
async function removePlayerFromGame(socketId) {
    if (players[socketId]) {
        const p = players[socketId];
        // Sauvegarde distance
        if (p.pendingDistance > 0 && p.pseudo !== "Invité" && !p.pseudo.startsWith("Cube")) {
            await User.updateOne({ pseudo: p.pseudo }, { $inc: { distanceTraveled: Math.round(p.pendingDistance) } });
        }

        delete players[socketId];
        io.emit('playerDisconnected', socketId); // Retire le cube visuellement pour tout le monde

        // Gestion Loup
        if (socketId === wolfId) {
            const ids = Object.keys(players);
            if (ids.length > 0) {
                wolfId = ids[Math.floor(Math.random() * ids.length)];
                io.emit('updateWolf', wolfId);
                lastWolfMoveTime = Date.now();
            } else {
                wolfId = null;
                io.emit('updateWolf', null);
            }
        }
    }
}

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    console.log('Nouveau socket : ' + socket.id);

    // Envoi de l'état actuel (pour le fond flouté du lobby)
    socket.emit('currentPlayers', players);
    socket.emit('updateWolf', wolfId);
    if (currentBackground) socket.emit('updateBackground', currentBackground);

    socket.on('joinGame', async (pseudoSent) => {
        // Si déjà en jeu, on ignore ou on reset
        if(players[socket.id]) return;

        let finalPseudo = "Invité";
        let userColor = '#' + Math.floor(Math.random()*16777215).toString(16);

        if (pseudoSent && typeof pseudoSent === 'string' && pseudoSent.trim().length > 0) {
            finalPseudo = pseudoSent.trim().substring(0, 12);
        } else {
            finalPseudo = "Cube" + Math.floor(Math.random() * 1000);
        }

        const isRegistered = finalPseudo !== "Invité" && !finalPseudo.startsWith("Cube");
        if (isRegistered) {
            try {
                const user = await User.findOne({ pseudo: finalPseudo });
                if (user) {
                    if (user.currentSkin) userColor = user.currentSkin; 
                    await User.updateOne({ pseudo: finalPseudo }, { $inc: { gamesJoined: 1 } });
                }
            } catch (err) { console.error("Erreur chargement user:", err); }
        }

        players[socket.id] = {
            x: Math.floor(Math.random() * 500) + 50,
            y: Math.floor(Math.random() * 400) + 50,
            color: userColor,
            pseudo: finalPseudo,
            pendingDistance: 0
        };

        if (!wolfId) {
            wolfId = socket.id;
            lastWolfMoveTime = Date.now();
            io.emit('updateWolf', wolfId);
        }

        // Le joueur entre officiellement sur le terrain
        socket.emit('gameJoined', { id: socket.id, info: players[socket.id] });
        socket.broadcast.emit('newPlayer', { playerId: socket.id, playerInfo: players[socket.id] });
    });

    // Permet de quitter le jeu (retour lobby) sans déconnecter le socket
    socket.on('leaveGame', async () => {
        await removePlayerFromGame(socket.id);
    });

    socket.on('playerMovement', (movementData) => {
        if (players[socket.id]) {
            const p = players[socket.id];
            const dx = movementData.x - p.x;
            const dy = movementData.y - p.y;
            const dist = Math.sqrt(dx*dx + dy*dy);
            if (!p.pendingDistance) p.pendingDistance = 0;
            p.pendingDistance += dist;
            p.x = movementData.x;
            p.y = movementData.y;
            if (socket.id === wolfId) lastWolfMoveTime = Date.now();
            socket.broadcast.emit('playerMoved', { playerId: socket.id, x: p.x, y: p.y });
        }
    });

    socket.on('tagPlayer', (targetId) => {
        if (socket.id === wolfId && players[targetId]) {
            const now = Date.now();
            const wolf = players[socket.id];
            const target = players[targetId];
            const dx = Math.abs(wolf.x - target.x);
            const dy = Math.abs(wolf.y - target.y);

            if (dx < 90 && dy < 90) {
                if (now - lastTagTime > TAG_COOLDOWN) {
                    wolfId = targetId;
                    lastTagTime = now;
                    lastWolfMoveTime = Date.now(); 
                    io.emit('updateWolf', wolfId);
                    io.emit('playerTagged', { x: target.x + 25, y: target.y + 25, color: target.color });

                    const wolfPseudo = wolf.pseudo;
                    const targetPseudo = target.pseudo;
                    if (wolfPseudo !== "Invité" && !wolfPseudo.startsWith("Cube")) {
                        User.updateOne({ pseudo: wolfPseudo }, { $inc: { tagsInflicted: 1 } }).exec();
                    }
                    if (targetPseudo !== "Invité" && !targetPseudo.startsWith("Cube")) {
                        User.updateOne({ pseudo: targetPseudo }, { $inc: { timesTagged: 1 } }).exec();
                    }
                }
            }
        }
    });

    socket.on('changeBackground', async (imageData) => {
        const now = Date.now();
        if (uploadCooldowns[socket.id] && now < uploadCooldowns[socket.id]) {
            const timeLeft = Math.ceil((uploadCooldowns[socket.id] - now) / 1000);
            socket.emit('uploadError', `Attends encore ${timeLeft}s.`);
            return;
        }
        if (!API_USER || !API_SECRET) {
            socket.emit('uploadError', "Analyse d'image désactivée.");
            return;
        }
        try {
            const base64Data = imageData.replace(/^data:image\/\w+;base64,/, "");
            let imageBuffer = Buffer.from(base64Data, 'base64');
            const isGif = imageBuffer.toString('ascii', 0, 3) === 'GIF';
            if (isGif) {
                const metadata = await sharp(imageBuffer).metadata();
                const totalFrames = metadata.pages || 1;
                const randomFrameIndex = Math.floor(Math.random() * totalFrames);
                imageBuffer = await sharp(imageBuffer, { page: randomFrameIndex }).png().toBuffer();
            }
            const form = new FormData();
            form.append('media', imageBuffer, 'image.jpg');
            form.append('models', 'nudity'); 
            form.append('api_user', API_USER);
            form.append('api_secret', API_SECRET);

            const response = await axios.post(API_URL, form, { headers: form.getHeaders() });
            const result = response.data;
            
            if (result.status === 'success') {
                const isNude = result.nudity.raw > 0.5 || result.nudity.partial > 0.6;
                if (isNude) {
                    uploadCooldowns[socket.id] = now + COOLDOWN_PENALTY; 
                    currentBackground = BLOCKED_IMG;
                    io.emit('updateBackground', BLOCKED_IMG);
                    socket.emit('uploadError', "Image interdite ! Bloqué 1 min.");
                } else {
                    uploadCooldowns[socket.id] = now + COOLDOWN_NORMAL; 
                    currentBackground = imageData;
                    io.emit('updateBackground', imageData);
                    const p = players[socket.id];
                    if (p && p.pseudo !== "Invité" && !p.pseudo.startsWith("Cube")) {
                         User.updateOne({ pseudo: p.pseudo }, { $inc: { backgroundsChanged: 1 } }).exec();
                    }
                }
            }
        } catch (error) {
            console.error("Erreur changeBackground:", error.message);
            socket.emit('uploadError', "Erreur analyse image.");
        }
    });

    socket.on('changeColor', (newColor) => {
        if (players[socket.id]) {
            players[socket.id].color = newColor; 
            io.emit('updatePlayerColor', { id: socket.id, color: newColor });
            const p = players[socket.id];
            if (p && p.pseudo !== "Invité" && !p.pseudo.startsWith("Cube")) {
                User.updateOne({ pseudo: p.pseudo }, { $set: { currentSkin: newColor } }).exec();
            }
        }
    });

    socket.on('disconnect', async () => {
        await removePlayerFromGame(socket.id);
        delete uploadCooldowns[socket.id];
    });
});

// --- GESTION AFK (MODIFIÉE) ---
setInterval(() => {
    const ids = Object.keys(players);
    if (wolfId && ids.length > 1) {
        if (Date.now() - lastWolfMoveTime > 15000) { 
            console.log(`Loup AFK (${wolfId}) -> Retour Lobby.`);
            
            // 1. Prévenir le joueur qu'il est exclu vers le lobby
            io.to(wolfId).emit('forceLobby', 'afk'); 
            
            // 2. Retirer proprement le joueur du jeu (mais garder socket connecté)
            const socketDuLoup = io.sockets.sockets.get(wolfId);
            if (socketDuLoup) {
                // On appelle la fonction de nettoyage manuellement
                removePlayerFromGame(wolfId);
            }
        }
    }
}, 1000);

// --- SAUVEGARDE PÉRIODIQUE ---
const ONE_HOUR = 60 * 60 * 1000;
setInterval(async () => {
    console.log("💾 Sauvegarde auto distances...");
    for (const id in players) {
        const p = players[id];
        if (p.pendingDistance > 0 && p.pseudo !== "Invité" && !p.pseudo.startsWith("Cube")) {
            try {
                await User.updateOne({ pseudo: p.pseudo }, { $inc: { distanceTraveled: Math.round(p.pendingDistance) } });
                p.pendingDistance = 0;
            } catch (err) { console.error(`Erreur save dist ${p.pseudo}:`, err); }
        }
    }
}, ONE_HOUR);

const PORT = process.env.PORT || 2220;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`Serveur lancé sur le port ${PORT}`);
});
