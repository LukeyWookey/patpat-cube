require('dotenv').config();

const express = require('express');
const app = express();
const http = require('http').createServer(app);
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp'); // Indispensable pour gérer les GIFs

// Configuration Socket.io (Limite 5 Mo pour accepter les GIFs)
const io = require('socket.io')(http, {
    maxHttpBufferSize: 5 * 1024 * 1024,
    cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

let players = {};
let currentBackground = null; 
let wolfId = null; 

// --- CONFIGURATION ---
// Récupération des clés sécurisées (depuis Render ou .env)
const API_USER = process.env.SIGHTENGINE_USER; 
const API_SECRET = process.env.SIGHTENGINE_SECRET;
const API_URL = 'https://api.sightengine.com/1.0/check.json';

// Image de punition (Troll)
const BLOCKED_IMG = "https://i.redd.it/58qnz74nf5j41.png";

// Gestion des Cooldowns (Anti-Spam & Punition)
let uploadCooldowns = {}; 
const COOLDOWN_NORMAL = 15000; // 15 secondes
const COOLDOWN_PENALTY = 60000; // 1 minute

// Variables de jeu
let lastTagTime = 0;
const TAG_COOLDOWN = 1000; 
let lastWolfMoveTime = Date.now();

io.on('connection', (socket) => {
    console.log('Nouveau visiteur : ' + socket.id);

    // Envoi de l'état actuel (Mode Spectateur)
    socket.emit('currentPlayers', players);
    socket.emit('updateWolf', wolfId);
    if (currentBackground) socket.emit('updateBackground', currentBackground);

    // --- REJOINDRE LA PARTIE ---
    socket.on('joinGame', () => {
        players[socket.id] = {
            x: Math.floor(Math.random() * 500) + 50,
            y: Math.floor(Math.random() * 400) + 50,
            color: '#' + Math.floor(Math.random()*16777215).toString(16)
        };
        
        // Si aucun loup, le nouveau devient loup
        if (!wolfId) {
            wolfId = socket.id;
            lastWolfMoveTime = Date.now();
            io.emit('updateWolf', wolfId);
        }

        socket.emit('gameJoined', { id: socket.id, info: players[socket.id] });
        socket.broadcast.emit('newPlayer', { playerId: socket.id, playerInfo: players[socket.id] });
    });

    // --- MOUVEMENTS ---
    socket.on('playerMovement', (movementData) => {
        if (players[socket.id]) {
            players[socket.id].x = movementData.x;
            players[socket.id].y = movementData.y;

            // Anti-AFK : Si le loup bouge, on reset son chrono
            if (socket.id === wolfId) {
                lastWolfMoveTime = Date.now();
            }

            socket.broadcast.emit('playerMoved', { 
                playerId: socket.id, 
                x: players[socket.id].x, 
                y: players[socket.id].y 
            });
        }
    });

    // --- TAG (TOUCHÉ) ---
    socket.on('tagPlayer', (targetId) => {
        if (socket.id === wolfId && players[targetId]) {
            const now = Date.now();
            const wolf = players[socket.id];
            const target = players[targetId];
            
            const dx = Math.abs(wolf.x - target.x);
            const dy = Math.abs(wolf.y - target.y);

            if (dx < 90 && dy < 90) { // Tolérance de collision
                if (now - lastTagTime > TAG_COOLDOWN) {
                    wolfId = targetId;
                    lastTagTime = now;
                    lastWolfMoveTime = Date.now(); // Reset pour le nouveau loup
                    
                    io.emit('updateWolf', wolfId);
                    io.emit('playerTagged', { 
                        x: target.x + 25, 
                        y: target.y + 25, 
                        color: target.color 
                    });
                }
            }
        }
    });

    // --- CHANGEMENT DE FOND (OPTIMISÉ & SÉCURISÉ) ---
    socket.on('changeBackground', async (imageData) => {
        const now = Date.now();

        // 1. Vérification Cooldown
        if (uploadCooldowns[socket.id] && now < uploadCooldowns[socket.id]) {
            const timeLeft = Math.ceil((uploadCooldowns[socket.id] - now) / 1000);
            socket.emit('uploadError', `Tu es en pause. Attends ${timeLeft} secondes.`);
            return;
        }

        // Vérification Config Serveur
        if (!API_USER || !API_SECRET) {
            socket.emit('uploadError', "Erreur serveur : API non configurée.");
            return;
        }

        console.log(`Analyse image demandée par ${socket.id}...`);

        try {
            // Conversion Base64 -> Buffer
            const base64Data = imageData.replace(/^data:image\/\w+;base64,/, "");
            let imageBuffer = Buffer.from(base64Data, 'base64');

            // --- ASTUCE "ROULETTE RUSSE" POUR GIF ---
            // On vérifie les "Magic Bytes" pour voir si c'est un GIF
            const isGif = imageBuffer.toString('ascii', 0, 3) === 'GIF';
            
            if (isGif) {
                // On charge les métadonnées pour savoir combien il y a de frames
                const metadata = await sharp(imageBuffer).metadata();
                const totalFrames = metadata.pages || 1;
                
                // On choisit une frame au HASARD
                const randomFrameIndex = Math.floor(Math.random() * totalFrames);
                console.log(`GIF détecté (${totalFrames} frames). Test de la frame n°${randomFrameIndex}.`);

                // On extrait juste cette frame en PNG (Coût = 1 opération)
                imageBuffer = await sharp(imageBuffer, { page: randomFrameIndex })
                    .png()
                    .toBuffer();
            }

            // Préparation Envoi API
            const form = new FormData();
            form.append('media', imageBuffer, 'image.jpg');
            form.append('models', 'nudity'); // Modèle unique (Le moins cher)
            form.append('api_user', API_USER);
            form.append('api_secret', API_SECRET);

            // Appel API
            const response = await axios.post(API_URL, form, { headers: form.getHeaders() });
            const result = response.data;
            
            if (result.status === 'success') {
                // Seuil de détection
                const isNude = result.nudity.raw > 0.5 || result.nudity.partial > 0.6;
                
                if (isNude) {
                    // --- BLOQUÉ ---
                    console.log("⛔ Image bloquée !");
                    
                    // Punition : 1 minute
                    uploadCooldowns[socket.id] = now + COOLDOWN_PENALTY;
                    
                    // On met l'image Troll
                    currentBackground = BLOCKED_IMG;
                    io.emit('updateBackground', BLOCKED_IMG);

                    // Message public
                    io.emit('serverMessage', {
                        text: "⚠️ Image interdite bloquée ! L'auteur est puni 1 minute.",
                        color: "red"
                    });
                    
                    socket.emit('uploadError', "Image refusée ! Tu es bloqué pour 1 minute.");

                } else {
                    // --- VALIDÉ ---
                    console.log("✅ Image validée.");
                    
                    // Cooldown normal : 15 secondes
                    uploadCooldowns[socket.id] = now + COOLDOWN_NORMAL;

                    // On envoie l'image originale (le GIF animé complet)
                    currentBackground = imageData;
                    io.emit('updateBackground', imageData);
                    
                    socket.emit('serverMessage', {
                        text: "Nouveau fond validé !",
                        color: "green"
                    });
                }
            } else {
                console.error("Erreur API SightEngine:", result);
                socket.emit('uploadError', "Erreur de vérification. Réessaie.");
            }
        } catch (error) {
            console.error("Erreur Technique:", error.message);
            socket.emit('uploadError', "Fichier invalide ou erreur technique.");
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
        delete uploadCooldowns[socket.id]; // Nettoyage mémoire
    });
});

function removePlayer(id) {
    delete players[id];
    io.emit('playerDisconnected', id);
    
    // Si c'était le loup, on en choisit un autre
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

// --- BOUCLE ANTI-AFK (1 Seconde) ---
setInterval(() => {
    const ids = Object.keys(players);
    if (wolfId && ids.length > 1) {
        // 30 secondes sans mouvement = Kick
        if (Date.now() - lastWolfMoveTime > 15000) { 
            console.log(`Loup AFK (${wolfId}) -> Kick`);
            io.to(wolfId).emit('afkKicked');
            removePlayer(wolfId);
        }
    }
}, 1000);

const PORT = process.env.PORT || 2220;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`Serveur lancé sur le port ${PORT}`);
});