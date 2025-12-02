
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

// Configuration Socket.io (Limite 5 Mo)
const io = require('socket.io')(http, {
    maxHttpBufferSize: 5 * 1024 * 1024 
});

app.use(express.static(path.join(__dirname, 'public')));

let players = {};
let currentBackground = null; 
let wolfId = null; 

// --- CONFIGURATION ---
// Clés API (Render ou .env)
const API_USER = process.env.SIGHTENGINE_USER; 
const API_SECRET = process.env.SIGHTENGINE_SECRET;
const API_URL = 'https://api.sightengine.com/1.0/check.json';

// Image de remplacement (Troll/Bloqué)
const BLOCKED_IMG = "https://i.redd.it/58qnz74nf5j41.png";

// Gestion Cooldowns
let uploadCooldowns = {}; // Stocke l'heure de fin de punition par joueur
const COOLDOWN_NORMAL = 15000; // 15 secondes
const COOLDOWN_PENALTY = 60000; // 1 minute

let lastTagTime = 0;
const TAG_COOLDOWN = 1000; 
let lastWolfMoveTime = Date.now();

io.on('connection', (socket) => {
    console.log('Nouveau joueur : ' + socket.id);

    socket.emit('currentPlayers', players);
    socket.emit('updateWolf', wolfId);
    if (currentBackground) socket.emit('updateBackground', currentBackground);

    socket.on('joinGame', () => {
        players[socket.id] = {
            x: Math.floor(Math.random() * 500) + 50,
            y: Math.floor(Math.random() * 400) + 50,
            color: '#' + Math.floor(Math.random()*16777215).toString(16)
        };
        if (!wolfId) {
            wolfId = socket.id;
            lastWolfMoveTime = Date.now();
            io.emit('updateWolf', wolfId);
        }
        socket.emit('gameJoined', { id: socket.id, info: players[socket.id] });
        socket.broadcast.emit('newPlayer', { playerId: socket.id, playerInfo: players[socket.id] });
    });

    socket.on('playerMovement', (movementData) => {
        if (players[socket.id]) {
            players[socket.id].x = movementData.x;
            players[socket.id].y = movementData.y;
            if (socket.id === wolfId) lastWolfMoveTime = Date.now();
            socket.broadcast.emit('playerMoved', { playerId: socket.id, x: players[socket.id].x, y: players[socket.id].y });
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
                }
            }
        }
    });

    // --- CHANGEMENT DE FOND (OPTIMISÉ) ---
    socket.on('changeBackground', async (imageData) => {
        const now = Date.now();

        // 1. VERIFICATION COOLDOWN (AVANT API)
        // Si le joueur est en punition ou en attente, on bloque direct.
        if (uploadCooldowns[socket.id] && now < uploadCooldowns[socket.id]) {
            const timeLeft = Math.ceil((uploadCooldowns[socket.id] - now) / 1000);
            socket.emit('uploadError', `Attends encore ${timeLeft} secondes avant d'envoyer une image.`);
            return; // ON S'ARRÊTE ICI -> 0 APPEL API
        }

        // Vérif config
        if (!API_USER || !API_SECRET) {
            socket.emit('uploadError', "Erreur config serveur (Clés manquantes).");
            return;
        }

        console.log(`Analyse demandée par ${socket.id}...`);

        try {
            const base64Data = imageData.replace(/^data:image\/\w+;base64,/, "");
            const imageBuffer = Buffer.from(base64Data, 'base64');
            const form = new FormData();
            form.append('media', imageBuffer, 'image.jpg');
            form.append('models', 'nudity'); 
            form.append('api_user', API_USER);
            form.append('api_secret', API_SECRET);

            // 2. APPEL API (Uniquement si pas de cooldown)
            const response = await axios.post(API_URL, form, { headers: form.getHeaders() });
            const result = response.data;
            
            if (result.status === 'success') {
                const isNude = result.nudity.raw > 0.5 || result.nudity.partial > 0.6;
                const isUnsafe = isNude || result.weapon > 0.5 || result.alcohol > 0.5 || result.offensive.prob > 0.5;

                if (isUnsafe) {
                    // --- CAS : IMAGE INTERDITE ---
                    console.log("⛔ Image bloquée ! Punition activée.");
                    
                    // 1. Punition : 1 minute de cooldown
                    uploadCooldowns[socket.id] = now + COOLDOWN_PENALTY;
                    
                    // 2. Image Troll
                    currentBackground = BLOCKED_IMG;
                    io.emit('updateBackground', BLOCKED_IMG);

                    // 3. Message de la honte à tout le monde
                    io.emit('serverMessage', {
                        text: "⚠️ Une tentative d'image interdite a été bloquée ! L'auteur est puni pour 1 minute.",
                        color: "red"
                    });
                    
                    // Message privé au coupable
                    socket.emit('uploadError', "Image interdite ! Tu es bloqué pour 1 minute.");

                } else {
                    // --- CAS : IMAGE VALIDE ---
                    console.log("✅ Image validée.");
                    
                    // 1. Cooldown normal : 15 secondes
                    uploadCooldowns[socket.id] = now + COOLDOWN_NORMAL;

                    currentBackground = imageData;
                    io.emit('updateBackground', imageData);
                    
                    socket.emit('serverMessage', {
                        text: "Image changée avec succès !",
                        color: "green"
                    });
                }
            } else {
                socket.emit('uploadError', "Erreur de l'API. Réessaie.");
            }
        } catch (error) {
            console.error("Erreur API:", error.message);
            socket.emit('uploadError', "Erreur technique.");
        }
    });

    socket.on('changeColor', (newColor) => {
        if (players[socket.id]) {
            players[socket.id].color = newColor; 
            io.emit('updatePlayerColor', { id: socket.id, color: newColor });
        }
    });

    socket.on('disconnect', () => {
        if (players[socket.id]) removePlayer(socket.id);
        // On peut nettoyer le cooldown pour ne pas saturer la mémoire (optionnel)
        delete uploadCooldowns[socket.id];
    });
});

function removePlayer(id) {
    delete players[id];
    io.emit('playerDisconnected', id);
    if (id === wolfId) {
        const ids = Object.keys(players);
        if (ids.length > 0) {
            wolfId = ids[Math.floor(Math.random() * ids.length)];
            lastWolfMoveTime = Date.now();
            io.emit('updateWolf', wolfId);
            lastTagTime = Date.now(); 
        } else {
            wolfId = null;
            io.emit('updateWolf', null);
        }
    }
}

setInterval(() => {
    const ids = Object.keys(players);
    if (wolfId && ids.length > 1) {
        if (Date.now() - lastWolfMoveTime > 30000) { 
            io.to(wolfId).emit('afkKicked');
            removePlayer(wolfId);
        }
    }
}, 1000);

http.listen(2220, '0.0.0.0', () => {
    console.log('Serveur lancé sur le port 2220');
});
